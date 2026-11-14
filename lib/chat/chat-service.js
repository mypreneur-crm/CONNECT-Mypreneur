'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomUUID();
}

class ChatService {
  constructor(db, fileStore, options = {}) {
    this.db = db;
    this.fileStore = fileStore;
    this.options = options;
    // In-memory cache for presence to minimize DB load on frequent heartbeats
    this.presenceCache = new Map(); // employee_id -> { status, lastSeen, customStatus }
  }

  /* ================= PRESENCE ================= */

  async updatePresence(employeeId, status = 'ONLINE', customStatus = null) {
    if (!employeeId) return;
    const empId = Number(employeeId);
    const validStatus = ['ONLINE', 'AWAY', 'OFFLINE'].includes(status) ? status : 'ONLINE';
    const now = Date.now();
    const stamp = nowIso();

    this.presenceCache.set(empId, {
      status: validStatus,
      lastSeen: now,
      customStatus: customStatus || null
    });

    try {
      await this.db.run(`
        INSERT INTO connect_employee_presence (employee_id, status, custom_status, last_heartbeat, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          status = VALUES(status),
          custom_status = COALESCE(VALUES(custom_status), custom_status),
          last_heartbeat = VALUES(last_heartbeat),
          updated_at = VALUES(updated_at)
      `, [empId, validStatus, customStatus, now, stamp]);
    } catch (err) {
      console.warn('[ChatService] updatePresence DB error:', err.message);
    }

    return { employeeId: empId, status: validStatus, lastSeen: now };
  }

  async getAllPresence() {
    const now = Date.now();
    const result = new Map();

    // 1. Pull from DB joined with active employees
    try {
      const rows = await this.db.all(`
        SELECT e.employee_id, p.status, p.custom_status, p.last_heartbeat
        FROM employees e
        LEFT JOIN connect_employee_presence p ON p.employee_id = e.employee_id
        WHERE e.status IS NULL OR UPPER(e.status) = 'ACTIVE'
      `);
      for (const r of rows) {
        const empId = Number(r.employee_id);
        const lastHb = Number(r.last_heartbeat || 0);
        let effStatus = r.status || 'OFFLINE';

        // Expire if no heartbeat in 60 seconds
        if (now - lastHb > 60 * 1000 || !lastHb) {
          effStatus = 'OFFLINE';
        }

        result.set(empId, {
          employee_id: empId,
          status: effStatus,
          custom_status: r.custom_status || '',
          last_heartbeat: lastHb
        });
      }
    } catch (err) {
      console.warn('[ChatService] getAllPresence error:', err.message);
    }

    // 2. Layer in memory cache
    for (const [empId, cache] of this.presenceCache.entries()) {
      let effStatus = cache.status;
      if (now - cache.lastSeen > 60 * 1000) {
        effStatus = 'OFFLINE';
      }
      result.set(empId, {
        employee_id: empId,
        status: effStatus,
        custom_status: cache.customStatus || '',
        last_heartbeat: cache.lastSeen
      });
    }

    const obj = {};
    for (const [id, val] of result.entries()) {
      obj[id] = val;
    }
    return obj;
  }

  /* ================= CONVERSATIONS ================= */

  async getConversations(employeeId) {
    const empId = Number(employeeId);
    if (!empId) return [];

    // Fetch all conversations where employee is a member
    const convRows = await this.db.all(`
      SELECT 
        c.id,
        c.type,
        c.title,
        c.avatar,
        c.created_by,
        c.created_at,
        c.updated_at,
        c.last_message_text,
        c.last_message_at,
        m.last_read_message_id,
        m.last_read_at
      FROM connect_chat_conversations c
      JOIN connect_chat_members m ON m.conversation_id = c.id
      WHERE m.employee_id = ?
      ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC
      LIMIT 100
    `, [empId]);

    if (!convRows || convRows.length === 0) return [];

    const convIds = convRows.map(c => c.id);

    // Fetch all members of these conversations
    const placeholders = convIds.map(() => '?').join(',');
    const memberRows = await this.db.all(`
      SELECT 
        m.conversation_id,
        m.employee_id,
        e.first_name,
        e.last_name,
        e.employee_code,
        e.designation,
        COALESCE(t.team_name, 'General') AS department,
        p.status AS presence_status,
        p.last_heartbeat
      FROM connect_chat_members m
      JOIN employees e ON e.employee_id = m.employee_id
      LEFT JOIN teams t ON e.team_id = t.team_id
      LEFT JOIN connect_employee_presence p ON p.employee_id = m.employee_id
      WHERE m.conversation_id IN (${placeholders})
    `, convIds);

    const membersByConv = new Map();
    const now = Date.now();

    for (const r of memberRows) {
      if (!membersByConv.has(r.conversation_id)) {
        membersByConv.set(r.conversation_id, []);
      }
      const lastHb = Number(r.last_heartbeat || 0);
      let effStatus = r.presence_status || 'OFFLINE';
      if (now - lastHb > 60 * 1000) effStatus = 'OFFLINE';

      // Check cache as well
      const cached = this.presenceCache.get(Number(r.employee_id));
      if (cached && now - cached.lastSeen <= 60 * 1000) {
        effStatus = cached.status;
      }

      const fullName = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || `Employee #${r.employee_id}`;

      membersByConv.get(r.conversation_id).push({
        employee_id: Number(r.employee_id),
        name: fullName,
        employee_code: r.employee_code || `EMP-${r.employee_id}`,
        designation: r.designation || 'Team Member',
        department: r.department || 'General',
        status: effStatus
      });
    }

    // Compute unread count for each conversation
    const unreadMap = new Map();
    for (const c of convRows) {
      const lastReadAt = c.last_read_at || '1970-01-01';
      const unreadRow = await this.db.get(`
        SELECT COUNT(*) AS unread_count
        FROM connect_chat_messages
        WHERE conversation_id = ?
          AND created_at > ?
          AND sender_employee_id != ?
      `, [c.id, lastReadAt, empId]);
      unreadMap.set(c.id, Number(unreadRow?.unread_count || 0));
    }

    return convRows.map(c => {
      const members = membersByConv.get(c.id) || [];
      const otherMembers = members.filter(m => m.employee_id !== empId);

      let displayName = c.title;
      let displayStatus = 'OFFLINE';
      let targetEmployee = null;

      if (c.type === 'DIRECT') {
        const other = otherMembers[0] || members[0];
        if (other) {
          displayName = other.name;
          displayStatus = other.status;
          targetEmployee = other;
        } else {
          displayName = 'Direct Chat';
        }
      }

      return {
        id: c.id,
        type: c.type,
        title: displayName,
        raw_title: c.title,
        avatar: c.avatar,
        target_employee: targetEmployee,
        status: displayStatus,
        members,
        other_members: otherMembers,
        unread_count: unreadMap.get(c.id) || 0,
        last_message: c.last_message_text || '',
        last_message_at: c.last_message_at || c.created_at,
        created_at: c.created_at,
        updated_at: c.updated_at
      };
    });
  }

  async getOrCreateDirectConversation(empId1, empId2) {
    const e1 = Number(empId1);
    const e2 = Number(empId2);
    if (!e1 || !e2) throw new Error('Both employee IDs are required');

    // Check if direct conversation already exists
    const existing = await this.db.get(`
      SELECT c.id 
      FROM connect_chat_conversations c
      JOIN connect_chat_members m1 ON m1.conversation_id = c.id AND m1.employee_id = ?
      JOIN connect_chat_members m2 ON m2.conversation_id = c.id AND m2.employee_id = ?
      WHERE c.type = 'DIRECT'
      LIMIT 1
    `, [e1, e2]);

    if (existing) {
      return existing.id;
    }

    // Create new direct conversation
    const convId = randomId();
    const stamp = nowIso();

    await this.db.run(`
      INSERT INTO connect_chat_conversations (id, type, title, created_by, created_at, updated_at)
      VALUES (?, 'DIRECT', NULL, ?, ?, ?)
    `, [convId, e1, stamp, stamp]);

    await this.db.run(`
      INSERT INTO connect_chat_members (conversation_id, employee_id, joined_at, last_read_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `, [convId, e1, stamp, stamp, convId, e2, stamp, '1970-01-01']);

    return convId;
  }

  async createGroupConversation(creatorEmpId, title, memberEmpIds = []) {
    const creatorId = Number(creatorEmpId);
    if (!creatorId) throw new Error('Creator employee ID is required');
    const groupTitle = String(title || 'New Group').trim();
    if (!groupTitle) throw new Error('Group name is required');

    const convId = randomId();
    const stamp = nowIso();

    await this.db.run(`
      INSERT INTO connect_chat_conversations (id, type, title, created_by, created_at, updated_at)
      VALUES (?, 'GROUP', ?, ?, ?, ?)
    `, [convId, groupTitle, creatorId, stamp, stamp]);

    const allMembers = Array.from(new Set([creatorId, ...memberEmpIds.map(Number).filter(Boolean)]));

    for (const memId of allMembers) {
      await this.db.run(`
        INSERT INTO connect_chat_members (conversation_id, employee_id, joined_at, last_read_at)
        VALUES (?, ?, ?, ?)
      `, [convId, memId, stamp, memId === creatorId ? stamp : '1970-01-01']);
    }

    // Insert system message announcement
    const msgId = randomId();
    await this.db.run(`
      INSERT INTO connect_chat_messages (id, conversation_id, sender_employee_id, message_type, content, created_at)
      VALUES (?, ?, ?, 'CALL_LOG', ?, ?)
    `, [msgId, convId, creatorId, `Group "${groupTitle}" created`, stamp]);

    return convId;
  }

  /* ================= MESSAGES ================= */

  async getMessages(conversationId, employeeId, { after = null, limit = 50 } = {}) {
    const empId = Number(employeeId);
    if (!conversationId || !empId) return [];

    // Verify membership
    const member = await this.db.get(`
      SELECT conversation_id 
      FROM connect_chat_members 
      WHERE conversation_id = ? AND employee_id = ?
    `, [conversationId, empId]);

    if (!member) throw new Error('Access denied to conversation.');

    let query = `
      SELECT 
        m.id,
        m.conversation_id,
        m.sender_employee_id,
        m.sender_user_id,
        m.message_type,
        m.content,
        m.file_url,
        m.file_name,
        m.file_size,
        m.file_type,
        m.created_at,
        e.first_name,
        e.last_name,
        e.employee_code
      FROM connect_chat_messages m
      LEFT JOIN employees e ON e.employee_id = m.sender_employee_id
      WHERE m.conversation_id = ?
    `;
    const params = [conversationId];

    if (after) {
      query += ` AND m.created_at > ?`;
      params.push(after);
    }

    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 100);
    query += ` ORDER BY m.created_at ASC LIMIT ${safeLimit}`;

    const rows = await this.db.all(query, params);

    return rows.map(r => ({
      id: r.id,
      conversation_id: r.conversation_id,
      sender_employee_id: Number(r.sender_employee_id),
      sender_name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || `Employee #${r.sender_employee_id}`,
      sender_code: r.employee_code || '',
      is_self: Number(r.sender_employee_id) === empId,
      message_type: r.message_type,
      content: r.content,
      file_url: r.file_url,
      file_name: r.file_name,
      file_size: r.file_size ? Number(r.file_size) : null,
      file_type: r.file_type,
      created_at: r.created_at
    }));
  }

  async sendMessage({ conversationId, senderEmpId, senderUserId, type = 'TEXT', content = '', fileObj = null }) {
    const convId = conversationId;
    const empId = Number(senderEmpId);
    if (!convId || !empId) throw new Error('Conversation ID and sender are required.');

    // Verify membership
    const member = await this.db.get(`
      SELECT conversation_id 
      FROM connect_chat_members 
      WHERE conversation_id = ? AND employee_id = ?
    `, [convId, empId]);

    if (!member) throw new Error('Sender is not a member of this conversation.');

    const msgId = randomId();
    const stamp = nowIso();
    let msgType = type;
    let fileUrl = null;
    let fileName = null;
    let fileSize = null;
    let fileType = null;
    let previewContent = String(content || '').trim();

    if (fileObj) {
      fileName = fileObj.name;
      fileType = fileObj.type;
      fileSize = fileObj.buffer ? fileObj.buffer.length : 0;
      
      const isImg = fileType && fileType.startsWith('image/');
      msgType = isImg ? 'IMAGE' : 'FILE';

      if (this.fileStore) {
        const saved = await this.fileStore.save('chat', fileName, fileObj.buffer);
        fileUrl = `/api/chat/files/${encodeURIComponent(saved.storageKey)}`;
      }

      if (!previewContent) {
        previewContent = isImg ? `📷 ${fileName}` : `📎 ${fileName}`;
      }
    }

    if (!previewContent && !fileUrl) {
      throw new Error('Message cannot be empty.');
    }

    await this.db.run(`
      INSERT INTO connect_chat_messages (
        id, conversation_id, sender_employee_id, sender_user_id,
        message_type, content, file_url, file_name, file_size, file_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [msgId, convId, empId, senderUserId || null, msgType, previewContent, fileUrl, fileName, fileSize, fileType, stamp]);

    // Update conversation last message & timestamp
    await this.db.run(`
      UPDATE connect_chat_conversations 
      SET last_message_text = ?, last_message_at = ?, updated_at = ?
      WHERE id = ?
    `, [previewContent, stamp, stamp, convId]);

    // Mark as read for sender
    await this.markAsRead(convId, empId, msgId);

    return {
      id: msgId,
      conversation_id: convId,
      sender_employee_id: empId,
      message_type: msgType,
      content: previewContent,
      file_url: fileUrl,
      file_name: fileName,
      file_size: fileSize,
      file_type: fileType,
      created_at: stamp
    };
  }

  async markAsRead(conversationId, employeeId, messageId = null) {
    const convId = conversationId;
    const empId = Number(employeeId);
    if (!convId || !empId) return;
    const stamp = nowIso();

    await this.db.run(`
      UPDATE connect_chat_members
      SET last_read_at = ?, last_read_message_id = COALESCE(?, last_read_message_id)
      WHERE conversation_id = ? AND employee_id = ?
    `, [stamp, messageId, convId, empId]);
  }

  async getUnreadSummary(employeeId) {
    const empId = Number(employeeId);
    if (!empId) return { total_unread: 0, senders: [], unread_conversations: [] };

    // Find all unread messages for this user across conversations
    const unreadRows = await this.db.all(`
      SELECT 
        m.id,
        m.conversation_id,
        m.sender_employee_id,
        m.content,
        m.message_type,
        m.created_at,
        c.type AS conv_type,
        c.title AS conv_title,
        e.first_name,
        e.last_name,
        e.employee_code
      FROM connect_chat_messages m
      JOIN connect_chat_members mem ON mem.conversation_id = m.conversation_id AND mem.employee_id = ?
      JOIN connect_chat_conversations c ON c.id = m.conversation_id
      LEFT JOIN employees e ON e.employee_id = m.sender_employee_id
      WHERE m.sender_employee_id != ?
        AND m.created_at > mem.last_read_at
      ORDER BY m.created_at DESC
      LIMIT 50
    `, [empId, empId]);

    const totalUnread = unreadRows.length;
    const sendersMap = new Map();
    const convMap = new Map();

    for (const r of unreadRows) {
      const senderName = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || `Employee #${r.sender_employee_id}`;
      if (!sendersMap.has(r.sender_employee_id)) {
        sendersMap.set(r.sender_employee_id, {
          employee_id: Number(r.sender_employee_id),
          name: senderName,
          code: r.employee_code,
          count: 0
        });
      }
      sendersMap.get(r.sender_employee_id).count++;

      if (!convMap.has(r.conversation_id)) {
        convMap.set(r.conversation_id, {
          conversation_id: r.conversation_id,
          conv_type: r.conv_type,
          title: r.conv_type === 'DIRECT' ? senderName : (r.conv_title || 'Group'),
          last_snippet: r.content,
          last_time: r.created_at,
          unread_count: 0
        });
      }
      convMap.get(r.conversation_id).unread_count++;
    }

    return {
      total_unread: totalUnread,
      senders: Array.from(sendersMap.values()),
      unread_conversations: Array.from(convMap.values())
    };
  }

  /* ================= WEBRTC CALLING ================= */

  async initiateCall({ callerEmpId, receiverEmpId, conversationId = null, callType = 'AUDIO', sdpOffer }) {
    const callerId = Number(callerEmpId);
    const receiverId = Number(receiverEmpId);
    if (!callerId || !receiverId) throw new Error('Caller and receiver IDs are required.');

    // End any lingering ringing calls between these two or by caller
    await this.db.run(`
      UPDATE connect_chat_calls
      SET status = 'ENDED', ended_at = ?
      WHERE caller_employee_id = ? AND status = 'RINGING'
    `, [nowIso(), callerId]);

    const callId = randomId();
    const stamp = nowIso();

    await this.db.run(`
      INSERT INTO connect_chat_calls (
        id, caller_employee_id, receiver_employee_id, conversation_id,
        call_type, status, sdp_offer, caller_ice, callee_ice, started_at
      ) VALUES (?, ?, ?, ?, ?, 'RINGING', ?, '[]', '[]', ?)
    `, [callId, callerId, receiverId, conversationId, callType, sdpOffer || null, stamp]);

    return {
      callId,
      callerId,
      receiverId,
      callType,
      status: 'RINGING',
      startedAt: stamp
    };
  }

  async checkIncomingCall(receiverEmpId) {
    const recId = Number(receiverEmpId);
    if (!recId) return null;

    // Auto-expire any stale calls ringing for more than 45 seconds
    const cutoff = new Date(Date.now() - 45000).toISOString();
    try {
      await this.db.run(`
        UPDATE connect_chat_calls
        SET status = 'MISSED', ended_at = ?
        WHERE status = 'RINGING' AND started_at < ?
      `, [nowIso(), cutoff]);
    } catch (e) {}

    // Check for active RINGING call for this employee
    const row = await this.db.get(`
      SELECT 
        c.*,
        e.first_name,
        e.last_name,
        e.employee_code,
        e.designation
      FROM connect_chat_calls c
      LEFT JOIN employees e ON e.employee_id = c.caller_employee_id
      WHERE c.receiver_employee_id = ?
        AND c.status = 'RINGING'
      ORDER BY c.started_at DESC
      LIMIT 1
    `, [recId]);

    if (!row) return null;

    const callerName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || `Employee #${row.caller_employee_id}`;

    return {
      callId: row.id,
      callerId: Number(row.caller_employee_id),
      callerName,
      callerCode: row.employee_code || '',
      callerDesignation: row.designation || '',
      callType: row.call_type,
      conversationId: row.conversation_id,
      sdpOffer: row.sdp_offer,
      startedAt: row.started_at
    };
  }

  async getCall(callId) {
    if (!callId) return null;
    return await this.db.get(`SELECT * FROM connect_chat_calls WHERE id = ?`, [callId]);
  }

  async respondCall({ callId, responderEmpId, action, sdpAnswer = null }) {
    const call = await this.getCall(callId);
    if (!call) throw new Error('Call session not found.');

    const stamp = nowIso();

    if (action === 'ACCEPT') {
      await this.db.run(`
        UPDATE connect_chat_calls
        SET status = 'ACCEPTED', sdp_answer = ?, connected_at = ?
        WHERE id = ?
      `, [sdpAnswer, stamp, callId]);
      return { ok: true, status: 'ACCEPTED' };
    } else if (action === 'DECLINE') {
      await this.db.run(`
        UPDATE connect_chat_calls
        SET status = 'DECLINED', ended_at = ?
        WHERE id = ?
      `, [stamp, callId]);
      return { ok: true, status: 'DECLINED' };
    } else if (action === 'BUSY') {
      await this.db.run(`
        UPDATE connect_chat_calls
        SET status = 'BUSY', ended_at = ?
        WHERE id = ?
      `, [stamp, callId]);
      return { ok: true, status: 'BUSY' };
    } else if (action === 'END') {
      await this.db.run(`
        UPDATE connect_chat_calls
        SET status = 'ENDED', ended_at = ?
        WHERE id = ?
      `, [stamp, callId]);
      return { ok: true, status: 'ENDED' };
    }

    return { ok: false, error: 'Unknown action' };
  }

  async exchangeIce({ callId, employeeId, candidate }) {
    const empId = Number(employeeId);
    const call = await this.getCall(callId);
    if (!call) throw new Error('Call not found');

    const isCaller = Number(call.caller_employee_id) === empId;
    const myField = isCaller ? 'caller_ice' : 'callee_ice';
    const peerField = isCaller ? 'callee_ice' : 'caller_ice';

    let myCandidates = [];
    try { myCandidates = JSON.parse(call[myField] || '[]'); } catch (e) {}

    if (candidate) {
      myCandidates.push(candidate);
      await this.db.run(`
        UPDATE connect_chat_calls SET ${myField} = ? WHERE id = ?
      `, [JSON.stringify(myCandidates), callId]);
    }

    let peerCandidates = [];
    try { peerCandidates = JSON.parse(call[peerField] || '[]'); } catch (e) {}

    return {
      status: call.status,
      sdpAnswer: call.sdp_answer,
      peerCandidates
    };
  }
}

module.exports = { ChatService };
