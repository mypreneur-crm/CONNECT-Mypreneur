// ==========================================================================
// Mypreneur Task Manager - Frontend Application
// Connects with CONNECT backend API (/api/tasks/*)
// Features: 9-hour capacity engine, smart duplicate search, approval gates,
//           CRM regular workload, live timers, and event workspaces.
// ==========================================================================

(function(window) {
  'use strict';

  // State Management
  const tm = {
    currentTab: 'my-work',
    tasks: [],
    myTasks: [],
    capacity: null,
    crmWorkload: null,
    teamMembers: [],
    teamCapacity: [],
    events: [],
    activeTimer: null,
    timerSeconds: 0,
    timerTickInterval: null,
    selectedTask: null,
    searchQuery: '',
    teamFilter: 'all',
    statusFilter: 'all',
    priorityFilter: 'all',
    assigneeFilter: 'all',
    filteredEmployeeCapacity: null,
    filteredEmployeeCrmWorkload: null,
    adminSelectedEmployeeId: 'self',
    adminSelectedEmployeeCapacity: null,
    adminSelectedEmployeeCrm: null,
    dupSearchTimer: null,
    stats: null
  };

  // Helper Utilities
  const $tm = id => document.getElementById(id);
  const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function isTaskAdmin() {
    if (typeof session === 'undefined' || !session) return false;
    if (session.role === 'admin') return true;
    const roles = (session.sourceRoles || []).map(r => String(r).toUpperCase());
    if (roles.some(r => r.includes('ADMIN') || r.includes('SUPER') || r.includes('SUPPORT') || r.includes('DIRECTOR') || r.includes('CEO'))) return true;
    const team = String(session.sourceTeam || session.team || '').toUpperCase();
    if (team.includes('SUPPORT') || team.includes('MANAGEMENT') || team.includes('ADMIN') || team.includes('DIRECTOR') || team.includes('CEO')) return true;
    return false;
  }

  function formatMins(mins) {
    if (!mins || isNaN(mins)) return '0m';
    const m = Math.round(mins);
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h > 0 && rem > 0) return `${h}h ${rem}m`;
    if (h > 0) return `${h}h`;
    return `${rem}m`;
  }

  function formatTimeHMS(totalSeconds) {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return [
      hrs.toString().padStart(2, '0'),
      mins.toString().padStart(2, '0'),
      secs.toString().padStart(2, '0')
    ].join(':');
  }

  function getDaysPending(dueDateStr) {
    if (!dueDateStr) return 0;
    const due = new Date(dueDateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    due.setHours(0, 0, 0, 0);
    const diff = Math.floor((today - due) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
  }

  function getTeamNameById(id) {
    const map = { 1: 'Sales', 2: 'Operations', 3: 'Accounts & HR', 4: 'Digital', 5: 'Support' };
    return map[id] || 'General';
  }

  // =========================================================================
  // Main View Shell
  // =========================================================================
  window.viewTasks = function() {
    const admin = isTaskAdmin();
    return `
    <div class="task-manager-container">
      <!-- Active Timer Floating Banner -->
      <div id="tmActiveTimerBanner" style="display:none;" class="active-timer-banner">
        <div style="display:flex;align-items:center;gap:12px;">
          <span class="timer-pulse-dot"></span>
          <div>
            <strong style="font-size:14px;color:#065F46;">Timer Active: </strong>
            <span id="tmTimerTaskTitle" style="font-size:13.5px;color:#047857;font-weight:600;"></span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:16px;">
          <div id="tmTimerClock" class="timer-clock">00:00:00</div>
          <button class="btn btn-sm" style="background:#EF4444;color:#FFF;border-radius:8px;padding:6px 14px;font-weight:700;" onclick="tmStopCurrentTimer()">
            Stop Timer
          </button>
        </div>
      </div>

      <!-- Top Header -->
      <div class="tm-head">
        <div class="tm-head-left">
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:24px;height:24px;color:var(--cyan);"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
            Task Manager
          </h2>
          <p>${admin ? 'Multi-Resource Capacity Engine, Workload Planner & Approvals' : 'My Daily Task Plan & 9-Hour Capacity Tracker'}</p>
        </div>
        <div class="tm-actions">
          <button class="btn btn-secondary" onclick="tmReloadData()" title="Refresh Tasks">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            Refresh
          </button>
          <button class="btn btn-primary" onclick="tmOpenDuplicateSearchModal()" style="background:var(--cyan);color:#0F0147;font-weight:700;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M12 5v14M5 12h14"/></svg>
            + New Task
          </button>
        </div>
      </div>

      <!-- Tab Navigation -->
      <div class="tm-tabs">
        <button class="tm-tab-btn active" id="tabBtn-my-work" onclick="tmSwitchTab('my-work')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          My Work &amp; Daily Plan
        </button>
        <button class="tm-tab-btn" id="tabBtn-board" onclick="tmSwitchTab('board')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/></svg>
          ${admin ? 'All Resources Board' : 'My Task Board'}
        </button>
        ${admin ? `
        <button class="tm-tab-btn" id="tabBtn-team-capacity" onclick="tmSwitchTab('team-capacity')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Team Workload Planner
        </button>
        ` : ''}
        <button class="tm-tab-btn" id="tabBtn-events" onclick="tmSwitchTab('events')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          Event Projects
        </button>
        ${admin ? `
        <button class="tm-tab-btn" id="tabBtn-approvals" onclick="tmSwitchTab('approvals')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Approvals
          <span class="badge-pill" id="tmApprovalCountPill" style="display:none;">0</span>
        </button>
        ` : ''}
      </div>

      <!-- Tab Content Area -->
      <div id="tmTabContent">
        <div style="padding:40px;text-align:center;color:var(--muted);">Loading Task Manager...</div>
      </div>

      <!-- Modal Injection Anchors -->
      <div id="tmModalAnchor"></div>
    </div>
    `;
  };

  // =========================================================================
  // View Initialization
  // =========================================================================
  window.initTasksView = function() {
    tmLoadAll();
    startTimerTicker();
  };

  async function tmLoadAll() {
    try {
      // 1. Fetch capacity, crm workload, and active timer
      const [capRes, crmRes, activeTimerRes, statsRes, membersRes] = await Promise.all([
        apiRequest('/api/tasks/capacity/my').catch(() => ({ data: null })),
        apiRequest('/api/tasks/crm-workload/my').catch(() => ({ data: null })),
        apiRequest('/api/tasks/timer/active').catch(() => ({ data: null })),
        apiRequest('/api/tasks/overview-stats').catch(() => ({ data: null })),
        apiRequest('/api/tasks/team-members').catch(() => ({ data: [] }))
      ]);

      tm.capacity = capRes.data;
      tm.crmWorkload = crmRes.data;
      tm.activeTimer = activeTimerRes.data;
      tm.stats = statsRes.data;
      tm.teamMembers = membersRes.data || [];

      // Update timer banner
      updateTimerBanner();

      // Update approval pill
      const pill = $tm('tmApprovalCountPill');
      if (pill && tm.stats && tm.stats.pendingApprovalsCount > 0) {
        pill.textContent = tm.stats.pendingApprovalsCount;
        pill.style.display = 'inline-block';
      } else if (pill) {
        pill.style.display = 'none';
      }

      // 2. Fetch tasks
      await tmFetchTasks();

      // 3. Render current tab
      tmRenderTab();
    } catch (e) {
      console.error('Error loading tasks data:', e);
      if ($tm('tmTabContent')) {
        $tm('tmTabContent').innerHTML = `<div style="padding:30px;background:#FFF;border-radius:12px;border:1px solid #E2E8F0;color:#EF4444;">
          <strong>Error loading task manager:</strong> ${escHtml(e.message)}
        </div>`;
      }
    }
  }

  async function tmFetchTasks() {
    const res = await apiRequest('/api/tasks');
    tm.tasks = res.data || [];
    const myEmpId = (session && (session.employeeId || session.employee_id)) || null;
    tm.myTasks = tm.tasks.filter(t => t.owner_employee_id === myEmpId);
  }

  window.tmReloadData = async function() {
    await tmLoadAll();
    toast('Task data refreshed');
  };

  window.tmSwitchTab = function(tabName) {
    tm.currentTab = tabName;
    document.querySelectorAll('.tm-tab-btn').forEach(b => b.classList.remove('active'));
    const btn = $tm(`tabBtn-${tabName}`);
    if (btn) btn.classList.add('active');
    tmRenderTab();
  };

  function tmRenderTab() {
    const container = $tm('tmTabContent');
    if (!container) return;

    if (tm.currentTab === 'my-work') {
      container.innerHTML = renderMyWorkTab();
    } else if (tm.currentTab === 'board') {
      container.innerHTML = renderBoardTab();
    } else if (tm.currentTab === 'team-capacity') {
      container.innerHTML = renderTeamCapacityTab();
      tmLoadTeamCapacity();
    } else if (tm.currentTab === 'events') {
      container.innerHTML = renderEventsTab();
      tmLoadEvents();
    } else if (tm.currentTab === 'approvals') {
      container.innerHTML = renderApprovalsTab();
    }
  }

  // =========================================================================
  // Tab 1: My Work & Daily Plan
  // =========================================================================
  function renderMyWorkTab() {
    const admin = isTaskAdmin();
    const isViewingStaff = admin && tm.adminSelectedEmployeeId && tm.adminSelectedEmployeeId !== 'self';
    const viewedMember = isViewingStaff ? tm.teamMembers.find(m => String(m.employee_id) === String(tm.adminSelectedEmployeeId)) : null;

    const cap = (isViewingStaff ? tm.adminSelectedEmployeeCapacity : tm.capacity) || {
      effectiveCapacity: 540,
      totalPlannedMinutes: 0,
      crmMinutes: 0,
      taskAllocMinutes: 0,
      actualMinutesWorked: 0,
      plannedAllocationPct: 0,
      remainingAssignableMinutes: 540,
      isOverAllocated: false
    };

    const crm = (isViewingStaff ? tm.adminSelectedEmployeeCrm : tm.crmWorkload) || { items: [], totalEstimatedMinutes: 0, actualLoggedMinutes: 0, teamName: '' };

    // Calculate percentage segments for 540-minute bar
    const totalCap = cap.effectiveCapacity || 540;
    const crmPct = Math.min(100, Math.round((cap.crmMinutes / totalCap) * 100));
    const tasksPct = Math.min(100 - crmPct, Math.round((cap.taskAllocMinutes / totalCap) * 100));
    const actualPct = Math.min(100, Math.round((cap.actualMinutesWorked / totalCap) * 100));

    // Overdue tasks count
    const targetTasks = isViewingStaff
      ? tm.tasks.filter(t => String(t.owner_employee_id) === String(tm.adminSelectedEmployeeId))
      : tm.myTasks;

    const overdueTasks = targetTasks.filter(t => t.is_overdue && t.status !== 'COMPLETED');
    const inProgressTasks = targetTasks.filter(t => t.status === 'IN_PROGRESS');
    const openTasks = targetTasks.filter(t => t.status === 'OPEN' || t.status === 'READY');

    return `
    <div style="display:flex;flex-direction:column;gap:20px;">
      <!-- Admin Staff Daily Plan & Workload Switcher -->
      ${admin ? `
      <div style="background:#FFF;border:1.5px solid var(--border);border-radius:14px;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <span style="font-size:13.5px;font-weight:700;color:var(--navy);">👤 Select Staff Daily Workload &amp; Capacity:</span>
          <select onchange="tmSelectAdminResourceView(this.value)" style="padding:7px 14px;border:1.5px solid var(--cyan);border-radius:8px;font-weight:700;background:#F0F9FF;color:var(--navy);font-size:13.5px;">
            <option value="self" ${(!tm.adminSelectedEmployeeId || tm.adminSelectedEmployeeId === 'self') ? 'selected' : ''}>
              ⭐ My Own Work Plan (Admin)
            </option>
            ${tm.teamMembers.map(m => `
              <option value="${m.employee_id}" ${String(tm.adminSelectedEmployeeId) === String(m.employee_id) ? 'selected' : ''}>
                👤 ${escHtml(m.name)} (${escHtml(m.department || 'Staff')})
              </option>
            `).join('')}
          </select>
        </div>
        ${viewedMember ? `
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="text-align:right;">
            <span style="font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;">Free Hours Available: </span>
            <strong style="font-size:15px;color:${cap.remainingAssignableMinutes > 0 ? '#059669' : '#DC2626'};">
              ${cap.remainingAssignableMinutes > 0 ? formatMins(cap.remainingAssignableMinutes) + ' Free' : '0m Free'}
            </strong>
          </div>
          <button class="btn btn-sm" onclick="tmAssignTaskToEmployee('${viewedMember.employee_id}', '${escHtml(viewedMember.name)}', ${viewedMember.team_id || 2}, ${cap.remainingAssignableMinutes})" style="background:var(--cyan);color:#0F0147;font-weight:800;padding:7px 14px;border-radius:8px;display:flex;align-items:center;gap:6px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:15px;height:15px;"><path d="M12 5v14M5 12h14"/></svg>
            + Assign Task &amp; Allocate
          </button>
        </div>
        ` : ''}
      </div>
      ` : ''}

      <!-- 9-Hour Capacity Card -->
      <div class="capacity-card">
        <div class="capacity-head">
          <div class="capacity-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${viewedMember ? escHtml(viewedMember.name) + "'s" : "Today's"} 9-Hour Capacity &amp; Utilization
          </div>
          <span class="capacity-badge ${cap.isOverAllocated ? 'over-allocated' : ''}">
            ${cap.isOverAllocated ? '⚠️ Over-Allocated (' + cap.plannedAllocationPct + '%)' : cap.plannedAllocationPct + '% Planned (' + formatMins(cap.totalPlannedMinutes) + ' / 9h)'}
          </span>
        </div>

        <div class="capacity-bar-wrap">
          <div class="cap-seg-crm" style="width:${crmPct}%;" title="CRM Regular Workload: ${formatMins(cap.crmMinutes)}"></div>
          <div class="cap-seg-tasks" style="width:${tasksPct}%;" title="Assigned Tasks: ${formatMins(cap.taskAllocMinutes)}"></div>
        </div>

        <div class="capacity-stats-grid">
          <div class="cap-stat-item">
            <span class="cap-stat-label">Total Daily Baseline</span>
            <span class="cap-stat-value">9h 00m</span>
          </div>
          <div class="cap-stat-item">
            <span class="cap-stat-label">CRM Workload</span>
            <span class="cap-stat-value" style="color:var(--cyan);">${formatMins(cap.crmMinutes)}</span>
          </div>
          <div class="cap-stat-item">
            <span class="cap-stat-label">Assigned Tasks</span>
            <span class="cap-stat-value" style="color:#A5B4FC;">${formatMins(cap.taskAllocMinutes)}</span>
          </div>
          <div class="cap-stat-item">
            <span class="cap-stat-label">Actual Logged</span>
            <span class="cap-stat-value" style="color:#34D399;">${formatMins(cap.actualMinutesWorked)}</span>
          </div>
          <div class="cap-stat-item">
            <span class="cap-stat-label">Remaining Free</span>
            <span class="cap-stat-value" style="color:${cap.remainingAssignableMinutes > 0 ? '#38B6FF' : '#F87171'};font-weight:700;">
              ${formatMins(cap.remainingAssignableMinutes)}
            </span>
          </div>
        </div>
      </div>

      <!-- Overdue Red Alert Banner (if any) -->
      ${overdueTasks.length > 0 ? `
      <div style="background:#FEF2F2;border:1.5px solid #F87171;border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:14px;">
        <span style="font-size:22px;">🚨</span>
        <div style="flex:1;">
          <strong style="color:#991B1B;font-size:14px;">Action Required: ${viewedMember ? escHtml(viewedMember.name) + ' has' : 'You have'} ${overdueTasks.length} overdue task(s)!</strong>
          <p style="color:#B91C1C;font-size:13px;margin:2px 0 0 0;">These tasks have passed their target completion timeframe. Please update their progress or complete them immediately.</p>
        </div>
        <button class="btn btn-sm" style="background:#EF4444;color:#FFF;border-radius:8px;font-weight:700;" onclick="tmFilterOverdue()">
          View Overdue
        </button>
      </div>` : ''}

      <!-- CRM Regular Workload Section -->
      ${renderCrmWorkloadSection(crm)}

      <!-- Active & Open Tasks List -->
      <div class="card" style="padding:22px;background:#FFF;border-radius:16px;border:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
          <h3 style="font-size:16px;font-weight:700;color:var(--navy);display:flex;align-items:center;gap:8px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;color:var(--cyan);"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            ${viewedMember ? escHtml(viewedMember.name) + "'s Tasks" : "My Assigned Tasks"} (${targetTasks.length})
          </h3>
          <div style="font-size:13px;color:var(--muted);">
            In Progress: <strong>${inProgressTasks.length}</strong> · Open: <strong>${openTasks.length}</strong>
          </div>
        </div>

        ${targetTasks.length === 0 ? `
          <div style="text-align:center;padding:36px;color:var(--muted);">
            <div style="font-size:32px;margin-bottom:8px;">☕</div>
            <p style="font-weight:600;font-size:14.5px;">No tasks currently assigned.</p>
            <p style="font-size:13px;">Create a new task or check the CRM regular workload above.</p>
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${targetTasks.map(t => renderTaskListItem(t)).join('')}
          </div>
        `}
      </div>
    </div>
    `;
  }

  function renderCrmWorkloadSection(customCrm) {
    const crm = customCrm || tm.crmWorkload || { items: [], totalEstimatedMinutes: 0, actualLoggedMinutes: 0, teamName: '' };
    if (!crm.items || crm.items.length === 0) {
      return '';
    }

    const todayItems = crm.items.filter(it => it.isScheduledToday);
    const otherItems = crm.items.filter(it => !it.isScheduledToday);
    const displayItems = [...todayItems, ...otherItems];

    return `
    <div class="card" style="padding:20px;background:#F8FAFC;border-radius:16px;border:1px solid #E2E8F0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">📋</span>
          <strong style="font-size:15px;color:var(--navy);">CRM Daily Workload — ${escHtml(crm.teamName || 'Operations')}</strong>
          <span style="font-size:12px;background:#EBF7FF;color:#0284C7;padding:3px 9px;border-radius:999px;font-weight:700;">
            ${crm.items.length} active (${todayItems.length} scheduled today · ${formatMins(crm.totalEstimatedMinutes)})
          </span>
        </div>
        <div style="font-size:12.5px;color:var(--muted);">
          Today's Scheduled Effort: <strong>${formatMins(crm.totalEstimatedMinutes)}</strong> · Logged Today: <strong>${formatMins(crm.actualLoggedMinutes)}</strong>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:10px;">
        ${displayItems.slice(0, 8).map(it => `
          <div style="background:#FFF;border:1px solid ${it.isScheduledToday ? '#A7F3D0' : '#E2E8F0'};box-shadow:${it.isScheduledToday ? '0 1px 3px rgba(16,185,129,0.1)' : 'none'};border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <span style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;">${escHtml(it.source)}</span>
              ${it.isScheduledToday ? `
                <span style="font-size:11px;background:#ECFDF5;color:#047857;padding:2px 7px;border-radius:4px;font-weight:700;">📅 Call Today (30m)</span>
              ` : `
                <span style="font-size:11px;background:#F1F5F9;color:#64748B;padding:2px 7px;border-radius:4px;font-weight:600;">Call: ${escHtml(it.assignedDay || 'Assigned')}</span>
              `}
            </div>
            <strong style="font-size:13.5px;color:var(--navy);line-height:1.3;">${escHtml(it.title)}</strong>
            <div style="font-size:12px;color:var(--muted);">${escHtml(it.detail || '')}</div>
          </div>
        `).join('')}
      </div>
      ${displayItems.length > 8 ? `
        <div style="text-align:center;margin-top:10px;font-size:12.5px;color:var(--muted);">
          + ${displayItems.length - 8} more assigned CRM items
        </div>
      ` : ''}
    </div>
    `;
  }

  function renderTaskListItem(t) {
    const isOverdue = t.is_overdue && t.status !== 'COMPLETED';
    const pendingDays = getDaysPending(t.due_date);
    const isTimerRunning = tm.activeTimer && tm.activeTimer.task_id === t.id;
    const isApprovalPending = t.requires_approval && t.approval_status === 'PENDING';

    return `
    <div class="task-card ${isOverdue ? 'is-overdue' : ''}" style="margin:0;" onclick="tmOpenTaskDetails('${t.id}')">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:240px;">
          <!-- Status icon button -->
          <div style="width:34px;height:34px;border-radius:8px;background:${t.status === 'COMPLETED' ? '#ECFDF5' : '#F1F5F9'};display:flex;align-items:center;justify-content:center;color:${t.status === 'COMPLETED' ? '#10B981' : '#64748B'};">
            ${t.status === 'COMPLETED' ? '✓' : '●'}
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
              <span class="task-code">${escHtml(t.task_code)}</span>
              <span class="badge-priority ${t.priority.toLowerCase()}">${escHtml(t.priority)}</span>
              ${isOverdue ? `<span class="badge-overdue-alert">🚨 Overdue (${pendingDays}d pending)</span>` : ''}
              ${isApprovalPending ? `<span style="font-size:11px;background:#FEF3C7;color:#92400E;padding:2px 7px;border-radius:4px;font-weight:700;">Pending Approval</span>` : ''}
            </div>
            <strong style="font-size:14px;color:var(--navy);">${escHtml(t.title)}</strong>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:12px;" onclick="event.stopPropagation()">
          <div style="font-size:12.5px;color:var(--muted);text-align:right;">
            <div>⏱️ <strong>${formatMins(t.actual_minutes || 0)}</strong> / ${formatMins(t.estimated_minutes)}</div>
            <div style="font-size:11.5px;">Due: ${t.due_date ? new Date(t.due_date).toLocaleDateString() : 'None'}</div>
          </div>

          <!-- Timer Button -->
          ${isApprovalPending ? `
            <button class="btn btn-sm" disabled style="opacity:0.5;font-size:12px;" title="Cannot start timer until task is approved">
              🔒 Locked
            </button>
          ` : isTimerRunning ? `
            <button class="btn btn-sm" style="background:#EF4444;color:#FFF;border-radius:8px;font-weight:700;" onclick="tmStopTimer('${t.id}')">
              ⏹ Stop
            </button>
          ` : `
            <button class="btn btn-sm btn-secondary" style="border-radius:8px;font-weight:600;" onclick="tmStartTimer('${t.id}')">
              ▶ Start
            </button>
          `}
        </div>
      </div>
    </div>
    `;
  }

  // =========================================================================
  // Tab 2: Task Board (Kanban)
  // =========================================================================
  function renderBoardTab() {
    const admin = isTaskAdmin();
    // Filter tasks
    let filtered = tm.tasks;
    if (admin && tm.assigneeFilter !== 'all') {
      filtered = filtered.filter(t => String(t.owner_employee_id) === String(tm.assigneeFilter));
    }
    if (tm.teamFilter !== 'all') {
      filtered = filtered.filter(t => String(t.team_id) === String(tm.teamFilter));
    }
    if (tm.priorityFilter !== 'all') {
      filtered = filtered.filter(t => t.priority === tm.priorityFilter);
    }
    if (tm.searchQuery) {
      const q = tm.searchQuery.toLowerCase();
      filtered = filtered.filter(t => t.title.toLowerCase().includes(q) || t.task_code.toLowerCase().includes(q));
    }

    const colOpen = filtered.filter(t => t.status === 'OPEN' || t.status === 'READY');
    const colProgress = filtered.filter(t => t.status === 'IN_PROGRESS');
    const colReview = filtered.filter(t => t.status === 'IN_REVIEW');
    const colCompleted = filtered.filter(t => t.status === 'COMPLETED');

    return `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <!-- Filter Bar -->
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;background:#FFF;padding:14px 18px;border-radius:12px;border:1px solid var(--border);">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <input type="text" placeholder="Search tasks or code..." value="${escHtml(tm.searchQuery)}" oninput="tmSetBoardSearch(this.value)" style="padding:7px 14px;border:1px solid var(--border);border-radius:8px;width:220px;">
          
          ${admin ? `
          <!-- Resource / Staff Selector (Admin & Support Admin) -->
          <select onchange="tmSetAssigneeFilter(this.value)" style="padding:7px 12px;border:1.5px solid var(--cyan);border-radius:8px;font-weight:700;background:#F0F9FF;color:var(--navy);">
            <option value="all" ${tm.assigneeFilter === 'all' ? 'selected' : ''}>All Resources (${tm.teamMembers.length})</option>
            ${tm.teamMembers.map(m => `
              <option value="${m.employee_id}" ${String(tm.assigneeFilter) === String(m.employee_id) ? 'selected' : ''}>
                👤 ${escHtml(m.name)} (${escHtml(m.department || 'Staff')})
              </option>
            `).join('')}
          </select>
          ` : ''}

          <select onchange="tmSetTeamFilter(this.value)" style="padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-weight:500;">
            <option value="all" ${tm.teamFilter === 'all' ? 'selected' : ''}>All Teams</option>
            <option value="1" ${tm.teamFilter === '1' ? 'selected' : ''}>Sales</option>
            <option value="2" ${tm.teamFilter === '2' ? 'selected' : ''}>Operations</option>
            <option value="3" ${tm.teamFilter === '3' ? 'selected' : ''}>Accounts &amp; HR</option>
            <option value="4" ${tm.teamFilter === '4' ? 'selected' : ''}>Digital</option>
            <option value="5" ${tm.teamFilter === '5' ? 'selected' : ''}>Support</option>
          </select>

          <select onchange="tmSetPriorityFilter(this.value)" style="padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-weight:500;">
            <option value="all" ${tm.priorityFilter === 'all' ? 'selected' : ''}>All Priorities</option>
            <option value="CRITICAL" ${tm.priorityFilter === 'CRITICAL' ? 'selected' : ''}>Critical</option>
            <option value="HIGH" ${tm.priorityFilter === 'HIGH' ? 'selected' : ''}>High</option>
            <option value="NORMAL" ${tm.priorityFilter === 'NORMAL' ? 'selected' : ''}>Normal</option>
            <option value="LOW" ${tm.priorityFilter === 'LOW' ? 'selected' : ''}>Low</option>
          </select>
        </div>

        <div style="font-size:13px;color:var(--muted);">
          Showing <strong>${filtered.length}</strong> tasks ${admin && tm.assigneeFilter !== 'all' ? 'for selected resource' : ''}
        </div>
      </div>

      <!-- If Admin has selected a specific employee filter, show their Daily Workload & Free Hours Banner -->
      ${admin && tm.assigneeFilter !== 'all' ? renderFilteredEmployeeWorkloadBanner(filtered) : ''}

      <!-- Kanban Columns -->
      <div class="kanban-board">
        <!-- Open -->
        <div class="kanban-col">
          <div class="kanban-col-head">
            <span>Open &amp; Ready</span>
            <span class="badge-pill">${colOpen.length}</span>
          </div>
          ${colOpen.map(t => renderKanbanCard(t)).join('')}
        </div>

        <!-- In Progress -->
        <div class="kanban-col">
          <div class="kanban-col-head">
            <span>In Progress</span>
            <span class="badge-pill" style="background:#EBF7FF;color:#0284C7;">${colProgress.length}</span>
          </div>
          ${colProgress.map(t => renderKanbanCard(t)).join('')}
        </div>

        <!-- In Review -->
        <div class="kanban-col">
          <div class="kanban-col-head">
            <span>In Review</span>
            <span class="badge-pill" style="background:#F5F3FF;color:#7C3AED;">${colReview.length}</span>
          </div>
          ${colReview.map(t => renderKanbanCard(t)).join('')}
        </div>

        <!-- Completed -->
        <div class="kanban-col">
          <div class="kanban-col-head">
            <span>Completed</span>
            <span class="badge-pill" style="background:#ECFDF5;color:#059669;">${colCompleted.length}</span>
          </div>
          ${colCompleted.map(t => renderKanbanCard(t)).join('')}
        </div>
      </div>
    </div>
    `;
  }

  function renderKanbanCard(t) {
    const isOverdue = t.is_overdue && t.status !== 'COMPLETED';
    const pendingDays = getDaysPending(t.due_date);
    const isApprovalPending = t.requires_approval && t.approval_status === 'PENDING';

    return `
    <div class="task-card ${isOverdue ? 'is-overdue' : ''}" onclick="tmOpenTaskDetails('${t.id}')">
      <div class="task-card-header">
        <span class="task-code">${escHtml(t.task_code)}</span>
        <span class="badge-priority ${t.priority.toLowerCase()}">${escHtml(t.priority)}</span>
      </div>

      <div class="task-card-title">${escHtml(t.title)}</div>

      ${isOverdue ? `
        <div><span class="badge-overdue-alert">🚨 Overdue (${pendingDays}d pending)</span></div>
      ` : ''}

      ${isApprovalPending ? `
        <div><span style="font-size:10.5px;background:#FEF3C7;color:#92400E;padding:2px 7px;border-radius:4px;font-weight:700;">🔒 Needs Approval</span></div>
      ` : ''}

      <div class="task-card-meta">
        <span style="font-weight:600;color:var(--navy);font-size:11.5px;">${escHtml(t.owner_name || 'Unassigned')}</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <span>⏱️ ${formatMins(t.actual_minutes || 0)}/${formatMins(t.estimated_minutes)}</span>
        </div>
      </div>
    </div>
    `;
  }

  window.tmSetBoardSearch = function(val) {
    tm.searchQuery = val;
    tmRenderTab();
  };
  window.tmSetTeamFilter = function(val) {
    tm.teamFilter = val;
    tmRenderTab();
  };
  window.tmSetPriorityFilter = function(val) {
    tm.priorityFilter = val;
    tmRenderTab();
  };
  function renderFilteredEmployeeWorkloadBanner(filteredTasks) {
    const member = tm.teamMembers.find(m => String(m.employee_id) === String(tm.assigneeFilter));
    if (!member) return '';

    const cap = tm.filteredEmployeeCapacity;
    if (!cap) {
      return `
      <div style="background:#FFF;border:1.5px solid #BAE6FD;border-radius:14px;padding:16px 20px;display:flex;align-items:center;gap:12px;color:var(--muted);">
        <span class="timer-pulse-dot"></span>
        <span style="font-size:13.5px;font-weight:600;">Loading 9-hour daily workload and free hours for <strong>${escHtml(member.name)}</strong>...</span>
      </div>
      `;
    }

    const totalCap = cap.effectiveCapacity || 540;
    const crmMins = cap.crmMinutes || 0;
    const taskMins = cap.taskAllocMinutes || 0;
    const actualMins = cap.actualMinutesWorked || 0;
    const freeMins = cap.remainingAssignableMinutes || 0;
    const overMins = cap.overAllocationMinutes || 0;
    const allocPct = cap.plannedAllocationPct || 0;
    const isOver = cap.isOverAllocated;

    const crmPct = Math.min(100, Math.round((crmMins / totalCap) * 100));
    const taskPct = Math.min(100 - crmPct, Math.round((taskMins / totalCap) * 100));
    const actualPct = Math.min(100, Math.round((actualMins / totalCap) * 100));
    const freePct = Math.max(0, 100 - crmPct - taskPct);

    const crmItems = tm.filteredEmployeeCrmWorkload?.items || [];
    const crmCount = crmItems.length;
    const empTasks = (filteredTasks || tm.tasks).filter(t => String(t.owner_employee_id) === String(member.employee_id));

    return `
    <div style="background:#FFF;border:1.5px solid ${isOver ? '#FCA5A5' : '#7DD3FC'};border-radius:14px;padding:18px 22px;display:flex;flex-direction:column;gap:14px;box-shadow:0 4px 16px rgba(2, 132, 199, 0.08);">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:46px;height:46px;border-radius:12px;background:#EBF7FF;color:#0284C7;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;">
            👤
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <h3 style="font-size:16px;font-weight:800;color:var(--navy);margin:0;">${escHtml(member.name)}</h3>
              <span style="font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:6px;background:${isOver ? '#FEE2E2' : allocPct > 80 ? '#FEF3C7' : '#ECFDF5'};color:${isOver ? '#991B1B' : allocPct > 80 ? '#92400E' : '#065F46'};">
                ${isOver ? '⚠️ ' + allocPct + '% Over-Allocated' : allocPct + '% Planned Workload'}
              </span>
            </div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:2px;">
              ${escHtml(member.department || 'Staff')} · ${escHtml(member.designation || 'Team Member')} · Standard Shift: 9.0 Hours (540 mins)
            </div>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="text-align:right;padding-right:6px;">
            <div style="font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;">Free Hours Available</div>
            <div style="font-size:18px;font-weight:800;color:${freeMins > 0 ? '#059669' : '#DC2626'};">
              ${freeMins > 0 ? `🟢 ${formatMins(freeMins)} Free` : `🔴 0m (${formatMins(overMins)} Over)`}
            </div>
          </div>
          <button class="btn btn-sm" onclick="tmAssignTaskToEmployee('${member.employee_id}', '${escHtml(member.name)}', ${member.team_id || 2}, ${freeMins})" style="background:var(--cyan);color:#0F0147;font-weight:800;padding:8px 16px;border-radius:10px;display:flex;align-items:center;gap:6px;box-shadow:0 2px 10px rgba(0, 210, 255, 0.3);">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px;"><path d="M12 5v14M5 12h14"/></svg>
            + Assign &amp; Allocate Task
          </button>
          <button class="btn btn-sm btn-secondary" onclick="tmViewFullEmployeePlan('${member.employee_id}')" title="Inspect complete daily task schedule and CRM details">
            Full Plan &rarr;
          </button>
        </div>
      </div>

      <!-- 9-Hour Capacity Visual Bar -->
      <div>
        <div style="background:#E2E8F0;border-radius:7px;height:12px;overflow:hidden;display:flex;margin-bottom:6px;">
          <div style="background:#0284C7;width:${crmPct}%;" title="CRM Regular Workload: ${formatMins(crmMins)}"></div>
          <div style="background:#818CF8;width:${taskPct}%;" title="Assigned Tasks: ${formatMins(taskMins)}"></div>
          <div style="background:#10B981;width:${actualPct}%;" title="Actual Worked: ${formatMins(actualMins)}"></div>
          <div style="background:#F1F5F9;width:${freePct}%;" title="Remaining Free: ${formatMins(freeMins)}"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--muted);">
          <span>0h</span>
          <span style="color:#0284C7;font-weight:600;">■ CRM: ${formatMins(crmMins)}</span>
          <span style="color:#6366F1;font-weight:600;">■ Tasks: ${formatMins(taskMins)}</span>
          <span style="color:#059669;font-weight:600;">■ Worked: ${formatMins(actualMins)}</span>
          <span style="color:${freeMins > 0 ? '#059669' : '#DC2626'};font-weight:700;">■ Free: ${formatMins(freeMins)}</span>
          <span>9h (540m)</span>
        </div>
      </div>

      <!-- Quick Metrics Summary -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;font-size:12px;">
        <div style="background:#F8FAFC;padding:10px 14px;border-radius:10px;border:1px solid #E2E8F0;">
          <span style="color:var(--muted);display:block;font-size:11px;">CRM Daily Workload</span>
          <strong style="color:#0284C7;font-size:14px;">${formatMins(crmMins)}</strong>
          <span style="color:var(--muted);font-size:11px;display:block;">${crmCount} active CRM items</span>
        </div>
        <div style="background:#F8FAFC;padding:10px 14px;border-radius:10px;border:1px solid #E2E8F0;">
          <span style="color:var(--muted);display:block;font-size:11px;">Assigned Tasks</span>
          <strong style="color:#6366F1;font-size:14px;">${formatMins(taskMins)}</strong>
          <span style="color:var(--muted);font-size:11px;display:block;">${empTasks.length} tasks allocated</span>
        </div>
        <div style="background:#F8FAFC;padding:10px 14px;border-radius:10px;border:1px solid #E2E8F0;">
          <span style="color:var(--muted);display:block;font-size:11px;">Total Planned Load</span>
          <strong style="color:var(--navy);font-size:14px;">${formatMins(cap.totalPlannedMinutes)}</strong>
          <span style="color:var(--muted);font-size:11px;display:block;">${allocPct}% of 9.0h baseline</span>
        </div>
        <div style="background:#F8FAFC;padding:10px 14px;border-radius:10px;border:1px solid #E2E8F0;">
          <span style="color:var(--muted);display:block;font-size:11px;">Actual Logged Time</span>
          <strong style="color:#059669;font-size:14px;">${formatMins(actualMins)}</strong>
          <span style="color:var(--muted);font-size:11px;display:block;">${cap.actualUtilizationPct}% utilized</span>
        </div>
        <div style="background:${freeMins > 0 ? '#ECFDF5' : '#FEF2F2'};padding:10px 14px;border-radius:10px;border:1px solid ${freeMins > 0 ? '#A7F3D0' : '#FECACA'};">
          <span style="color:${freeMins > 0 ? '#065F46' : '#991B1B'};display:block;font-size:11px;font-weight:700;">Remaining Free Hours</span>
          <strong style="color:${freeMins > 0 ? '#047857' : '#DC2626'};font-size:15px;">${formatMins(freeMins)}</strong>
          <span style="color:${freeMins > 0 ? '#065F46' : '#991B1B'};font-size:11px;display:block;">Available to allocate</span>
        </div>
      </div>
    </div>
    `;
  }

  window.tmSetAssigneeFilter = async function(val) {
    tm.assigneeFilter = val;
    tm.filteredEmployeeCapacity = null;
    tm.filteredEmployeeCrmWorkload = null;
    tmRenderTab();
    if (val !== 'all') {
      const empId = parseInt(val, 10);
      try {
        const [capRes, crmRes] = await Promise.all([
          apiRequest(`/api/tasks/capacity/employee?employeeId=${empId}`).catch(() => ({ data: null })),
          apiRequest(`/api/tasks/crm-workload/employee?employeeId=${empId}`).catch(() => ({ data: null }))
        ]);
        tm.filteredEmployeeCapacity = capRes.data;
        tm.filteredEmployeeCrmWorkload = crmRes.data;
        tmRenderTab();
      } catch (e) {
        console.error('Error fetching employee capacity for filter:', e);
      }
    }
  };

  window.tmViewResourceTasks = async function(empId) {
    tm.assigneeFilter = String(empId);
    tm.filteredEmployeeCapacity = null;
    tm.filteredEmployeeCrmWorkload = null;
    tmSwitchTab('board');
    try {
      const [capRes, crmRes] = await Promise.all([
        apiRequest(`/api/tasks/capacity/employee?employeeId=${empId}`).catch(() => ({ data: null })),
        apiRequest(`/api/tasks/crm-workload/employee?employeeId=${empId}`).catch(() => ({ data: null }))
      ]);
      tm.filteredEmployeeCapacity = capRes.data;
      tm.filteredEmployeeCrmWorkload = crmRes.data;
      tmRenderTab();
    } catch (e) {}
  };

  window.tmAssignTaskToEmployee = function(empId, empName, teamId, freeMins) {
    const suggestedMins = freeMins && freeMins > 0 ? Math.min(120, Math.max(30, freeMins)) : 60;
    const freeText = freeMins && freeMins > 0 ? `${formatMins(freeMins)} free available today` : '0m free (Currently over-allocated)';
    tmOpenTaskFormModal({
      owner_employee_id: empId,
      team_id: teamId || 2,
      est_minutes: suggestedMins,
      allocHint: `Direct Allocation for <strong>${escHtml(empName)}</strong>. Remaining capacity today: <strong>${freeText}</strong>.`
    });
  };

  window.tmViewFullEmployeePlan = async function(empId) {
    await tmSelectAdminResourceView(String(empId));
    tmSwitchTab('my-work');
  };

  window.tmSelectAdminResourceView = async function(val) {
    tm.adminSelectedEmployeeId = val;
    if (val && val !== 'self') {
      const empId = parseInt(val, 10);
      try {
        const [capRes, crmRes] = await Promise.all([
          apiRequest(`/api/tasks/capacity/employee?employeeId=${empId}`).catch(() => ({ data: null })),
          apiRequest(`/api/tasks/crm-workload/employee?employeeId=${empId}`).catch(() => ({ data: null }))
        ]);
        tm.adminSelectedEmployeeCapacity = capRes.data;
        tm.adminSelectedEmployeeCrm = crmRes.data;
      } catch (e) {
        console.error(e);
      }
    } else {
      tm.adminSelectedEmployeeCapacity = null;
      tm.adminSelectedEmployeeCrm = null;
    }
    tmRenderTab();
  };

  window.tmFilterOverdue = function() {
    tmSwitchTab('board');
    tm.searchQuery = '';
    tmRenderTab();
  };

  // =========================================================================
  // Tab 3: Team Workload Planner (540-minute Capacity)
  // =========================================================================
  function renderTeamCapacityTab() {
    if (!isTaskAdmin()) {
      return `
      <div class="card" style="padding:48px 24px;text-align:center;background:#FFF;border-radius:16px;border:1px solid var(--border);">
        <div style="font-size:40px;margin-bottom:12px;">🔒</div>
        <h3 style="font-size:17px;font-weight:700;color:var(--navy);">Access Restricted</h3>
        <p style="font-size:13.5px;color:var(--muted);max-width:480px;margin:6px auto 0 auto;">
          The Team Workload Matrix and multi-resource capacity details are accessible to Administrators and Support Managers.
        </p>
      </div>`;
    }

    return `
    <div style="display:flex;flex-direction:column;gap:18px;">
      <div style="background:#FFF;padding:18px 24px;border-radius:14px;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <h3 style="font-size:16px;font-weight:700;color:var(--navy);">Team 9-Hour Capacity &amp; Availability Matrix</h3>
          <p style="font-size:13px;color:var(--muted);margin:2px 0 0 0;">
            Check employee workload and availability before assigning new tasks. Standard 540 minutes / 9 hours per day.
          </p>
        </div>
        <div>
          <input type="date" id="tmCapDateInput" value="${new Date().toISOString().split('T')[0]}" onchange="tmLoadTeamCapacity(this.value)" style="padding:6px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;">
        </div>
      </div>

      <div id="tmTeamCapacityGrid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:14px;">
        <div style="padding:30px;color:var(--muted);text-align:center;grid-column:1/-1;">Loading team capacity...</div>
      </div>
    </div>
    `;
  }

  async function tmLoadTeamCapacity(dateStr) {
    const container = $tm('tmTeamCapacityGrid');
    if (!container) return;
    try {
      const url = '/api/tasks/team-capacity' + (dateStr ? `?date=${dateStr}` : '');
      const res = await apiRequest(url);
      tm.teamCapacity = res.data || [];

      if (tm.teamCapacity.length === 0) {
        container.innerHTML = `<div style="padding:30px;text-align:center;grid-column:1/-1;color:var(--muted);">No team members found.</div>`;
        return;
      }

      container.innerHTML = tm.teamCapacity.map(m => {
        const c = m.capacity || { effectiveCapacity: 540, plannedAllocationPct: 0, crmMinutes: 0, taskAllocMinutes: 0, remainingAssignableMinutes: 540, isOverAllocated: false };
        const total = c.effectiveCapacity || 540;
        const crmPct = Math.min(100, Math.round((c.crmMinutes / total) * 100));
        const taskPct = Math.min(100 - crmPct, Math.round((c.taskAllocMinutes / total) * 100));

        return `
        <div class="card" style="padding:16px 18px;background:#FFF;border-radius:14px;border:1px solid var(--border);display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <strong style="font-size:14.5px;color:var(--navy);display:block;">${escHtml(m.name)}</strong>
              <span style="font-size:12px;color:var(--muted);">${escHtml(m.department || 'General')} · ${escHtml(m.designation || 'Staff')}</span>
            </div>
            <span style="font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:999px;background:${c.isOverAllocated ? '#FEE2E2' : c.plannedAllocationPct > 80 ? '#FEF3C7' : '#ECFDF5'};color:${c.isOverAllocated ? '#991B1B' : c.plannedAllocationPct > 80 ? '#92400E' : '#065F46'};">
              ${c.isOverAllocated ? '⚠️ ' + c.plannedAllocationPct + '% Over' : c.plannedAllocationPct + '% Utilized'}
            </span>
          </div>

          <!-- Capacity Bar -->
          <div style="background:#E2E8F0;border-radius:6px;height:10px;overflow:hidden;display:flex;">
            <div style="background:var(--cyan);width:${crmPct}%;" title="CRM: ${formatMins(c.crmMinutes)}"></div>
            <div style="background:#818CF8;width:${taskPct}%;" title="Tasks: ${formatMins(c.taskAllocMinutes)}"></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);border-top:1px solid #F1F5F9;padding-top:8px;">
            <span>CRM: <strong>${formatMins(c.crmMinutes)}</strong></span>
            <span>Tasks: <strong>${formatMins(c.taskAllocMinutes)}</strong></span>
            <span style="color:${c.remainingAssignableMinutes > 0 ? '#10B981' : '#EF4444'};font-weight:700;">
              Free: ${formatMins(c.remainingAssignableMinutes)}
            </span>
          </div>

          <button class="btn btn-sm" style="width:100%;font-weight:700;background:#EBF7FF;color:#0284C7;border:1px solid #BAE6FD;border-radius:8px;padding:6px 10px;margin-top:2px;" onclick="tmViewResourceTasks('${m.employee_id}')">
            View Resource Tasks &rarr;
          </button>
        </div>
        `;
      }).join('');
    } catch (e) {
      console.error('Error loading team capacity:', e);
      if (container) container.innerHTML = `<div style="color:#EF4444;grid-column:1/-1;">Failed to load team capacity.</div>`;
    }
  }

  // =========================================================================
  // Tab 4: Event Projects (Webinar, Academy, FGS, FGC)
  // =========================================================================
  function renderEventsTab() {
    return `
    <div style="display:flex;flex-direction:column;gap:18px;">
      <div style="background:#FFF;padding:18px 24px;border-radius:14px;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <h3 style="font-size:16px;font-weight:700;color:var(--navy);">Event Project Workspaces</h3>
          <p style="font-size:13px;color:var(--muted);margin:2px 0 0 0;">
            Multi-team parallel allocations for FGS, FGC, Webinars, and Academy sessions.
          </p>
        </div>
        <button class="btn btn-primary" onclick="tmOpenCreateEventModal()" style="background:var(--navy);color:#FFF;">
          + New Event Project
        </button>
      </div>

      <div id="tmEventsGrid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(340px, 1fr));gap:16px;">
        <div style="padding:30px;color:var(--muted);text-align:center;grid-column:1/-1;">Loading events...</div>
      </div>
    </div>
    `;
  }

  async function tmLoadEvents() {
    const container = $tm('tmEventsGrid');
    if (!container) return;
    try {
      const res = await apiRequest('/api/tasks/events');
      tm.events = res.data || [];

      if (tm.events.length === 0) {
        container.innerHTML = `<div style="padding:40px;text-align:center;grid-column:1/-1;color:var(--muted);">No event project workspaces found. Click "+ New Event Project" to create one.</div>`;
        return;
      }

      container.innerHTML = tm.events.map(ev => {
        const total = ev.total_tasks || 0;
        const comp = ev.completed_tasks || 0;
        const pct = total > 0 ? Math.round((comp / total) * 100) : 0;

        return `
        <div class="card" style="padding:20px;background:#FFF;border-radius:16px;border:1px solid var(--border);display:flex;flex-direction:column;gap:14px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <span style="font-size:11px;background:#EBF7FF;color:#0284C7;padding:3px 8px;border-radius:4px;font-weight:700;text-transform:uppercase;">
                ${escHtml(ev.event_type)}
              </span>
              <strong style="font-size:15px;color:var(--navy);display:block;margin-top:6px;">${escHtml(ev.name)}</strong>
            </div>
            <span style="font-size:12px;font-weight:700;color:var(--muted);">${pct}% Done</span>
          </div>

          <!-- Progress Bar -->
          <div style="background:#F1F5F9;border-radius:6px;height:8px;overflow:hidden;">
            <div style="background:#10B981;width:${pct}%;height:100%;"></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--muted);">
            <span>Date: <strong>${ev.start_date ? new Date(ev.start_date).toLocaleDateString() : 'TBD'}</strong></span>
            <span>Tasks: <strong>${comp} / ${total}</strong></span>
          </div>

          <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:4px;" onclick="tmViewEventTasks('${ev.id}')">
            View Workstreams &amp; Tasks
          </button>
        </div>
        `;
      }).join('');
    } catch (e) {
      console.error('Error loading events:', e);
      if (container) container.innerHTML = `<div style="color:#EF4444;grid-column:1/-1;">Failed to load events.</div>`;
    }
  }

  window.tmViewEventTasks = function(eventId) {
    tmSwitchTab('board');
    // Filter tasks by event
    let filtered = tm.tasks.filter(t => t.event_id === eventId);
    toast(`Filtered to event tasks (${filtered.length})`);
  };

  // =========================================================================
  // Tab 5: Approvals Inbox
  // =========================================================================
  function renderApprovalsTab() {
    if (!isTaskAdmin()) {
      return `
      <div class="card" style="padding:48px 24px;text-align:center;background:#FFF;border-radius:16px;border:1px solid var(--border);">
        <div style="font-size:40px;margin-bottom:12px;">🔒</div>
        <h3 style="font-size:17px;font-weight:700;color:var(--navy);">Access Restricted</h3>
        <p style="font-size:13.5px;color:var(--muted);max-width:480px;margin:6px auto 0 auto;">
          The global Approvals Queue is managed by Administrators and Team Managers.
        </p>
      </div>`;
    }

    const pendingTasks = tm.tasks.filter(t => t.requires_approval && t.approval_status === 'PENDING');

    return `
    <div style="display:flex;flex-direction:column;gap:18px;">
      <div style="background:#FFF;padding:18px 24px;border-radius:14px;border:1px solid var(--border);">
        <h3 style="font-size:16px;font-weight:700;color:var(--navy);">Approval Requests Queue</h3>
        <p style="font-size:13px;color:var(--muted);margin:2px 0 0 0;">
          Tasks marked with required approvals remain strictly blocked from timer tracking and execution until approved.
        </p>
      </div>

      <div class="card" style="padding:20px;background:#FFF;border-radius:16px;border:1px solid var(--border);">
        ${pendingTasks.length === 0 ? `
          <div style="text-align:center;padding:40px;color:var(--muted);">
            <div style="font-size:32px;margin-bottom:8px;">✅</div>
            <strong style="font-size:14.5px;">All caught up!</strong>
            <p style="font-size:13px;margin-top:2px;">There are no tasks currently awaiting managerial approval.</p>
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:12px;">
            ${pendingTasks.map(t => `
              <div style="border:1px solid #E2E8F0;border-radius:12px;padding:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px;background:#FFFDF7;">
                <div style="flex:1;min-width:260px;">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <span class="task-code">${escHtml(t.task_code)}</span>
                    <span style="font-size:11px;background:#FEF3C7;color:#92400E;padding:2px 7px;border-radius:4px;font-weight:700;">Awaiting Approval</span>
                    <span class="badge-priority ${t.priority.toLowerCase()}">${escHtml(t.priority)}</span>
                  </div>
                  <strong style="font-size:15px;color:var(--navy);">${escHtml(t.title)}</strong>
                  <div style="font-size:12.5px;color:var(--muted);margin-top:4px;">
                    Requested by: <strong>${escHtml(t.created_by_name || 'Staff')}</strong> · Team: <strong>${getTeamNameById(t.team_id)}</strong> · Est: <strong>${formatMins(t.estimated_minutes)}</strong>
                  </div>
                </div>

                <div style="display:flex;align-items:center;gap:10px;">
                  <button class="btn btn-sm btn-secondary" onclick="tmOpenTaskDetails('${t.id}')">
                    Inspect
                  </button>
                  <button class="btn btn-sm" style="background:#EF4444;color:#FFF;border-radius:8px;font-weight:700;" onclick="tmSubmitApproval('${t.id}', 'REJECTED')">
                    Reject
                  </button>
                  <button class="btn btn-sm" style="background:#10B981;color:#FFF;border-radius:8px;font-weight:700;" onclick="tmSubmitApproval('${t.id}', 'APPROVED')">
                    ✓ Approve
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>
    `;
  }

  window.tmSubmitApproval = async function(taskId, decision) {
    const notes = prompt(`Enter ${decision.toLowerCase()} notes (optional):`);
    if (notes === null) return; // User cancelled prompt
    try {
      await apiRequest(`/api/tasks/${taskId}/approval`, {
        method: 'POST',
        body: { decision, notes }
      });
      toast(`Task ${decision.toLowerCase()} successfully`);
      await tmLoadAll();
    } catch (e) {
      alert(`Approval error: ${e.message}`);
    }
  };

  // =========================================================================
  // Smart Duplicate Search Modal (Prompt Requirement)
  // =========================================================================
  window.tmOpenDuplicateSearchModal = function() {
    const anchor = $tm('tmModalAnchor');
    anchor.innerHTML = `
    <div class="dup-modal-overlay" id="tmDupModal">
      <div class="dup-modal-box">
        <div class="dup-modal-head">
          <div style="display:flex;align-items:center;gap:10px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;color:var(--cyan);"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
            <h3 style="font-size:16px;font-weight:700;color:var(--navy);margin:0;">Create Task — Check Existing Work</h3>
          </div>
          <button class="btn" onclick="tmCloseModal('tmDupModal')" style="font-size:20px;color:var(--muted);">&times;</button>
        </div>

        <div class="dup-modal-body">
          <p style="font-size:13.5px;color:var(--muted);margin:0;">
            Type your task title below. We'll search for open and in-progress tasks to prevent duplicate efforts.
          </p>

          <input type="text" id="tmDupInput" class="dup-search-input" placeholder="Type task title or keyword (e.g., 'Webinar setup', 'Onboarding call')..." oninput="tmOnDupSearchInput(this.value)">

          <div id="tmDupResultsContainer" style="display:none;flex-direction:column;gap:8px;">
            <div style="font-size:12.5px;font-weight:700;color:var(--navy);">Matching Open Tasks Found:</div>
            <div class="dup-results-list" id="tmDupResultsList"></div>
          </div>
        </div>

        <div class="dup-actions-bar">
          <button class="btn btn-secondary" onclick="tmCloseModal('tmDupModal')">Cancel</button>
          <button class="btn btn-primary" style="background:var(--navy);color:#FFF;" onclick="tmProceedToCreateTask()">
            Create Separate Task &rarr;
          </button>
        </div>
      </div>
    </div>
    `;

    setTimeout(() => {
      const inp = $tm('tmDupInput');
      if (inp) inp.focus();
    }, 100);
  };

  window.tmOnDupSearchInput = function(val) {
    clearTimeout(tm.dupSearchTimer);
    if (!val || val.trim().length < 2) {
      $tm('tmDupResultsContainer').style.display = 'none';
      return;
    }

    tm.dupSearchTimer = setTimeout(async () => {
      try {
        const res = await apiRequest(`/api/tasks/search-duplicates?q=${encodeURIComponent(val)}`);
        const list = res.data || [];
        const container = $tm('tmDupResultsContainer');
        const listEl = $tm('tmDupResultsList');

        if (list.length > 0) {
          container.style.display = 'flex';
          listEl.innerHTML = list.map(item => `
            <div class="dup-hit-item">
              <div>
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
                  <span class="task-code">${escHtml(item.task_code)}</span>
                  <span style="font-size:10px;background:#EBF7FF;color:#0284C7;padding:2px 6px;border-radius:4px;font-weight:700;">${getTeamNameById(item.team_id)}</span>
                  <span style="font-size:10px;background:#F1F5F9;color:#475569;padding:2px 6px;border-radius:4px;font-weight:700;">${escHtml(item.status)}</span>
                </div>
                <strong style="font-size:13.5px;color:var(--navy);">${escHtml(item.title)}</strong>
                <div style="font-size:11.5px;color:var(--muted);">Assignee: ${escHtml(item.owner_name || 'Unassigned')}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <button class="btn btn-sm btn-secondary" onclick="tmSelectExistingTask('${item.id}')" title="Open this existing task">
                  Open Existing
                </button>
                <button class="btn btn-sm" style="background:var(--cyan);color:#0F0147;font-weight:700;" onclick="tmAddSubtaskToParent('${item.id}', '${escHtml(item.title)}')">
                  + Add Subtask
                </button>
              </div>
            </div>
          `).join('');
        } else {
          container.style.display = 'none';
        }
      } catch (e) {
        console.error('Error in duplicate search:', e);
      }
    }, 280);
  };

  window.tmSelectExistingTask = function(taskId) {
    tmCloseModal('tmDupModal');
    tmOpenTaskDetails(taskId);
  };

  window.tmAddSubtaskToParent = function(parentId, parentTitle) {
    tmCloseModal('tmDupModal');
    tmOpenTaskFormModal({
      parent_task_id: parentId,
      parentTitle: parentTitle,
      title: ''
    });
  };

  window.tmProceedToCreateTask = function() {
    const inputVal = $tm('tmDupInput') ? $tm('tmDupInput').value.trim() : '';
    tmCloseModal('tmDupModal');
    tmOpenTaskFormModal({ title: inputVal });
  };

  // =========================================================================
  // Task Creation & Editing Modal
  // =========================================================================
  window.tmOpenTaskFormModal = function(defaults = {}) {
    const anchor = $tm('tmModalAnchor');
    const myEmpId = (session && (session.employeeId || session.employee_id)) || null;
    const admin = isTaskAdmin();
    const targetOwnerId = defaults.owner_employee_id != null ? Number(defaults.owner_employee_id) : myEmpId;
    const targetTeamId = defaults.team_id != null ? Number(defaults.team_id) : 2;
    const targetEstMins = defaults.est_minutes != null ? Number(defaults.est_minutes) : 60;

    anchor.innerHTML = `
    <div class="dup-modal-overlay" id="tmFormModal">
      <div class="dup-modal-box" style="max-width:620px;">
        <div class="dup-modal-head">
          <h3 style="font-size:16px;font-weight:700;color:var(--navy);margin:0;">
            ${defaults.parent_task_id ? 'Add Subtask to ' + escHtml(defaults.parentTitle || 'Parent Task') : (defaults.id ? 'Edit Task' : 'Create New Task')}
          </h3>
          <button class="btn" onclick="tmCloseModal('tmFormModal')" style="font-size:20px;color:var(--muted);">&times;</button>
        </div>

        <form id="tmNewTaskForm" onsubmit="tmHandleTaskFormSubmit(event)" class="dup-modal-body" style="gap:14px;">
          <input type="hidden" id="tf_id" value="${defaults.id || ''}">
          <input type="hidden" id="tf_parent_id" value="${defaults.parent_task_id || ''}">

          ${defaults.allocHint ? `
            <div style="background:#EFF6FF;border:1.5px solid #BFDBFE;border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;font-size:13px;color:#1E40AF;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
              <div>${defaults.allocHint}</div>
            </div>
          ` : ''}

          <div>
            <label style="display:block;font-size:12.5px;font-weight:700;color:var(--navy);margin-bottom:4px;">Task Title *</label>
            <input type="text" id="tf_title" required class="dup-search-input" style="padding:9px 14px;font-size:14px;" value="${escHtml(defaults.title || '')}" placeholder="What needs to be done?">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
              <label style="display:block;font-size:12.5px;font-weight:700;color:var(--navy);margin-bottom:4px;">Target Team *</label>
              <select id="tf_team_id" required style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:10px;">
                <option value="1" ${targetTeamId === 1 ? 'selected' : ''}>Sales Team</option>
                <option value="2" ${targetTeamId === 2 ? 'selected' : ''}>Operations Team</option>
                <option value="3" ${targetTeamId === 3 ? 'selected' : ''}>Accounts &amp; HR Team</option>
                <option value="4" ${targetTeamId === 4 ? 'selected' : ''}>Digital Team</option>
                <option value="5" ${targetTeamId === 5 ? 'selected' : ''}>Support (Admin / CEO)</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:12.5px;font-weight:700;color:var(--navy);margin-bottom:4px;">Assignee</label>
              ${admin ? `
              <select id="tf_owner_id" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:10px;">
                <option value="">— Assign to Staff —</option>
                ${tm.teamMembers.map(m => `
                  <option value="${m.employee_id}" ${Number(m.employee_id) === targetOwnerId ? 'selected' : ''}>
                    ${escHtml(m.name)} (${escHtml(m.department || 'Staff')})
                  </option>
                `).join('')}
              </select>
              ` : `
              <select id="tf_owner_id" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:#F8FAFC;" disabled>
                <option value="${myEmpId}" selected>${escHtml(session?.name || 'You')} (Self)</option>
              </select>
              `}
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
            <div>
              <label style="display:block;font-size:12.5px;font-weight:700;color:var(--navy);margin-bottom:4px;">Priority</label>
              <select id="tf_priority" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:10px;">
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical (Urgent)</option>
                <option value="LOW">Low</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:12.5px;font-weight:700;color:var(--navy);margin-bottom:4px;">Est. Time (Mins) *</label>
              <input type="number" id="tf_est_mins" required min="5" step="5" value="${targetEstMins}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:10px;">
            </div>
            <div>
              <label style="display:block;font-size:12.5px;font-weight:700;color:var(--navy);margin-bottom:4px;">Due Date</label>
              <input type="date" id="tf_due_date" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:10px;">
            </div>
          </div>

          <div>
            <label style="display:block;font-size:12.5px;font-weight:700;color:var(--navy);margin-bottom:4px;">Description / Instructions</label>
            <textarea id="tf_description" rows="3" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:10px;font-size:13.5px;" placeholder="Add any details, checklists or requirements..."></textarea>
          </div>

          <!-- Approval Gate Toggle -->
          <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:12px 14px;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input type="checkbox" id="tf_requires_approval" style="width:16px;height:16px;">
              <span style="font-size:13px;font-weight:700;color:var(--navy);">Requires Managerial Approval</span>
            </label>
            <p style="font-size:12px;color:var(--muted);margin:4px 0 0 26px;">
              If checked, this task cannot be worked on or have its timer started until authorized by a manager.
            </p>
          </div>

          <div class="dup-actions-bar" style="margin:8px -24px -24px -24px;">
            <button type="button" class="btn btn-secondary" onclick="tmCloseModal('tmFormModal')">Cancel</button>
            <button type="submit" class="btn btn-primary" style="background:var(--cyan);color:#0F0147;font-weight:700;">
              Save &amp; Allocate Task
            </button>
          </div>
        </form>
      </div>
    </div>
    `;
  };

  window.tmHandleTaskFormSubmit = async function(e) {
    e.preventDefault();
    const myEmpId = (session && (session.employeeId || session.employee_id)) || null;
    const ownerEl = $tm('tf_owner_id');
    const ownerVal = (ownerEl && ownerEl.value) ? parseInt(ownerEl.value, 10) : myEmpId;

    const payload = {
      title: $tm('tf_title').value.trim(),
      team_id: parseInt($tm('tf_team_id').value, 10),
      owner_employee_id: ownerVal,
      priority: $tm('tf_priority').value,
      estimated_minutes: parseInt($tm('tf_est_mins').value, 10) || 60,
      due_date: $tm('tf_due_date').value || null,
      description: $tm('tf_description').value.trim(),
      requires_approval: $tm('tf_requires_approval').checked,
      parent_task_id: $tm('tf_parent_id').value || null
    };

    try {
      await apiRequest('/api/tasks', {
        method: 'POST',
        body: payload
      });
      tmCloseModal('tmFormModal');
      toast('Task successfully created!');
      if (tm.assigneeFilter && tm.assigneeFilter !== 'all') {
        await tmSetAssigneeFilter(tm.assigneeFilter);
      }
      if (tm.adminSelectedEmployeeId && tm.adminSelectedEmployeeId !== 'self') {
        await tmSelectAdminResourceView(tm.adminSelectedEmployeeId);
      }
      await tmLoadAll();
    } catch (err) {
      alert(`Could not create task: ${err.message}`);
    }
  };

  // =========================================================================
  // Task Details Modal / Drawer
  // =========================================================================
  window.tmOpenTaskDetails = async function(taskId) {
    try {
      const res = await apiRequest(`/api/tasks/${taskId}`);
      const t = res.data;
      tm.selectedTask = t;
      const isOverdue = t.is_overdue && t.status !== 'COMPLETED';
      const pendingDays = getDaysPending(t.due_date);
      const isTimerRunning = tm.activeTimer && tm.activeTimer.task_id === t.id;
      const isApprovalPending = t.requires_approval && t.approval_status === 'PENDING';

      const anchor = $tm('tmModalAnchor');
      anchor.innerHTML = `
      <div class="dup-modal-overlay" id="tmDetailsModal">
        <div class="dup-modal-box" style="max-width:720px;">
          <div class="dup-modal-head">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="task-code">${escHtml(t.task_code)}</span>
              <span class="badge-priority ${t.priority.toLowerCase()}">${escHtml(t.priority)}</span>
              ${isOverdue ? `<span class="badge-overdue-alert">🚨 Overdue (${pendingDays}d)</span>` : ''}
              ${isApprovalPending ? `<span style="font-size:11px;background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:4px;font-weight:700;">Pending Approval</span>` : ''}
            </div>
            <button class="btn" onclick="tmCloseModal('tmDetailsModal')" style="font-size:20px;color:var(--muted);">&times;</button>
          </div>

          <div class="dup-modal-body" style="gap:16px;">
            <h2 style="font-size:18px;font-weight:800;color:var(--navy);margin:0;">${escHtml(t.title)}</h2>

            <!-- Approval Gate Warning Banner if pending -->
            ${isApprovalPending ? `
              <div style="background:#FFFBEB;border:1.5px solid #FCD34D;border-radius:12px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <div>
                  <strong style="color:#92400E;font-size:13.5px;">Approval Required Before Execution</strong>
                  <p style="color:#B45309;font-size:12.5px;margin:2px 0 0 0;">This task is awaiting authorization. Timers and status changes are paused.</p>
                </div>
                <div style="display:flex;gap:8px;">
                  <button class="btn btn-sm" style="background:#10B981;color:#FFF;border-radius:8px;font-weight:700;" onclick="tmSubmitApproval('${t.id}', 'APPROVED')">
                    Approve Now
                  </button>
                </div>
              </div>
            ` : ''}

            <!-- Meta attributes -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;background:#F8FAFC;padding:12px 14px;border-radius:12px;border:1px solid #E2E8F0;">
              <div>
                <span style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600;">Status</span>
                <select onchange="tmChangeTaskStatus('${t.id}', this.value)" style="margin-top:2px;font-size:12.5px;font-weight:700;border:1px solid #CBD5E1;border-radius:6px;padding:3px 6px;">
                  <option value="OPEN" ${t.status === 'OPEN' ? 'selected' : ''}>Open</option>
                  <option value="IN_PROGRESS" ${t.status === 'IN_PROGRESS' ? 'selected' : ''}>In Progress</option>
                  <option value="IN_REVIEW" ${t.status === 'IN_REVIEW' ? 'selected' : ''}>In Review</option>
                  <option value="COMPLETED" ${t.status === 'COMPLETED' ? 'selected' : ''}>Completed</option>
                  <option value="BLOCKED" ${t.status === 'BLOCKED' ? 'selected' : ''}>Blocked</option>
                </select>
              </div>
              <div>
                <span style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600;">Assignee</span>
                <div style="font-size:13px;font-weight:700;color:var(--navy);margin-top:4px;">${escHtml(t.owner_name || 'Unassigned')}</div>
              </div>
              <div>
                <span style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600;">Team</span>
                <div style="font-size:13px;font-weight:700;color:var(--navy);margin-top:4px;">${getTeamNameById(t.team_id)}</div>
              </div>
              <div>
                <span style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:600;">Due Date</span>
                <div style="font-size:13px;font-weight:700;color:${isOverdue ? '#EF4444' : 'var(--navy)'};margin-top:4px;">
                  ${t.due_date ? new Date(t.due_date).toLocaleDateString() : 'None'}
                </div>
              </div>
            </div>

            <!-- Description -->
            ${t.description ? `
              <div>
                <span style="font-size:12px;font-weight:700;color:var(--navy);text-transform:uppercase;">Description</span>
                <div style="font-size:13.5px;color:#334155;background:#FFF;padding:10px 12px;border:1px solid #E2E8F0;border-radius:8px;margin-top:4px;white-space:pre-wrap;">${escHtml(t.description)}</div>
              </div>
            ` : ''}

            <!-- Time Tracking Controls -->
            <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
              <div>
                <span style="font-size:11px;text-transform:uppercase;font-weight:700;color:#166534;">Time Tracked</span>
                <div style="font-size:18px;font-weight:800;color:#14532D;margin-top:2px;">
                  ${formatMins(t.actual_minutes || 0)} <span style="font-size:13px;font-weight:500;color:#15803D;">/ ${formatMins(t.estimated_minutes)}</span>
                </div>
              </div>

              <div style="display:flex;align-items:center;gap:10px;">
                <button class="btn btn-sm btn-secondary" onclick="tmOpenManualLogModal('${t.id}')">
                  + Log Time Manually
                </button>

                ${isApprovalPending ? `
                  <button class="btn btn-sm" disabled style="opacity:0.5;">🔒 Timer Locked</button>
                ` : isTimerRunning ? `
                  <button class="btn btn-sm" style="background:#EF4444;color:#FFF;border-radius:8px;font-weight:700;" onclick="tmStopTimer('${t.id}')">
                    ⏹ Stop Timer
                  </button>
                ` : `
                  <button class="btn btn-sm" style="background:#10B981;color:#FFF;border-radius:8px;font-weight:700;" onclick="tmStartTimer('${t.id}')">
                    ▶ Start Timer
                  </button>
                `}
              </div>
            </div>

            <!-- Subtasks Section -->
            <div style="border-top:1px solid var(--border);padding-top:14px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <strong style="font-size:14px;color:var(--navy);">Subtasks (${(t.subtasks || []).length})</strong>
                <button class="btn btn-sm btn-secondary" onclick="tmAddSubtaskToParent('${t.id}', '${escHtml(t.title)}')">
                  + Add Subtask
                </button>
              </div>

              ${(t.subtasks && t.subtasks.length > 0) ? `
                <div style="display:flex;flex-direction:column;gap:8px;">
                  ${t.subtasks.map(s => `
                    <div style="border:1px solid #E2E8F0;border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;background:#FAFAFA;">
                      <div>
                        <span class="task-code">${escHtml(s.task_code)}</span>
                        <strong style="font-size:13px;color:var(--navy);margin-left:6px;">${escHtml(s.title)}</strong>
                        <div style="font-size:11.5px;color:var(--muted);">${escHtml(s.owner_name || 'Unassigned')} · ${formatMins(s.actual_minutes)} / ${formatMins(s.estimated_minutes)}</div>
                      </div>
                      <select onchange="tmChangeTaskStatus('${s.id}', this.value)" style="font-size:11px;border-radius:4px;padding:2px 4px;">
                        <option value="OPEN" ${s.status === 'OPEN' ? 'selected' : ''}>Open</option>
                        <option value="IN_PROGRESS" ${s.status === 'IN_PROGRESS' ? 'selected' : ''}>In Progress</option>
                        <option value="COMPLETED" ${s.status === 'COMPLETED' ? 'selected' : ''}>Completed</option>
                      </select>
                    </div>
                  `).join('')}
                </div>
              ` : `
                <div style="font-size:12.5px;color:var(--muted);padding:8px 0;">No subtasks created for this task yet.</div>
              `}
            </div>
          </div>
        </div>
      </div>
      `;
    } catch (e) {
      alert(`Could not load task details: ${e.message}`);
    }
  };

  window.tmChangeTaskStatus = async function(taskId, newStatus) {
    try {
      await apiRequest(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: { status: newStatus }
      });
      toast(`Status updated to ${newStatus}`);
      await tmLoadAll();
      if (tm.selectedTask && tm.selectedTask.id === taskId) {
        tmOpenTaskDetails(taskId);
      }
    } catch (e) {
      alert(`Status update error: ${e.message}`);
    }
  };

  // =========================================================================
  // Manual Time Log Modal
  // =========================================================================
  window.tmOpenManualLogModal = function(taskId) {
    const anchor = $tm('tmModalAnchor');
    anchor.innerHTML += `
    <div class="dup-modal-overlay" id="tmLogModal" style="z-index:1100;">
      <div class="dup-modal-box" style="max-width:440px;">
        <div class="dup-modal-head">
          <h3 style="font-size:15px;font-weight:700;color:var(--navy);margin:0;">Log Time Manually</h3>
          <button class="btn" onclick="tmCloseModal('tmLogModal')" style="font-size:20px;color:var(--muted);">&times;</button>
        </div>

        <div class="dup-modal-body" style="gap:12px;">
          <div>
            <label style="display:block;font-size:12px;font-weight:700;color:var(--navy);margin-bottom:4px;">Duration (Minutes) *</label>
            <input type="number" id="tlog_mins" min="1" step="5" value="30" class="dup-search-input" style="padding:8px 12px;font-size:14px;">
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:700;color:var(--navy);margin-bottom:4px;">Work Date</label>
            <input type="date" id="tlog_date" value="${new Date().toISOString().split('T')[0]}" class="dup-search-input" style="padding:8px 12px;font-size:13px;">
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:700;color:var(--navy);margin-bottom:4px;">Notes / Activity</label>
            <textarea id="tlog_notes" rows="2" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;" placeholder="What was completed during this time?"></textarea>
          </div>
        </div>

        <div class="dup-actions-bar">
          <button class="btn btn-secondary" onclick="tmCloseModal('tmLogModal')">Cancel</button>
          <button class="btn btn-primary" style="background:#10B981;color:#FFF;font-weight:700;" onclick="tmSubmitManualLog('${taskId}')">
            Submit Log
          </button>
        </div>
      </div>
    </div>
    `;
  };

  window.tmSubmitManualLog = async function(taskId) {
    const mins = parseInt($tm('tlog_mins').value, 10);
    const date = $tm('tlog_date').value;
    const notes = $tm('tlog_notes').value;

    if (!mins || mins < 1) {
      alert('Please enter valid minutes.');
      return;
    }

    try {
      await apiRequest(`/api/tasks/${taskId}/time-log`, {
        method: 'POST',
        body: { durationMinutes: mins, workDate: date, notes }
      });
      tmCloseModal('tmLogModal');
      toast(`Logged ${mins} minutes`);
      await tmLoadAll();
      if (tm.selectedTask && tm.selectedTask.id === taskId) {
        tmOpenTaskDetails(taskId);
      }
    } catch (e) {
      alert(`Error logging time: ${e.message}`);
    }
  };

  // =========================================================================
  // Timer Controls (Single Device Enforcement)
  // =========================================================================
  window.tmStartTimer = async function(taskId) {
    try {
      const res = await apiRequest(`/api/tasks/${taskId}/timer/start`, { method: 'POST' });
      toast('Timer started');
      await tmLoadAll();
      if (tm.selectedTask && tm.selectedTask.id === taskId) {
        tmOpenTaskDetails(taskId);
      }
    } catch (e) {
      alert(`Could not start timer: ${e.message}`);
    }
  };

  window.tmStopTimer = async function(taskId) {
    try {
      await apiRequest(`/api/tasks/${taskId}/timer/stop`, { method: 'POST', body: {} });
      toast('Timer stopped and time recorded');
      await tmLoadAll();
      if (tm.selectedTask && tm.selectedTask.id === taskId) {
        tmOpenTaskDetails(taskId);
      }
    } catch (e) {
      alert(`Could not stop timer: ${e.message}`);
    }
  };

  window.tmStopCurrentTimer = function() {
    if (tm.activeTimer && tm.activeTimer.task_id) {
      tmStopTimer(tm.activeTimer.task_id);
    }
  };

  function updateTimerBanner() {
    const banner = $tm('tmActiveTimerBanner');
    const titleEl = $tm('tmTimerTaskTitle');
    if (!banner || !titleEl) return;

    if (tm.activeTimer) {
      banner.style.display = 'flex';
      titleEl.textContent = tm.activeTimer.task_title || tm.activeTimer.task_code || 'Task In Progress';
      const startMs = new Date(tm.activeTimer.start_time).getTime();
      const nowMs = Date.now();
      tm.timerSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    } else {
      banner.style.display = 'none';
      tm.timerSeconds = 0;
    }
  }

  function startTimerTicker() {
    if (tm.timerTickInterval) clearInterval(tm.timerTickInterval);
    tm.timerTickInterval = setInterval(() => {
      if (tm.activeTimer) {
        tm.timerSeconds++;
        const clock = $tm('tmTimerClock');
        if (clock) clock.textContent = formatTimeHMS(tm.timerSeconds);
      }
    }, 1000);
  }

  // =========================================================================
  // Modal Helpers
  // =========================================================================
  window.tmCloseModal = function(id) {
    const m = $tm(id);
    if (m) m.remove();
  };

})(window);

