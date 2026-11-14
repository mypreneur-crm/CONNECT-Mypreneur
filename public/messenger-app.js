/**
 * ============================================================================
 * MYPRENEUR CONNECT - REAL-TIME MESSENGER & COLLABORATION APP
 * ============================================================================
 * Features:
 *  - Real Live Presence Engine (ONLINE, AWAY, OFFLINE) with idle auto-detection
 *  - Facebook / Google Messenger style UI: Docked launcher, popup messenger panel,
 *    and multi-window floating chat boxes
 *  - Individual 1-on-1 Chat and Named Group Chats
 *  - Rich message formatting, emoji picker, file/document sharing, and image previews
 *  - Drag & Drop file attachment support
 *  - Web Audio API sound notifications (two-tone message chime & telephone ring)
 *  - Browser desktop notifications & tab title blinking
 *  - Offline login catch-up modal listing unread messages
 *  - Integrated WebRTC 1-on-1 Audio and Video Calling with in-portal controls
 * ============================================================================
 */

(function (window) {
  'use strict';

  // State Management
  const state = {
    initialized: false,
    currentUser: null, // session user
    presenceMap: {},   // employee_id -> { status, custom_status, last_heartbeat }
    currentStatus: 'ONLINE',
    customStatus: '',
    idleTimer: null,
    isIdle: false,

    // Messenger UI
    messengerOpen: false,
    activeTab: 'chats', // 'chats' | 'groups' | 'directory'
    searchQuery: '',
    conversations: [],
    employees: [],

    // Active Floating Chat Windows (keyed by convId)
    openChats: {}, // convId -> { conv, minimized: bool, messages: [], lastMessageId, input: '' }

    // Timers & intervals
    presenceInterval: null,
    callCheckInterval: null,
    unreadCheckInterval: null,

    // WebRTC Calling State
    activeCall: null, // { callId, peerId, peerName, type, isCaller, pc, localStream, remoteStream, status, timer, timerInterval }
    incomingCall: null, // { callId, callerName, callerId, type, sdpOffer }
    ringtoneOsc: null,

    // Title Blinking
    titleBlinkTimer: null,
    originalTitle: document.title || 'CONNECT - Mypreneur',
    isTabActive: !document.hidden
  };

  /* ==========================================================================
     UNIFIED API CLIENT HELPER (CSRF & SESSION SAFE)
     ========================================================================== */

  async function apiCall(endpoint, options = {}) {
    if (typeof window.apiRequest === 'function') {
      try {
        return await window.apiRequest(endpoint, options);
      } catch (err) {
        // Fall back to fetch if window.apiRequest had an issue
      }
    }
    const method = String(options.method || 'GET').toUpperCase();
    const token = window.csrfToken || (typeof csrfToken !== 'undefined' ? csrfToken : '') || '';
    const headers = Object.assign({
      'Accept': 'application/json'
    }, options.headers || {});
    let body = options.body;
    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      if (typeof body !== 'string') body = JSON.stringify(body);
    }
    if (!['GET', 'HEAD'].includes(method) && token) {
      headers['X-CSRF-Token'] = token;
    }
    const res = await fetch(endpoint, {
      method,
      headers,
      body,
      credentials: 'same-origin'
    });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => ({})) : {};
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  /* ==========================================================================
     AUDIO SYNTHESIS (WEB AUDIO API - ZERO EXTERNAL ASSETS NEEDED)
     ========================================================================== */

  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioCtx = new AudioCtx();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => { });
    }
    return audioCtx;
  }

  // Pleasant two-tone chime for incoming messages (E5 -> A5)
  function playMessageChime() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      // Note 1: 659.25 Hz (E5)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(659.25, now);
      gain1.gain.setValueAtTime(0.001, now);
      gain1.gain.exponentialRampToValueAtTime(0.25, now + 0.04);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.24);

      // Note 2: 880.00 Hz (A5)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.12);
      gain2.gain.setValueAtTime(0.001, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.3, now + 0.16);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.48);
    } catch (e) {
      console.warn('Audio chime error:', e);
    }
  }

  // Telephone Ringtone Generator (Looping dual-tone 440Hz + 480Hz)
  let ringtoneLoopTimer = null;
  function startRingtone() {
    stopRingtone();
    function playSingleRing() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.frequency.value = 440;
        osc2.frequency.value = 480;
        osc1.type = 'sine';
        osc2.type = 'sine';

        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.08);
        gain.gain.setValueAtTime(0.2, now + 1.2);
        gain.gain.linearRampToValueAtTime(0.01, now + 1.3);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 1.35);
        osc2.stop(now + 1.35);
      } catch (e) { }
    }

    playSingleRing();
    ringtoneLoopTimer = setInterval(playSingleRing, 3500);
  }

  function stopRingtone() {
    if (ringtoneLoopTimer) {
      clearInterval(ringtoneLoopTimer);
      ringtoneLoopTimer = null;
    }
  }

  /* ==========================================================================
     NOTIFICATIONS & TITLE BLINKING
     ========================================================================== */

  document.addEventListener('visibilitychange', () => {
    state.isTabActive = !document.hidden;
    if (state.isTabActive) {
      stopTitleBlink();
    }
  });

  window.addEventListener('focus', () => {
    state.isTabActive = true;
    stopTitleBlink();
  });

  function startTitleBlink(senderName) {
    if (state.isTabActive) return;
    stopTitleBlink();
    let toggle = false;
    const msg = `🔔 New message from ${senderName}!`;
    state.titleBlinkTimer = setInterval(() => {
      document.title = toggle ? msg : state.originalTitle;
      toggle = !toggle;
    }, 1000);
  }

  function stopTitleBlink() {
    if (state.titleBlinkTimer) {
      clearInterval(state.titleBlinkTimer);
      state.titleBlinkTimer = null;
    }
    document.title = state.originalTitle;
  }

  function triggerDesktopNotification(senderName, text, convId) {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try {
        const notif = new Notification(senderName, {
          body: text || 'Sent you an attachment',
          icon: '/favicon.ico',
          tag: `chat-${convId}`
        });
        notif.onclick = () => {
          window.focus();
          openFloatingChat(convId);
          notif.close();
        };
      } catch (e) { }
    }
  }

  /* ==========================================================================
     PRESENCE ENGINE & IDLE MONITOR
     ========================================================================== */

  function setupIdleMonitor() {
    const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

    function resetIdle() {
      if (state.isIdle) {
        state.isIdle = false;
        state.currentStatus = 'ONLINE';
        sendHeartbeat('ONLINE');
        updateMessengerHeaderPresence();
      }
      clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        state.isIdle = true;
        state.currentStatus = 'AWAY';
        sendHeartbeat('AWAY');
        updateMessengerHeaderPresence();
      }, IDLE_TIMEOUT_MS);
    }

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
      window.addEventListener(evt, resetIdle, { passive: true });
    });

    window.addEventListener('beforeunload', () => {
      if (navigator.sendBeacon) {
        try {
          const blob = new Blob([JSON.stringify({ status: 'OFFLINE' })], { type: 'application/json' });
          navigator.sendBeacon('/api/chat/presence/heartbeat', blob);
        } catch (e) {
          navigator.sendBeacon('/api/chat/presence/heartbeat', JSON.stringify({ status: 'OFFLINE' }));
        }
      }
    });

    resetIdle();
  }

  async function sendHeartbeat(forcedStatus) {
    if (!state.currentUser) return;
    const status = forcedStatus || state.currentStatus;
    try {
      await fetch('/api/chat/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          custom_status: state.customStatus
        })
      });
    } catch (e) { }
  }

  async function fetchAllPresence() {
    try {
      const res = await fetch('/api/chat/presence/all');
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && data.presence) {
        state.presenceMap = data.presence;
        syncPresenceToDOM();
      }
    } catch (e) { }
  }

  // Update online dots across entire page & Employee Contacts directory
  function syncPresenceToDOM() {
    // 1. Update contact cards and table rows if present
    document.querySelectorAll('.contact-card, tr[data-emp-id]').forEach(el => {
      const empId = el.dataset.empId || el.querySelector('[onclick*="openContactChatModal"]')?.getAttribute('onclick')?.match(/\d+/)?.[0];
      if (!empId) return;
      const p = state.presenceMap[empId];
      const status = (p && p.status) ? p.status.toLowerCase() : 'offline';
      const customStatus = (p && p.custom_status) ? p.custom_status : '';

      const dot = el.querySelector('.contact-status-dot');
      if (dot && !dot.classList.contains('on_leave')) {
        dot.className = `contact-status-dot ${status}`;
        dot.title = `${capitalize(status)}${customStatus ? ': ' + customStatus : ''}`;
      }

      const badge = el.querySelector('.presence-badge');
      if (badge && !badge.classList.contains('on_leave')) {
        badge.className = `presence-badge ${status}`;
        badge.textContent = `● ${capitalize(status)}`;
      }
    });

    // 2. Update Contacts stats ribbon if on contacts page
    const totalEl = document.getElementById('cntStatTotal');
    const onlineEl = document.getElementById('cntStatOnline');
    const awayEl = document.getElementById('cntStatAway');
    if (onlineEl && awayEl) {
      let onlineCount = 0;
      let awayCount = 0;
      Object.values(state.presenceMap).forEach(p => {
        if (p.status === 'ONLINE') onlineCount++;
        else if (p.status === 'AWAY') awayCount++;
      });
      onlineEl.textContent = onlineCount;
      awayEl.textContent = awayCount;
    }

    // 3. Update messenger conversation & contact list presence dots
    document.querySelectorAll('.msg-presence-dot[data-emp-id]').forEach(dot => {
      const id = dot.dataset.empId;
      const p = state.presenceMap[id];
      const status = (p && p.status) ? p.status.toLowerCase() : 'offline';
      dot.className = `msg-presence-dot ${status}`;
    });
  }

  /* ==========================================================================
     OFFLINE CATCHUP NOTIFICATION
     ========================================================================== */

  async function checkOfflineCatchup() {
    if (!state.currentUser) return;
    try {
      const res = await fetch('/api/chat/unread-summary');
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && data.total_unread > 0) {
        showCatchupModal(data);
      }
    } catch (e) { }
  }

  function showCatchupModal(data) {
    // Avoid double showing
    if (document.getElementById('msgCatchupModal')) return;

    const modal = document.createElement('div');
    modal.id = 'msgCatchupModal';
    modal.className = 'msg-modal-overlay';
    modal.innerHTML = `
      <div class="msg-modal-box" style="max-width:480px;animation:msgPopIn 0.25s cubic-bezier(0.16,1,0.3,1);">
        <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #E2E8F0;padding:16px 20px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:36px;height:36px;border-radius:10px;background:#E0F2FE;color:#0284C7;display:flex;align-items:center;justify-content:center;font-size:20px;">
              💬
            </div>
            <div>
              <h3 style="margin:0;font-size:16px;font-weight:700;color:#0F172A;">Unread Messages Catchup</h3>
              <p style="margin:0;font-size:12px;color:#64748B;">Welcome back! You received messages while away</p>
            </div>
          </div>
          <button onclick="document.getElementById('msgCatchupModal').remove()" style="background:none;border:none;font-size:22px;color:#94A3B8;cursor:pointer;line-height:1;">&times;</button>
        </div>

        <div style="padding:16px 20px;max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;">
          <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:10px 14px;font-size:13px;color:#166534;display:flex;align-items:center;gap:8px;">
            <span>🔔</span>
            <span>You have <strong>${data.total_unread} unread message${data.total_unread > 1 ? 's' : ''}</strong> from teammates.</span>
          </div>

          ${data.unread_conversations.map(c => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;gap:12px;">
              <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
                <div style="width:36px;height:36px;border-radius:8px;background:${getAvatarColor(c.title)};color:#FFF;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">
                  ${getInitials(c.title)}
                </div>
                <div style="min-width:0;flex:1;">
                  <div style="display:flex;align-items:center;gap:6px;">
                    <strong style="font-size:13.5px;color:#0F172A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(c.title)}</strong>
                    <span style="background:#EF4444;color:#FFF;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;">${c.unread_count}</span>
                  </div>
                  <p style="margin:2px 0 0;font-size:12px;color:#64748B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(c.last_snippet || 'New message')}</p>
                </div>
              </div>
              <button onclick="window.MessengerApp.openFloatingChat('${c.conversation_id}'); document.getElementById('msgCatchupModal').remove();" class="msg-btn msg-btn-primary" style="padding:6px 12px;font-size:12px;flex-shrink:0;">
                Open Chat
              </button>
            </div>
          `).join('')}
        </div>

        <div style="padding:12px 20px;border-top:1px solid #E2E8F0;display:flex;justify-content:flex-end;gap:10px;background:#FAFAFA;border-radius:0 0 16px 16px;">
          <button onclick="document.getElementById('msgCatchupModal').remove()" class="msg-btn msg-btn-ghost" style="padding:8px 16px;font-size:13px;">
            Dismiss
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  /* ==========================================================================
     MESSENGER MAIN UI & FLOATING BAR
     ========================================================================== */

  function renderMessengerStyles() {
    if (document.getElementById('msgStyles')) return;
    const style = document.createElement('style');
    style.id = 'msgStyles';
    style.textContent = `
      /* Messenger Floating Launcher */
      .msg-launcher-btn {
        position: fixed;
        bottom: 22px;
        right: 24px;
        width: 58px;
        height: 58px;
        border-radius: 50%;
        background: linear-gradient(135deg, #0284C7, #0EA5E9);
        color: #FFF;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 10px 25px -5px rgba(2, 132, 199, 0.4), 0 8px 10px -6px rgba(2, 132, 199, 0.2);
        cursor: pointer;
        z-index: 99990;
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
        border: none;
      }
      .msg-launcher-btn:hover {
        transform: scale(1.08) translateY(-2px);
        box-shadow: 0 14px 28px -5px rgba(2, 132, 199, 0.5);
      }
      .msg-launcher-badge {
        position: absolute;
        top: -3px;
        right: -3px;
        background: #EF4444;
        color: #FFF;
        font-size: 11px;
        font-weight: 800;
        min-width: 20px;
        height: 20px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 4px;
        border: 2px solid #FFF;
        animation: msgPulse 2s infinite;
      }
      @keyframes msgPulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.12); }
      }

      /* Messenger Main Window */
      .msg-panel-window {
        position: fixed;
        bottom: 90px;
        right: 24px;
        width: 380px;
        height: 560px;
        max-height: calc(100vh - 110px);
        background: #FFFFFF;
        border-radius: 20px;
        box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.06);
        display: flex;
        flex-direction: column;
        z-index: 99991;
        overflow: hidden;
        animation: msgPopIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes msgPopIn {
        from { opacity: 0; transform: translateY(16px) scale(0.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      /* Floating Chat Windows Dock */
      .msg-chats-dock {
        position: fixed;
        bottom: 0;
        right: 96px;
        display: flex;
        align-items: flex-end;
        gap: 14px;
        z-index: 100050 !important;
        pointer-events: none;
        transition: right 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .msg-chats-dock.panel-open {
        right: 420px !important;
      }
      .msg-chat-box {
        position: relative;
        z-index: 100060 !important;
        width: 340px;
        height: 440px;
        background: #FFFFFF;
        border-radius: 14px 14px 0 0;
        box-shadow: 0 -4px 25px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.08);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        pointer-events: auto;
        animation: msgSlideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        transition: height 0.2s ease;
      }
      .msg-chat-box.minimized {
        height: 48px;
      }
      @keyframes msgSlideUp {
        from { opacity: 0; transform: translateY(40px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @media (max-width: 768px) {
        .msg-panel-window {
          right: 12px;
          bottom: 80px;
          width: calc(100vw - 24px);
        }
        .msg-chats-dock {
          right: 12px !important;
          left: 12px !important;
        }
        .msg-chats-dock.panel-open {
          right: 12px !important;
        }
        .msg-chat-box {
          width: 100%;
        }
      }

      /* Buttons & Pills */
      .msg-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        transition: background 0.15s;
      }
      .msg-btn-primary {
        background: #0284C7;
        color: #FFF;
      }
      .msg-btn-primary:hover {
        background: #0369A1;
      }
      .msg-btn-ghost {
        background: transparent;
        color: #475569;
      }
      .msg-btn-ghost:hover {
        background: #F1F5F9;
        color: #0F172A;
      }

      /* Presence Dots */
      .msg-presence-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 2px solid #FFF;
        display: inline-block;
      }
      .msg-presence-dot.online { background: #10B981; }
      .msg-presence-dot.away { background: #F59E0B; }
      .msg-presence-dot.offline { background: #94A3B8; }

      /* Message Bubbles */
      .msg-bubble-wrap {
        display: flex;
        flex-direction: column;
        margin-bottom: 8px;
      }
      .msg-bubble-wrap.mine {
        align-items: flex-end;
      }
      .msg-bubble-wrap.theirs {
        align-items: flex-start;
      }
      .msg-bubble {
        max-width: 82%;
        padding: 9px 13px;
        border-radius: 16px;
        font-size: 13.5px;
        line-height: 1.4;
        word-break: break-word;
        box-shadow: 0 1px 2px rgba(0,0,0,0.04);
      }
      .msg-bubble-wrap.mine .msg-bubble {
        background: linear-gradient(135deg, #0284C7, #0EA5E9);
        color: #FFF;
        border-bottom-right-radius: 4px;
      }
      .msg-bubble-wrap.theirs .msg-bubble {
        background: #F1F5F9;
        color: #0F172A;
        border-bottom-left-radius: 4px;
      }
      .msg-stamp {
        font-size: 10.5px;
        color: #94A3B8;
        margin-top: 3px;
        padding: 0 4px;
      }

      /* Call Overlay Modal */
      .msg-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.75);
        backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100100;
      }
      .msg-modal-box {
        background: #FFF;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 25px 50px -12px rgba(0,0,0,0.35);
        width: 100%;
      }
    `;
    document.head.appendChild(style);
  }

  function mountMessengerBar() {
    renderMessengerStyles();

    // Check if bar already mounted
    if (document.getElementById('msgLauncherWrap')) return;

    const wrap = document.createElement('div');
    wrap.id = 'msgLauncherWrap';
    wrap.innerHTML = `
      <!-- Launcher Button -->
      <button class="msg-launcher-btn" id="msgLauncherBtn" title="Mypreneur Messenger">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="msg-launcher-badge" id="msgTotalBadge" style="display:none;">0</span>
      </button>

      <!-- Main Messenger Panel Window -->
      <div class="msg-panel-window" id="msgPanelWindow" style="display:none;">
        <!-- Header -->
        <div style="padding:14px 18px;background:#FFF;border-bottom:1px solid #E2E8F0;display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="position:relative;">
              <div style="width:38px;height:38px;border-radius:12px;background:${getAvatarColor(state.currentUser?.name)};color:#FFF;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:14px;">
                ${getInitials(state.currentUser?.name)}
              </div>
              <span class="msg-presence-dot online" id="msgMyPresenceDot" style="position:absolute;bottom:-2px;right:-2px;width:12px;height:12px;"></span>
            </div>
            <div>
              <h3 style="margin:0;font-size:16px;font-weight:800;color:#0F172A;">Messenger</h3>
              <select id="msgMyStatusSelect" onchange="window.MessengerApp.changeMyStatus(this.value)" style="border:none;background:transparent;font-size:11.5px;color:#64748B;padding:0;cursor:pointer;font-weight:600;outline:none;">
                <option value="ONLINE">🟢 Active</option>
                <option value="AWAY">🟡 Away</option>
              </select>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <button onclick="window.MessengerApp.openNewGroupModal()" class="msg-btn msg-btn-ghost" title="Create Group" style="width:34px;height:34px;border-radius:8px;padding:0;font-size:16px;">
              ➕
            </button>
            <button onclick="window.MessengerApp.toggleMessenger(false)" class="msg-btn msg-btn-ghost" title="Close" style="width:34px;height:34px;border-radius:8px;padding:0;font-size:20px;line-height:1;">
              &times;
            </button>
          </div>
        </div>

        <!-- Search Bar -->
        <div style="padding:10px 14px;background:#F8FAFC;border-bottom:1px solid #E2E8F0;">
          <div style="position:relative;">
            <input type="text" id="msgSearchInput" placeholder="Search chats or teammates..." oninput="window.MessengerApp.handleSearch(this.value)" style="width:100%;padding:7px 12px 7px 32px;background:#FFF;border:1px solid #E2E8F0;border-radius:8px;font-size:13px;outline:none;box-sizing:border-box;">
            <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#94A3B8;font-size:14px;">🔍</span>
          </div>
        </div>

        <!-- Tab Bar -->
        <div style="display:flex;border-bottom:1px solid #E2E8F0;background:#FFF;">
          <button class="msg-btn msg-btn-ghost" id="msgTabBtnChats" onclick="window.MessengerApp.switchTab('chats')" style="flex:1;padding:10px 0;border-radius:0;border-bottom:2px solid #0284C7;color:#0284C7;font-weight:700;font-size:13px;">
            💬 Chats
          </button>
          <button class="msg-btn msg-btn-ghost" id="msgTabBtnGroups" onclick="window.MessengerApp.switchTab('groups')" style="flex:1;padding:10px 0;border-radius:0;border-bottom:2px solid transparent;font-weight:600;font-size:13px;">
            👥 Groups
          </button>
          <button class="msg-btn msg-btn-ghost" id="msgTabBtnDirectory" onclick="window.MessengerApp.switchTab('directory')" style="flex:1;padding:10px 0;border-radius:0;border-bottom:2px solid transparent;font-weight:600;font-size:13px;">
            📇 People
          </button>
        </div>

        <!-- Tab Content List -->
        <div id="msgTabContent" style="flex:1;overflow-y:auto;padding:8px 0;background:#FFF;">
          <div style="text-align:center;padding:30px;color:#94A3B8;font-size:13px;">Loading conversations...</div>
        </div>
      </div>

      <!-- Dock for open floating chat boxes -->
      <div class="msg-chats-dock" id="msgChatsDock"></div>

      <!-- Modals Anchor (Group modal, Calling window, Lightbox) -->
      <div id="msgModalsAnchor"></div>
    `;

    document.body.appendChild(wrap);

    document.getElementById('msgLauncherBtn').onclick = () => {
      toggleMessenger();
    };
  }

  function toggleMessenger(open) {
    state.messengerOpen = typeof open === 'boolean' ? open : !state.messengerOpen;
    const panel = document.getElementById('msgPanelWindow');
    const dock = document.getElementById('msgChatsDock');
    if (panel) {
      panel.style.display = state.messengerOpen ? 'flex' : 'none';
      if (state.messengerOpen) {
        loadConversations();
      }
    }
    if (dock) {
      if (state.messengerOpen) {
        dock.classList.add('panel-open');
        dock.style.right = '420px';
      } else {
        dock.classList.remove('panel-open');
        dock.style.right = '96px';
      }
    }
  }

  function switchTab(tab) {
    state.activeTab = tab;
    ['Chats', 'Groups', 'Directory'].forEach(t => {
      const btn = document.getElementById(`msgTabBtn${t}`);
      if (btn) {
        const isCur = t.toLowerCase() === tab;
        btn.style.borderBottomColor = isCur ? '#0284C7' : 'transparent';
        btn.style.color = isCur ? '#0284C7' : '#64748B';
        btn.style.fontWeight = isCur ? '700' : '600';
      }
    });
    renderTabContent();
  }

  function handleSearch(q) {
    state.searchQuery = q.trim().toLowerCase();
    renderTabContent();
  }

  function changeMyStatus(newStatus) {
    state.currentStatus = newStatus;
    sendHeartbeat(newStatus);
    updateMessengerHeaderPresence();
  }

  function updateMessengerHeaderPresence() {
    const dot = document.getElementById('msgMyPresenceDot');
    const select = document.getElementById('msgMyStatusSelect');
    if (dot) dot.className = `msg-presence-dot ${state.currentStatus.toLowerCase()}`;
    if (select) select.value = state.currentStatus;
  }

  /* ==========================================================================
     CONVERSATIONS & DIRECTORY RENDERING
     ========================================================================== */

  async function loadConversations() {
    try {
      const res = await fetch('/api/chat/conversations');
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        state.conversations = data.conversations || [];
        updateTotalUnreadBadge();
        renderTabContent();
      }
    } catch (e) { }
  }

  async function loadEmployees() {
    try {
      const res = await fetch('/api/contacts');
      if (!res.ok) return;
      const data = await res.json();
      if (data.contacts) {
        state.employees = data.contacts;
      }
    } catch (e) { }
  }

  function updateTotalUnreadBadge() {
    let total = 0;
    state.conversations.forEach(c => { total += (c.unread_count || 0); });
    const badge = document.getElementById('msgTotalBadge');
    if (badge) {
      if (total > 0) {
        badge.textContent = total > 99 ? '99+' : total;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  function renderTabContent() {
    const container = document.getElementById('msgTabContent');
    if (!container) return;

    if (state.activeTab === 'chats') {
      renderChatsTab(container);
    } else if (state.activeTab === 'groups') {
      renderGroupsTab(container);
    } else if (state.activeTab === 'directory') {
      renderDirectoryTab(container);
    }
  }

  function renderChatsTab(container) {
    let list = state.conversations;
    if (state.searchQuery) {
      list = list.filter(c => c.title.toLowerCase().includes(state.searchQuery) || (c.last_message && c.last_message.toLowerCase().includes(state.searchQuery)));
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px 20px;color:#94A3B8;">
          <div style="font-size:32px;margin-bottom:8px;">💬</div>
          <strong style="color:#0F172A;font-size:14px;">No conversations yet</strong>
          <p style="font-size:12px;margin:4px 0 12px;">Start a chat with a teammate from the People tab!</p>
          <button onclick="window.MessengerApp.switchTab('directory')" class="msg-btn msg-btn-primary" style="padding:6px 14px;font-size:12px;">
            Find Teammates
          </button>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(c => {
      const isGroup = c.type === 'GROUP';
      const presence = c.target_employee ? (state.presenceMap[c.target_employee.employee_id]?.status || c.status || 'OFFLINE') : 'OFFLINE';
      const timeStr = formatShortTime(c.last_message_at);

      return `
        <div onclick="window.MessengerApp.openFloatingChat('${c.id}')" style="display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;transition:background 0.15s;border-bottom:1px solid #F1F5F9;" onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background=''">
          <div style="position:relative;flex-shrink:0;">
            <div style="width:42px;height:42px;border-radius:12px;background:${getAvatarColor(c.title)};color:#FFF;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:14px;">
              ${isGroup ? '👥' : getInitials(c.title)}
            </div>
            ${!isGroup ? `<span class="msg-presence-dot ${presence.toLowerCase()}" data-emp-id="${c.target_employee?.employee_id || ''}" style="position:absolute;bottom:-2px;right:-2px;"></span>` : ''}
          </div>

          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
              <strong style="font-size:13.5px;color:#0F172A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(c.title)}</strong>
              <span style="font-size:11px;color:#94A3B8;flex-shrink:0;">${timeStr}</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:2px;">
              <span style="font-size:12px;color:${c.unread_count > 0 ? '#0F172A' : '#64748B'};font-weight:${c.unread_count > 0 ? '700' : '400'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                ${escHtml(c.last_message || (isGroup ? 'Group created' : 'Start conversation'))}
              </span>
              ${c.unread_count > 0 ? `
                <span style="background:#EF4444;color:#FFF;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;flex-shrink:0;">
                  ${c.unread_count}
                </span>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderGroupsTab(container) {
    const groups = state.conversations.filter(c => c.type === 'GROUP');
    let list = groups;
    if (state.searchQuery) {
      list = list.filter(g => g.title.toLowerCase().includes(state.searchQuery));
    }

    container.innerHTML = `
      <div style="padding:10px 16px;border-bottom:1px solid #F1F5F9;">
        <button onclick="window.MessengerApp.openNewGroupModal()" class="msg-btn msg-btn-primary" style="width:100%;padding:8px;font-size:13px;">
          ➕ Create New Group Chat
        </button>
      </div>

      ${list.length === 0 ? `
        <div style="text-align:center;padding:30px 20px;color:#94A3B8;font-size:13px;">
          No group chats found.
        </div>
      ` : list.map(g => `
        <div onclick="window.MessengerApp.openFloatingChat('${g.id}')" style="display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;transition:background 0.15s;border-bottom:1px solid #F1F5F9;" onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background=''">
          <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg, #8B5CF6, #6D28D9);color:#FFF;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
            👥
          </div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <strong style="font-size:13.5px;color:#0F172A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(g.title)}</strong>
              <span style="font-size:11px;color:#94A3B8;">${g.members ? `${g.members.length} members` : ''}</span>
            </div>
            <p style="margin:2px 0 0;font-size:12px;color:#64748B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${escHtml(g.last_message || 'Active Group Channel')}
            </p>
          </div>
        </div>
      `).join('')}
    `;
  }

  function renderDirectoryTab(container) {
    let list = state.employees;
    const myEmpId = state.currentUser?.employeeId || state.currentUser?.id;
    list = list.filter(e => {
      if (Number(e.id) === Number(myEmpId)) return false;
      if (Number(e.id) === 1) return false;
      const nm = (e.name || '').toLowerCase();
      if (nm === 'super admin' || nm.includes('super admin')) return false;
      return true;
    });

    if (state.searchQuery) {
      list = list.filter(e =>
        e.name.toLowerCase().includes(state.searchQuery) ||
        (e.department && e.department.toLowerCase().includes(state.searchQuery)) ||
        (e.designation && e.designation.toLowerCase().includes(state.searchQuery))
      );
    }

    if (list.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:30px;color:#94A3B8;font-size:13px;">No teammates found.</div>`;
      return;
    }

    container.innerHTML = list.map(emp => {
      const p = state.presenceMap[emp.id] || { status: emp.status || 'OFFLINE' };
      const statusClass = (p.status || 'OFFLINE').toLowerCase();

      return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #F1F5F9;gap:10px;">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
            <div style="position:relative;flex-shrink:0;">
              <div style="width:38px;height:38px;border-radius:10px;background:${getAvatarColor(emp.name)};color:#FFF;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px;">
                ${getInitials(emp.name)}
              </div>
              <span class="msg-presence-dot ${statusClass}" data-emp-id="${emp.id}" style="position:absolute;bottom:-2px;right:-2px;"></span>
            </div>
            <div style="min-width:0;flex:1;">
              <div style="display:flex;align-items:center;gap:6px;">
                <strong style="font-size:13px;color:#0F172A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(emp.name)}</strong>
              </div>
              <div style="font-size:11.5px;color:#64748B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                ${escHtml(emp.department || '')} · ${escHtml(emp.designation || '')}
              </div>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
            <button onclick="window.MessengerApp.startDirectChatWithEmployee(${emp.id})" class="msg-btn msg-btn-primary" title="Chat" style="padding:6px 10px;font-size:12px;">
              💬
            </button>
            <button onclick="window.MessengerApp.startCallWithEmployee(${emp.id}, 'AUDIO')" class="msg-btn msg-btn-ghost" title="Audio Call" style="padding:6px 8px;font-size:13px;">
              📞
            </button>
            <button onclick="window.MessengerApp.startCallWithEmployee(${emp.id}, 'VIDEO')" class="msg-btn msg-btn-ghost" title="Video Call" style="padding:6px 8px;font-size:13px;">
              📹
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  /* ==========================================================================
     FLOATING DOCKED CHAT WINDOWS (FACEBOOK MESSENGER STYLE)
     ========================================================================== */

  async function openFloatingChat(convId) {
    toggleMessenger(false);
    const panel = document.getElementById('msgPanelWindow');
    if (panel) panel.style.display = 'none';
    state.messengerOpen = false;

    if (!state.currentUser) {
      const u = window.session || (typeof session !== 'undefined' ? session : null);
      if (u) init(u);
    }
    let chat = state.openChats[convId];
    if (!chat) {
      // Find conv details from state or fetch
      let conv = state.conversations.find(c => c.id === convId);
      if (!conv) {
        await loadConversations();
        conv = state.conversations.find(c => c.id === convId);
      }
      if (!conv) {
        conv = {
          id: convId,
          type: 'DIRECT',
          title: 'Direct Chat',
          unread_count: 0
        };
      }

      chat = {
        convId,
        conv,
        minimized: false,
        messages: [],
        pollInterval: null
      };
      state.openChats[convId] = chat;
    } else {
      chat.minimized = false;
    }

    renderChatsDock();
    await loadChatMessages(convId);
    markConversationRead(convId);

    // Focus input
    setTimeout(() => {
      const input = document.getElementById(`chatInput_${convId}`);
      if (input) input.focus();
    }, 100);

    // Start live poll for this chat window
    if (!chat.pollInterval) {
      chat.pollInterval = setInterval(() => {
        pollChatMessages(convId);
      }, 3000);
    }
  }

  async function startDirectChatWithEmployee(empId) {
    toggleMessenger(false);
    const panel = document.getElementById('msgPanelWindow');
    if (panel) panel.style.display = 'none';
    state.messengerOpen = false;

    if (!state.currentUser) {
      const u = window.session || (typeof session !== 'undefined' ? session : null);
      if (u) init(u);
    }
    if (!state.employees || state.employees.length === 0) {
      await loadEmployees();
    }
    const targetEmp = (state.employees || []).find(e => Number(e.id) === Number(empId));

    try {
      const data = await apiCall('/api/chat/conversations/direct', {
        method: 'POST',
        body: { target_employee_id: empId }
      });
      const convId = data.conversation_id || (data.data && data.data.conversation_id);
      if (convId) {
        let conv = state.conversations.find(c => c.id === convId);
        if (!conv) {
          conv = {
            id: convId,
            type: 'DIRECT',
            title: targetEmp ? targetEmp.name : 'Direct Chat',
            target_employee: targetEmp ? { employee_id: Number(empId), name: targetEmp.name } : null,
            status: targetEmp ? (targetEmp.status || 'OFFLINE') : 'OFFLINE',
            unread_count: 0,
            last_message: ''
          };
          state.conversations.unshift(conv);
        }
        await openFloatingChat(convId);
        loadConversations();
      } else {
        alert(data.error || 'Could not initiate chat with this employee.');
      }
    } catch (e) {
      console.error('Error starting direct chat:', e);
      alert('Unable to open chat: ' + e.message);
    }
  }

  function bringChatToFront(convId) {
    document.querySelectorAll('.msg-chat-box').forEach(b => {
      b.style.zIndex = '100060';
    });
    const box = document.getElementById(`chatBox_${convId}`);
    if (box) box.style.zIndex = '100080';
  }

  function renderChatsDock() {
    const dock = document.getElementById('msgChatsDock');
    if (!dock) return;

    if (state.messengerOpen) {
      dock.classList.add('panel-open');
      dock.style.right = '420px';
    } else {
      dock.classList.remove('panel-open');
      dock.style.right = '96px';
    }

    dock.innerHTML = Object.values(state.openChats).map(chat => {
      const conv = chat.conv;
      const isGroup = conv.type === 'GROUP';
      const targetEmp = conv.target_employee;
      const presence = targetEmp ? (state.presenceMap[targetEmp.employee_id]?.status || targetEmp.status || 'OFFLINE') : 'OFFLINE';

      return `
        <div class="msg-chat-box ${chat.minimized ? 'minimized' : ''}" id="chatBox_${chat.convId}" data-conv-id="${chat.convId}" onmousedown="window.MessengerApp.bringChatToFront('${chat.convId}')">
          <!-- Chat Header -->
          <div style="padding:10px 14px;background:#0284C7;color:#FFF;display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;" onclick="window.MessengerApp.toggleMinimizeChat('${chat.convId}', event)">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
              <div style="position:relative;flex-shrink:0;">
                <div style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.25);color:#FFF;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:12px;">
                  ${isGroup ? '👥' : getInitials(conv.title)}
                </div>
                ${!isGroup ? `<span class="msg-presence-dot ${presence.toLowerCase()}" style="position:absolute;bottom:-2px;right:-2px;width:8px;height:8px;"></span>` : ''}
              </div>
              <div style="min-width:0;flex:1;">
                <strong style="font-size:13.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(conv.title)}</strong>
                ${!isGroup ? `<span style="font-size:10px;opacity:0.85;">${capitalize(presence)}</span>` : `<span style="font-size:10px;opacity:0.85;">${conv.members?.length || 2} members</span>`}
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;" onclick="event.stopPropagation()">
              ${!isGroup && targetEmp ? `
                <button onclick="window.MessengerApp.startCallWithEmployee(${targetEmp.employee_id}, 'AUDIO')" class="msg-btn" title="Voice Call" style="background:transparent;color:#FFF;padding:4px 6px;font-size:14px;">
                  📞
                </button>
                <button onclick="window.MessengerApp.startCallWithEmployee(${targetEmp.employee_id}, 'VIDEO')" class="msg-btn" title="Video Call" style="background:transparent;color:#FFF;padding:4px 6px;font-size:14px;">
                  📹
                </button>
              ` : ''}
              <button onclick="window.MessengerApp.toggleMinimizeChat('${chat.convId}')" class="msg-btn" title="Minimize" style="background:transparent;color:#FFF;padding:4px;font-size:12px;line-height:1;">
                ➖
              </button>
              <button onclick="window.MessengerApp.closeFloatingChat('${chat.convId}')" class="msg-btn" title="Close" style="background:transparent;color:#FFF;padding:4px;font-size:16px;line-height:1;">
                &times;
              </button>
            </div>
          </div>

          <!-- Chat Body: Messages -->
          <div class="msg-messages-scroll" id="msgScroll_${chat.convId}" style="flex:1;overflow-y:auto;padding:12px 14px;background:#F8FAFC;display:flex;flex-direction:column;">
            <div style="text-align:center;padding:20px;color:#94A3B8;font-size:12px;">Loading messages...</div>
          </div>

          <!-- Drag and Drop Overlay Indicator -->
          <div id="dropOverlay_${chat.convId}" style="display:none;position:absolute;inset:48px 0 54px 0;background:rgba(2,132,199,0.9);color:#FFF;flex-direction:column;align-items:center;justify-content:center;font-weight:700;font-size:14px;z-index:10;pointer-events:none;">
            <span style="font-size:28px;margin-bottom:6px;">📂</span>
            Drop files here to send
          </div>

          <!-- Chat Footer: Input & Attachment Controls -->
          <div style="padding:8px 10px;background:#FFF;border-top:1px solid #E2E8F0;display:flex;flex-direction:column;gap:6px;">
            <!-- Attachment bar & quick actions -->
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <div style="display:flex;align-items:center;gap:4px;">
                <label class="msg-btn msg-btn-ghost" title="Attach Document" style="padding:4px 6px;font-size:14px;cursor:pointer;">
                  📎
                  <input type="file" onchange="window.MessengerApp.handleFileSelect('${chat.convId}', this)" style="display:none;">
                </label>
                <label class="msg-btn msg-btn-ghost" title="Send Image" style="padding:4px 6px;font-size:14px;cursor:pointer;">
                  📷
                  <input type="file" accept="image/*" onchange="window.MessengerApp.handleFileSelect('${chat.convId}', this)" style="display:none;">
                </label>
                <button type="button" onclick="window.MessengerApp.toggleEmojiPicker('${chat.convId}', event)" class="msg-btn msg-btn-ghost" title="Emoji" style="padding:4px 6px;font-size:14px;">
                  😀
                </button>
              </div>

              <!-- Typing indicator / status note -->
              <div id="typing_${chat.convId}" style="font-size:11px;color:#94A3B8;"></div>
            </div>

            <!-- Emoji Picker Popover -->
            <div id="emojiPicker_${chat.convId}" style="display:none;position:absolute;bottom:54px;left:10px;background:#FFF;border:1px solid #E2E8F0;border-radius:10px;box-shadow:0 8px 20px rgba(0,0,0,0.15);padding:8px;grid-template-columns:repeat(8, 1fr);gap:4px;z-index:20;">
              ${['😀', '😂', '😍', '👍', '🎉', '🚀', '💡', '🔥', '🙌', '🙏', '❤️', '👏', '💼', '📞', '📅', '🏆'].map(em => `
                <button type="button" onclick="window.MessengerApp.insertEmoji('${chat.convId}', '${em}')" style="background:none;border:none;font-size:18px;cursor:pointer;padding:4px;border-radius:6px;" onmouseover="this.style.background='#F1F5F9'" onmouseout="this.style.background=''">
                  ${em}
                </button>
              `).join('')}
            </div>

            <!-- Input Text Area -->
            <div style="display:flex;align-items:flex-end;gap:6px;">
              <textarea id="chatInput_${chat.convId}" rows="1" placeholder="Type a message..." onkeydown="window.MessengerApp.handleInputKeyDown('${chat.convId}', event)" style="flex:1;resize:none;max-height:80px;padding:8px 10px;border:1px solid #CBD5E1;border-radius:18px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box;line-height:1.3;"></textarea>
              <button onclick="window.MessengerApp.sendTextMessage('${chat.convId}')" class="msg-btn msg-btn-primary" style="width:34px;height:34px;border-radius:50%;padding:0;flex-shrink:0;">
                ➤
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Setup drag-and-drop listener on each chat box
    Object.values(state.openChats).forEach(chat => {
      setupChatDragAndDrop(chat.convId);
    });
  }

  function setupChatDragAndDrop(convId) {
    const box = document.getElementById(`chatBox_${convId}`);
    const overlay = document.getElementById(`dropOverlay_${convId}`);
    if (!box || !overlay) return;

    box.addEventListener('dragover', e => {
      e.preventDefault();
      overlay.style.display = 'flex';
    });
    box.addEventListener('dragleave', e => {
      if (!box.contains(e.relatedTarget)) {
        overlay.style.display = 'none';
      }
    });
    box.addEventListener('drop', e => {
      e.preventDefault();
      overlay.style.display = 'none';
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        uploadAndSendFile(convId, e.dataTransfer.files[0]);
      }
    });
  }

  function toggleMinimizeChat(convId, event) {
    if (event) event.stopPropagation();
    const chat = state.openChats[convId];
    if (chat) {
      chat.minimized = !chat.minimized;
      const box = document.getElementById(`chatBox_${convId}`);
      if (box) {
        box.classList.toggle('minimized', chat.minimized);
      }
    }
  }

  function closeFloatingChat(convId) {
    const chat = state.openChats[convId];
    if (chat) {
      if (chat.pollInterval) clearInterval(chat.pollInterval);
      delete state.openChats[convId];
      renderChatsDock();
    }
  }

  async function loadChatMessages(convId) {
    const chat = state.openChats[convId];
    if (!chat) return;

    try {
      const res = await fetch(`/api/chat/conversations/${convId}/messages?limit=60`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        chat.messages = data.messages || [];
        renderChatMessages(convId, true);
      }
    } catch (e) { }
  }

  async function pollChatMessages(convId) {
    const chat = state.openChats[convId];
    if (!chat) return;

    const lastMsg = chat.messages[chat.messages.length - 1];
    const since = lastMsg ? lastMsg.created_at : null;
    const url = since ? `/api/chat/conversations/${convId}/messages?since=${encodeURIComponent(since)}` : `/api/chat/conversations/${convId}/messages?limit=30`;

    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && data.messages && data.messages.length > 0) {
        const newOnes = data.messages.filter(m => !chat.messages.some(old => old.id === m.id));
        if (newOnes.length > 0) {
          chat.messages.push(...newOnes);
          renderChatMessages(convId, true);
          markConversationRead(convId);

          // Trigger audio chime & notification if incoming message from other
          const incomingFromOther = newOnes.some(m => !m.is_self);
          if (incomingFromOther) {
            playMessageChime();
            const lastOne = newOnes[newOnes.length - 1];
            startTitleBlink(lastOne.sender_name);
            triggerDesktopNotification(lastOne.sender_name, lastOne.content, convId);
          }
        }
      }
    } catch (e) { }
  }

  function renderChatMessages(convId, scrollDown = false) {
    const chat = state.openChats[convId];
    const container = document.getElementById(`msgScroll_${convId}`);
    if (!chat || !container) return;

    if (chat.messages.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px 10px;color:#94A3B8;font-size:12.5px;">
          <div style="font-size:26px;margin-bottom:6px;">👋</div>
          <strong>Say hello!</strong>
          <p style="margin:2px 0 0;">Send a message to start collaboration.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = chat.messages.map(m => {
      const isMine = m.is_self;
      const timeStr = formatShortTime(m.created_at);

      let bodyHtml = '';
      if (m.message_type === 'IMAGE' && m.file_url) {
        bodyHtml = `
          <div style="cursor:pointer;" onclick="window.MessengerApp.openImageLightbox('${m.file_url}')">
            <img src="${m.file_url}" style="max-width:100%;max-height:180px;border-radius:10px;display:block;object-fit:cover;" alt="${escHtml(m.file_name || 'image')}">
            ${m.content && m.content !== `📷 ${m.file_name}` ? `<div style="margin-top:6px;">${escHtml(m.content)}</div>` : ''}
          </div>
        `;
      } else if (m.message_type === 'FILE' && m.file_url) {
        bodyHtml = `
          <div style="display:flex;align-items:center;gap:10px;background:${isMine ? 'rgba(255,255,255,0.15)' : '#FFF'};padding:8px 10px;border-radius:10px;">
            <span style="font-size:24px;">📄</span>
            <div style="min-width:0;flex:1;">
              <strong style="font-size:12.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(m.file_name || 'Document')}</strong>
              <span style="font-size:11px;opacity:0.8;">${formatFileSize(m.file_size)}</span>
            </div>
            <a href="${m.file_url}" target="_blank" download class="msg-btn" style="background:${isMine ? '#FFF' : '#0284C7'};color:${isMine ? '#0284C7' : '#FFF'};padding:4px 8px;font-size:11px;text-decoration:none;">
              Download
            </a>
          </div>
          ${m.content && !m.content.startsWith('📎') ? `<div style="margin-top:6px;">${escHtml(m.content)}</div>` : ''}
        `;
      } else {
        bodyHtml = `<div>${formatMessageContent(m.content)}</div>`;
      }

      return `
        <div class="msg-bubble-wrap ${isMine ? 'mine' : 'theirs'}">
          ${(!isMine && chat.conv.type === 'GROUP') ? `
            <span style="font-size:10.5px;font-weight:700;color:#64748B;margin-bottom:2px;margin-left:4px;">${escHtml(m.sender_name)}</span>
          ` : ''}
          <div class="msg-bubble">
            ${bodyHtml}
          </div>
          <span class="msg-stamp">${timeStr}</span>
        </div>
      `;
    }).join('');

    if (scrollDown) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function handleInputKeyDown(convId, e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTextMessage(convId);
    }
  }

  async function sendTextMessage(convId) {
    const input = document.getElementById(`chatInput_${convId}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    try {
      const data = await apiCall(`/api/chat/conversations/${convId}/messages`, {
        method: 'POST',
        body: {
          type: 'TEXT',
          content: text
        }
      });
      if (data && (data.message || data.ok)) {
        const msg = data.message || data;
        const chat = state.openChats[convId];
        if (chat) {
          chat.messages.push({ ...msg, is_self: true, sender_name: state.currentUser?.name });
          renderChatMessages(convId, true);
        }
        loadConversations();
      }
    } catch (e) {
      console.error('Failed to send text message:', e);
      alert('Could not send message: ' + e.message);
    }
  }

  function handleFileSelect(convId, inputEl) {
    if (inputEl.files && inputEl.files[0]) {
      uploadAndSendFile(convId, inputEl.files[0]);
      inputEl.value = '';
    }
  }

  async function uploadAndSendFile(convId, file) {
    if (!file) return;
    const typingIndicator = document.getElementById(`typing_${convId}`);
    if (typingIndicator) typingIndicator.textContent = 'Uploading...';

    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result;
      try {
        const data = await apiCall(`/api/chat/conversations/${convId}/messages`, {
          method: 'POST',
          body: {
            content: '',
            file: {
              name: file.name,
              type: file.type,
              data: base64Data
            }
          }
        });
        if (data && (data.message || data.ok)) {
          const msg = data.message || data;
          const chat = state.openChats[convId];
          if (chat) {
            chat.messages.push({ ...msg, is_self: true, sender_name: state.currentUser?.name });
            renderChatMessages(convId, true);
          }
          loadConversations();
        }
      } catch (e) {
        alert('File upload failed: ' + e.message);
      } finally {
        if (typingIndicator) typingIndicator.textContent = '';
      }
    };
    reader.readAsDataURL(file);
  }

  function toggleEmojiPicker(convId, e) {
    e.stopPropagation();
    const picker = document.getElementById(`emojiPicker_${convId}`);
    if (picker) {
      picker.style.display = picker.style.display === 'grid' ? 'none' : 'grid';
    }
  }

  function insertEmoji(convId, emoji) {
    const input = document.getElementById(`chatInput_${convId}`);
    if (input) {
      input.value += emoji;
      input.focus();
    }
    const picker = document.getElementById(`emojiPicker_${convId}`);
    if (picker) picker.style.display = 'none';
  }

  async function markConversationRead(convId) {
    try {
      await fetch(`/api/chat/conversations/${convId}/read`, { method: 'POST' });
      const conv = state.conversations.find(c => c.id === convId);
      if (conv) conv.unread_count = 0;
      updateTotalUnreadBadge();
    } catch (e) { }
  }

  /* ==========================================================================
     GROUP CREATION MODAL
     ========================================================================== */

  function openNewGroupModal() {
    let myEmpId = state.currentUser?.employeeId || state.currentUser?.id;
    const candidates = state.employees.filter(e => Number(e.id) !== Number(myEmpId));

    const modal = document.createElement('div');
    modal.id = 'msgNewGroupModal';
    modal.className = 'msg-modal-overlay';
    modal.innerHTML = `
      <div class="msg-modal-box" style="max-width:440px;animation:msgPopIn 0.2s cubic-bezier(0.16,1,0.3,1);">
        <div style="padding:16px 20px;border-bottom:1px solid #E2E8F0;display:flex;align-items:center;justify-content:space-between;">
          <h3 style="margin:0;font-size:16px;font-weight:700;color:#0F172A;">Create Group Chat</h3>
          <button onclick="document.getElementById('msgNewGroupModal').remove()" style="background:none;border:none;font-size:22px;color:#94A3B8;cursor:pointer;">&times;</button>
        </div>

        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px;">
          <div>
            <label style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;">Group Name *</label>
            <input type="text" id="newGroupTitle" placeholder="e.g. Sales Sprint, Tech Ops, Client Launch" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid #CBD5E1;border-radius:8px;font-size:13.5px;box-sizing:border-box;">
          </div>

          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <label style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;">Select Members</label>
              <span id="groupSelectedCount" style="font-size:11.5px;color:#0284C7;font-weight:700;">0 selected</span>
            </div>

            <div style="max-height:220px;overflow-y:auto;border:1px solid #E2E8F0;border-radius:10px;padding:6px;display:flex;flex-direction:column;gap:4px;">
              ${candidates.map(e => `
                <label style="display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;cursor:pointer;transition:background 0.1s;" onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background=''">
                  <input type="checkbox" value="${e.id}" class="group-member-cb" onchange="window.MessengerApp.updateGroupSelectedCount()" style="width:16px;height:16px;cursor:pointer;">
                  <div style="width:28px;height:28px;border-radius:6px;background:${getAvatarColor(e.name)};color:#FFF;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;">
                    ${getInitials(e.name)}
                  </div>
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:13px;font-weight:600;color:#0F172A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(e.name)}</div>
                    <div style="font-size:11px;color:#64748B;">${escHtml(e.department || '')}</div>
                  </div>
                </label>
              `).join('')}
            </div>
          </div>
        </div>

        <div style="padding:14px 20px;border-top:1px solid #E2E8F0;background:#FAFAFA;display:flex;justify-content:flex-end;gap:10px;">
          <button onclick="document.getElementById('msgNewGroupModal').remove()" class="msg-btn msg-btn-ghost" style="padding:8px 16px;">Cancel</button>
          <button onclick="window.MessengerApp.submitCreateGroup()" class="msg-btn msg-btn-primary" style="padding:8px 18px;">Create Group</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  function updateGroupSelectedCount() {
    const checked = document.querySelectorAll('.group-member-cb:checked');
    const label = document.getElementById('groupSelectedCount');
    if (label) label.textContent = `${checked.length} selected`;
  }

  async function submitCreateGroup() {
    const titleInput = document.getElementById('newGroupTitle');
    const title = titleInput ? titleInput.value.trim() : '';
    if (!title) {
      alert('Please enter a group name.');
      return;
    }

    const checkedBoxes = Array.from(document.querySelectorAll('.group-member-cb:checked'));
    const memberIds = checkedBoxes.map(cb => Number(cb.value));

    try {
      const data = await apiCall('/api/chat/conversations/group', {
        method: 'POST',
        body: {
          title,
          member_employee_ids: memberIds
        }
      });
      const convId = data.conversation_id || (data.data && data.data.conversation_id);
      if (convId) {
        document.getElementById('msgNewGroupModal')?.remove();
        await loadConversations();
        openFloatingChat(convId);
      } else {
        alert(data.error || 'Failed to create group');
      }
    } catch (e) {
      alert('Error creating group: ' + e.message);
    }
  }

  /* ==========================================================================
     WEBRTC 1-ON-1 AUDIO & VIDEO CALLING ENGINE
     ========================================================================== */

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  async function startCallWithEmployee(receiverEmpId, callType = 'AUDIO') {
    toggleMessenger(false);
    const panel = document.getElementById('msgPanelWindow');
    if (panel) panel.style.display = 'none';
    state.messengerOpen = false;

    if (!state.currentUser) {
      const u = window.session || (typeof session !== 'undefined' ? session : null);
      if (u) init(u);
    }
    const recId = Number(receiverEmpId);
    const targetEmp = (state.employees || []).find(e => Number(e.id) === recId);
    const targetName = targetEmp ? targetEmp.name : `Employee #${recId}`;

    try {
      const constraints = {
        audio: true,
        video: callType === 'VIDEO' ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      };
      const localStream = await navigator.mediaDevices.getUserMedia(constraints);

      const pc = new RTCPeerConnection(rtcConfig);
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      const remoteStream = new MediaStream();
      pc.ontrack = event => {
        event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
      };

      state.activeCall = {
        callId: null,
        peerId: recId,
        peerName: targetName,
        type: callType,
        isCaller: true,
        pc,
        localStream,
        remoteStream,
        status: 'CALLING',
        callSeconds: 0,
        timerInterval: null
      };

      // Create WebRTC Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Handle local ICE candidates
      pc.onicecandidate = event => {
        if (event.candidate && state.activeCall?.callId) {
          sendIceCandidate(state.activeCall.callId, event.candidate);
        }
      };

      // Send initiate call request to server
      const data = await apiCall('/api/chat/call/initiate', {
        method: 'POST',
        body: {
          receiver_employee_id: recId,
          call_type: callType,
          sdp_offer: JSON.stringify(offer)
        }
      });

      if (!data.callId && !data.ok) throw new Error(data.error || 'Failed to start call');

      state.activeCall.callId = data.callId;
      startRingtone();
      renderActiveCallModal();

      // Poll for callee's answer
      pollForCallAnswer(data.callId);

    } catch (err) {
      console.error('Call initiation error:', err);
      alert('Unable to start call: ' + (err.message || 'Please verify microphone/camera permissions.'));
      endCall();
    }
  }

  async function pollForCallAnswer(callId) {
    const pollInterval = setInterval(async () => {
      if (!state.activeCall || state.activeCall.callId !== callId) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const res = await fetch(`/api/chat/call/${callId}/poll`);
        const data = await res.json();
        if (data.ok) {
          if (data.status === 'ACCEPTED' && data.sdpAnswer && state.activeCall.status !== 'CONNECTED') {
            stopRingtone();
            state.activeCall.status = 'CONNECTED';
            const answer = JSON.parse(data.sdpAnswer);
            await state.activeCall.pc.setRemoteDescription(new RTCSessionDescription(answer));

            // Start timer
            startCallDurationTimer();
            renderActiveCallModal();
          } else if (['DECLINED', 'BUSY', 'ENDED'].includes(data.status)) {
            clearInterval(pollInterval);
            stopRingtone();
            alert(`Call ${data.status.toLowerCase()}`);
            endCall();
          }

          // Ingest peer candidates
          if (data.peerCandidates && state.activeCall?.pc) {
            for (const cand of data.peerCandidates) {
              try {
                await state.activeCall.pc.addIceCandidate(new RTCIceCandidate(cand));
              } catch (e) { }
            }
          }
        }
      } catch (e) { }
    }, 1500);
  }

  // Callee Polling for Incoming Calls
  async function checkForIncomingCalls() {
    if (state.activeCall || state.incomingCall || !state.currentUser) return;

    try {
      const res = await fetch('/api/chat/call/check-incoming');
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && data.incoming) {
        state.incomingCall = data.incoming;
        startRingtone();
        showIncomingCallModal(data.incoming);
      }
    } catch (e) { }
  }

  function showIncomingCallModal(call) {
    if (document.getElementById('msgIncomingCallModal')) return;

    const modal = document.createElement('div');
    modal.id = 'msgIncomingCallModal';
    modal.className = 'msg-modal-overlay';
    modal.innerHTML = `
      <div class="msg-modal-box" style="max-width:360px;text-align:center;padding:30px 24px;animation:msgPopIn 0.25s cubic-bezier(0.16,1,0.3,1);">
        <div style="position:relative;width:80px;height:80px;margin:0 auto 16px;">
          <div style="width:80px;height:80px;border-radius:50%;background:${getAvatarColor(call.callerName)};color:#FFF;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;">
            ${getInitials(call.callerName)}
          </div>
          <div style="position:absolute;inset:-6px;border-radius:50%;border:2px solid #0284C7;animation:msgRingingPulse 1.5s infinite;"></div>
        </div>

        <h3 style="margin:0 0 4px;font-size:18px;font-weight:800;color:#0F172A;">${escHtml(call.callerName)}</h3>
        <p style="margin:0 0 6px;font-size:12.5px;color:#64748B;">${escHtml(call.callerDesignation || 'Teammate')}</p>
        <span style="display:inline-block;background:#E0F2FE;color:#0284C7;font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:12px;margin-bottom:24px;">
          Incoming ${call.callType} Call...
        </span>

        <div style="display:flex;align-items:center;justify-content:center;gap:16px;">
          <button onclick="window.MessengerApp.respondIncomingCall('DECLINE')" class="msg-btn" style="background:#EF4444;color:#FFF;width:56px;height:56px;border-radius:50%;font-size:22px;box-shadow:0 6px 16px rgba(239,68,68,0.4);" title="Decline">
            ✕
          </button>
          <button onclick="window.MessengerApp.respondIncomingCall('ACCEPT')" class="msg-btn" style="background:#10B981;color:#FFF;width:56px;height:56px;border-radius:50%;font-size:22px;box-shadow:0 6px 16px rgba(16,185,129,0.4);" title="Accept Call">
            ${call.callType === 'VIDEO' ? '📹' : '📞'}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  async function respondIncomingCall(action) {
    stopRingtone();
    const modal = document.getElementById('msgIncomingCallModal');
    if (modal) modal.remove();

    const call = state.incomingCall;
    state.incomingCall = null;
    if (!call) return;

    if (action === 'DECLINE') {
      try {
        await apiCall('/api/chat/call/respond', {
          method: 'POST',
          body: { call_id: call.callId, action: 'DECLINE' }
        });
      } catch (e) { }
      return;
    }

    // ACCEPT Call
    try {
      const constraints = {
        audio: true,
        video: call.callType === 'VIDEO' ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      };
      const localStream = await navigator.mediaDevices.getUserMedia(constraints);

      const pc = new RTCPeerConnection(rtcConfig);
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      const remoteStream = new MediaStream();
      pc.ontrack = event => {
        event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
      };

      state.activeCall = {
        callId: call.callId,
        peerId: call.callerId,
        peerName: call.callerName,
        type: call.callType,
        isCaller: false,
        pc,
        localStream,
        remoteStream,
        status: 'CONNECTED',
        callSeconds: 0,
        timerInterval: null
      };

      pc.onicecandidate = event => {
        if (event.candidate) {
          sendIceCandidate(call.callId, event.candidate);
        }
      };

      // Set remote offer & create answer
      const offer = JSON.parse(call.sdpOffer);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Send answer
      await apiCall('/api/chat/call/respond', {
        method: 'POST',
        body: {
          call_id: call.callId,
          action: 'ACCEPT',
          sdp_answer: JSON.stringify(answer)
        }
      });

      startCallDurationTimer();
      renderActiveCallModal();

      // Poll for peer candidates or call end
      pollPeerCandidates(call.callId);

    } catch (err) {
      console.error('Error answering call:', err);
      alert('Could not answer call: ' + err.message);
      endCall();
    }
  }

  async function pollPeerCandidates(callId) {
    const interval = setInterval(async () => {
      if (!state.activeCall || state.activeCall.callId !== callId) {
        clearInterval(interval);
        return;
      }
      try {
        const res = await fetch(`/api/chat/call/${callId}/poll`);
        const data = await res.json();
        if (data.ok) {
          if (data.status === 'ENDED') {
            clearInterval(interval);
            alert('Call ended by peer');
            endCall();
          } else if (data.peerCandidates && state.activeCall?.pc) {
            for (const cand of data.peerCandidates) {
              try { await state.activeCall.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) { }
            }
          }
        }
      } catch (e) { }
    }, 1500);
  }

  async function sendIceCandidate(callId, candidate) {
    try {
      await fetch('/api/chat/call/ice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_id: callId, candidate })
      });
    } catch (e) { }
  }

  function renderActiveCallModal() {
    let modal = document.getElementById('msgActiveCallModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'msgActiveCallModal';
      modal.className = 'msg-modal-overlay';
      document.body.appendChild(modal);
    }

    const call = state.activeCall;
    if (!call) {
      modal.remove();
      return;
    }

    const isVideo = call.type === 'VIDEO';

    modal.innerHTML = `
      <div class="msg-modal-box" style="max-width:${isVideo ? '720px' : '420px'};background:#0F172A;color:#FFF;position:relative;">
        <!-- Header -->
        <div style="padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.1);">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:18px;">${isVideo ? '📹' : '📞'}</span>
            <div>
              <strong style="font-size:14px;color:#FFF;">${escHtml(call.peerName)}</strong>
              <div style="font-size:11px;color:#94A3B8;" id="msgCallTimerLabel">${call.status === 'CONNECTED' ? formatCallTimer(call.callSeconds) : 'Connecting...'}</div>
            </div>
          </div>
          <span style="font-size:12px;background:${call.status === 'CONNECTED' ? '#059669' : '#D97706'};padding:3px 8px;border-radius:10px;font-weight:700;">
            ${call.status}
          </span>
        </div>

        <!-- Video Area / Audio Visualizer -->
        <div style="position:relative;height:${isVideo ? '400px' : '220px'};background:#020617;display:flex;align-items:center;justify-content:center;overflow:hidden;">
          ${isVideo ? `
            <!-- Remote Full Video -->
            <video id="msgRemoteVideo" autoplay playsinline style="width:100%;height:100%;object-fit:cover;"></video>
            <!-- Local PiP Video -->
            <video id="msgLocalVideo" autoplay playsinline muted style="position:absolute;bottom:14px;right:14px;width:140px;height:105px;border-radius:10px;border:2px solid rgba(255,255,255,0.4);object-fit:cover;background:#1E293B;"></video>
          ` : `
            <!-- Voice Call Avatar Card -->
            <div style="text-align:center;">
              <div style="position:relative;width:90px;height:90px;margin:0 auto 12px;">
                <div style="width:90px;height:90px;border-radius:50%;background:${getAvatarColor(call.peerName)};color:#FFF;font-size:32px;font-weight:700;display:flex;align-items:center;justify-content:center;">
                  ${getInitials(call.peerName)}
                </div>
                ${call.status === 'CONNECTED' ? `<div style="position:absolute;inset:-8px;border-radius:50%;border:2px solid #10B981;animation:msgRingingPulse 2s infinite;"></div>` : ''}
              </div>
              <strong style="font-size:16px;">${escHtml(call.peerName)}</strong>
              <p style="margin:4px 0 0;font-size:12px;color:#94A3B8;">Voice Call · Mypreneur Encrypted</p>
            </div>
          `}
        </div>

        <!-- Controls Toolbar -->
        <div style="padding:16px 20px;display:flex;align-items:center;justify-content:center;gap:18px;background:#0F172A;border-top:1px solid rgba(255,255,255,0.1);">
          <!-- Mic Toggle -->
          <button onclick="window.MessengerApp.toggleMic()" id="msgBtnMic" class="msg-btn" style="width:48px;height:48px;border-radius:50%;background:#1E293B;color:#FFF;font-size:18px;" title="Mute/Unmute Mic">
            🎤
          </button>
          ${isVideo ? `
            <!-- Camera Toggle -->
            <button onclick="window.MessengerApp.toggleCamera()" id="msgBtnCam" class="msg-btn" style="width:48px;height:48px;border-radius:50%;background:#1E293B;color:#FFF;font-size:18px;" title="Camera On/Off">
              📹
            </button>
          ` : ''}
          <!-- Hangup Button -->
          <button onclick="window.MessengerApp.endCall()" class="msg-btn" style="width:52px;height:52px;border-radius:50%;background:#EF4444;color:#FFF;font-size:22px;box-shadow:0 6px 16px rgba(239,68,68,0.4);" title="End Call">
            🔴
          </button>
        </div>
      </div>
    `;

    // Bind streams to video tags
    if (isVideo) {
      const localVid = document.getElementById('msgLocalVideo');
      const remoteVid = document.getElementById('msgRemoteVideo');
      if (localVid && call.localStream) localVid.srcObject = call.localStream;
      if (remoteVid && call.remoteStream) remoteVid.srcObject = call.remoteStream;
    }
  }

  function startCallDurationTimer() {
    if (!state.activeCall) return;
    if (state.activeCall.timerInterval) clearInterval(state.activeCall.timerInterval);
    state.activeCall.timerInterval = setInterval(() => {
      if (state.activeCall) {
        state.activeCall.callSeconds++;
        const lbl = document.getElementById('msgCallTimerLabel');
        if (lbl) lbl.textContent = formatCallTimer(state.activeCall.callSeconds);
      }
    }, 1000);
  }

  function toggleMic() {
    if (!state.activeCall?.localStream) return;
    const audioTrack = state.activeCall.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const btn = document.getElementById('msgBtnMic');
      if (btn) {
        btn.textContent = audioTrack.enabled ? '🎤' : '🔇';
        btn.style.background = audioTrack.enabled ? '#1E293B' : '#EF4444';
      }
    }
  }

  function toggleCamera() {
    if (!state.activeCall?.localStream) return;
    const vidTrack = state.activeCall.localStream.getVideoTracks()[0];
    if (vidTrack) {
      vidTrack.enabled = !vidTrack.enabled;
      const btn = document.getElementById('msgBtnCam');
      if (btn) {
        btn.textContent = vidTrack.enabled ? '📹' : '🚫';
        btn.style.background = vidTrack.enabled ? '#1E293B' : '#EF4444';
      }
    }
  }

  async function endCall() {
    stopRingtone();
    const call = state.activeCall;
    if (call) {
      if (call.timerInterval) clearInterval(call.timerInterval);
      if (call.localStream) {
        call.localStream.getTracks().forEach(t => t.stop());
      }
      if (call.pc) {
        call.pc.close();
      }
      if (call.callId) {
        try {
          await fetch(`/api/chat/call/${call.callId}/end`, { method: 'POST' });
        } catch (e) { }
      }
    }
    state.activeCall = null;
    document.getElementById('msgActiveCallModal')?.remove();
  }

  /* ==========================================================================
     IMAGE LIGHTBOX PREVIEW
     ========================================================================== */

  function openImageLightbox(url) {
    const box = document.createElement('div');
    box.className = 'msg-modal-overlay';
    box.onclick = () => box.remove();
    box.innerHTML = `
      <div style="position:relative;max-width:90vw;max-height:90vh;padding:10px;">
        <img src="${url}" style="max-width:100%;max-height:85vh;border-radius:12px;box-shadow:0 25px 50px rgba(0,0,0,0.5);" alt="Preview">
        <button onclick="this.parentElement.parentElement.remove()" style="position:absolute;top:-10px;right:-10px;background:#EF4444;color:#FFF;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:18px;font-weight:700;">&times;</button>
      </div>
    `;
    document.body.appendChild(box);
  }

  /* ==========================================================================
     UTILITIES & HELPERS
     ========================================================================== */

  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMessageContent(content) {
    if (!content) return '';
    let escaped = escHtml(content);
    // Linkify URLs
    escaped = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;font-weight:600;">$1</a>');
    return escaped.replace(/\n/g, '<br>');
  }

  function getInitials(name) {
    if (!name) return '??';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function getAvatarColor(name) {
    if (!name) return '#0284C7';
    const colors = [
      '#0284C7', '#0EA5E9', '#8B5CF6', '#EC4899', '#F59E0B',
      '#10B981', '#14B8A6', '#6366F1', '#3B82F6', '#D97706'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }

  function formatShortTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function formatCallTimer(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /* ==========================================================================
     LIFECYCLE INIT & DESTROY
     ========================================================================== */

  function init(sessionUser) {
    if (!sessionUser) return;
    state.currentUser = sessionUser;
    state.initialized = true;

    // 1. Mount UI & Styles
    mountMessengerBar();

    // 2. Setup Idle detection & Heartbeat
    setupIdleMonitor();
    sendHeartbeat('ONLINE');

    // 3. Periodic Intervals
    state.presenceInterval = setInterval(() => {
      sendHeartbeat();
      fetchAllPresence();
    }, 20000);

    state.unreadCheckInterval = setInterval(() => {
      loadConversations();
    }, 12000);

    state.callCheckInterval = setInterval(() => {
      checkForIncomingCalls();
    }, 2500);

    // Initial loads
    fetchAllPresence();
    loadConversations();
    loadEmployees();
    checkOfflineCatchup();

    // Request notification permission if not yet decided
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => { });
    }
  }

  function destroy() {
    state.initialized = false;
    state.currentUser = null;
    clearTimeout(state.idleTimer);
    if (state.presenceInterval) clearInterval(state.presenceInterval);
    if (state.unreadCheckInterval) clearInterval(state.unreadCheckInterval);
    if (state.callCheckInterval) clearInterval(state.callCheckInterval);
    stopRingtone();
    stopTitleBlink();
    endCall();

    document.getElementById('msgLauncherWrap')?.remove();
  }

  // Export to Global Window
  window.MessengerApp = {
    init,
    destroy,
    toggleMessenger,
    bringChatToFront,
    switchTab,
    handleSearch,
    changeMyStatus,
    openFloatingChat,
    closeFloatingChat,
    toggleMinimizeChat,
    sendTextMessage,
    handleInputKeyDown,
    handleFileSelect,
    toggleEmojiPicker,
    insertEmoji,
    openNewGroupModal,
    updateGroupSelectedCount,
    submitCreateGroup,
    startDirectChatWithEmployee,
    startCallWithEmployee,
    respondIncomingCall,
    toggleMic,
    toggleCamera,
    endCall,
    openImageLightbox
  };

  // Auto-init if global session is already populated
  if (window.session) {
    init(window.session);
  }

})(window);

