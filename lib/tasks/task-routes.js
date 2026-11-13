'use strict';
'use strict';

const { TaskService } = require('./task-service');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function isTaskAdmin(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const roles = (user.sourceRoles || []).map(r => String(r).toUpperCase());
  if (roles.some(r => r.includes('ADMIN') || r.includes('SUPER') || r.includes('SUPPORT') || r.includes('DIRECTOR') || r.includes('CEO') || r.includes('MANAGER') || r.includes('HEAD') || r.includes('LEAD'))) {
    return true;
  }
  const team = String(user.sourceTeam || user.team || '').toUpperCase();
  if (team.includes('SUPPORT') || team.includes('MANAGEMENT') || team.includes('ADMIN') || team.includes('DIRECTOR') || team.includes('CEO')) {
    return true;
  }
  const title = String(user.title || user.designation || '').toUpperCase();
  if (title.includes('MANAGER') || title.includes('HEAD') || title.includes('LEAD') || title.includes('DIRECTOR') || title.includes('CEO') || title.includes('ADMIN')) {
    return true;
  }
  return false;
}

async function handleTaskApi(req, res, url, authContext, db) {
  try {
    const method = req.method;
    const pathname = url.pathname;
    const service = new TaskService(db);
    const user = authContext.user || {};
    user.employeeId = Number(user.employeeId || user.id || 0);
    user.teamName = user.team || user.sourceTeam || user.teamName || '';

  // 1. Duplicate search before creation
  if (method === 'GET' && pathname === '/api/tasks/search-duplicates') {
    const q = url.searchParams.get('q') || '';
    const teamId = url.searchParams.get('teamId') || null;
    const results = await service.searchDuplicates({ query: q, teamId });
    return sendJson(res, 200, { data: results });
  }

  // 2. Capacity & Utilization endpoint
  if (method === 'GET' && pathname === '/api/tasks/capacity/my') {
    const dateStr = url.searchParams.get('date') || null;
    const capacity = await service.getEmployeeDailyCapacityAndUtilization(
      user.employeeId,
      dateStr,
      user.teamName
    );
    return sendJson(res, 200, { data: capacity });
  }

  if (method === 'GET' && pathname === '/api/tasks/capacity/employee') {
    const empId = parseInt(url.searchParams.get('employeeId'), 10);
    const dateStr = url.searchParams.get('date') || null;
    const teamName = url.searchParams.get('teamName') || null;
    if (!empId) return sendError(res, 400, 'employeeId parameter is required.');
    const capacity = await service.getEmployeeDailyCapacityAndUtilization(empId, dateStr, teamName);
    return sendJson(res, 200, { data: capacity });
  }

  // Active Timer lookup for logged-in employee
  if (method === 'GET' && pathname === '/api/tasks/timer/active') {
    const active = await service.getActiveTimer(user.employeeId);
    return sendJson(res, 200, { data: active });
  }

  // Team Members for assignment
  if (method === 'GET' && pathname === '/api/tasks/team-members') {
    const members = await service.getTeamMembers();
    return sendJson(res, 200, { data: members });
  }

  // Team Capacity summary across all staff
  if (method === 'GET' && pathname === '/api/tasks/team-capacity') {
    const dateStr = url.searchParams.get('date') || null;
    const isAdmin = isTaskAdmin(user);
    if (!isAdmin) {
      // Regular employee: ONLY see their own capacity, cannot see other resources
      const myCap = await service.getEmployeeDailyCapacityAndUtilization(user.employeeId, dateStr, user.teamName);
      return sendJson(res, 200, {
        data: [{
          employee_id: user.employeeId,
          name: user.name,
          department: user.teamName || user.sourceTeam || 'Staff',
          designation: user.title || 'Staff',
          capacity: myCap
        }],
        isAdmin: false
      });
    }
    const summary = await service.getTeamCapacitySummary(dateStr);
    return sendJson(res, 200, { data: summary, isAdmin: true });
  }

  // 3. CRM Regular Workload
  if (method === 'GET' && pathname === '/api/tasks/crm-workload/my') {
    const dateStr = url.searchParams.get('date') || null;
    const workload = await service.getCrmRegularWorkload(user.employeeId, user.teamName, dateStr);
    return sendJson(res, 200, { data: workload });
  }

  if (method === 'GET' && pathname === '/api/tasks/crm-workload/employee') {
    const empId = parseInt(url.searchParams.get('employeeId'), 10);
    const dateStr = url.searchParams.get('date') || null;
    const teamName = url.searchParams.get('teamName') || null;
    if (!empId) return sendError(res, 400, 'employeeId parameter is required.');
    const workload = await service.getCrmRegularWorkload(empId, teamName, dateStr);
    return sendJson(res, 200, { data: workload });
  }

  // 4. Events endpoints
  if (method === 'GET' && pathname === '/api/tasks/events') {
    const events = await service.getEvents();
    const eventTypes = await service.getEventTypes();
    return sendJson(res, 200, { data: events, eventTypes });
  }

  if (method === 'POST' && pathname === '/api/tasks/events') {
    const body = await readRequestBody(req);
    const event = await service.createEvent(body, user);
    return sendJson(res, 201, { data: event });
  }

  if (method === 'POST' && pathname === '/api/tasks/events/sync') {
    await service.syncCrmEvents();
    const events = await service.getEvents();
    return sendJson(res, 200, { data: events, message: 'CRM events synchronized successfully.' });
  }

  const eventMatch = pathname.match(/^\/api\/tasks\/events\/([a-zA-Z0-9\-_]+)(\/.*)?$/);
  if (eventMatch) {
    const eventId = eventMatch[1];
    const subRoute = eventMatch[2] || '';

    if (method === 'GET' && !subRoute) {
      const event = await service.getEventById(eventId);
      if (!event) return sendError(res, 404, 'Event not found.');
      return sendJson(res, 200, { data: event });
    }

    if (method === 'POST' && subRoute === '/scaffold-workstreams') {
      const tasks = await service.scaffoldEventTasks(eventId, user);
      return sendJson(res, 201, { data: tasks, message: 'Standard workstream tasks scaffolded.' });
    }
  }

  // 5. Dashboard summary statistics
  if (method === 'GET' && pathname === '/api/tasks/overview-stats') {
    const isAdmin = isTaskAdmin(user);
    const myTasks = await service.getTasks({ owner_employee_id: user.employeeId }, user);
    const allTasks = isAdmin ? await service.getTasks({}, user) : myTasks;

    const pendingCount = myTasks.filter(t => t.status !== 'COMPLETED' && t.status !== 'CANCELLED').length;
    const overdueCount = myTasks.filter(t => t.is_overdue).length;
    const completedCount = myTasks.filter(t => t.status === 'COMPLETED').length;
    const approvalCount = allTasks.filter(t => t.approval_status === 'PENDING').length;

    const myCapacity = await service.getEmployeeDailyCapacityAndUtilization(user.employeeId, null, user.teamName);

    return sendJson(res, 200, {
      data: {
        isAdmin,
        myPendingCount: pendingCount,
        myOverdueCount: overdueCount,
        myCompletedCount: completedCount,
        pendingApprovalsCount: approvalCount,
        capacity: myCapacity
      }
    });
  }

  // 6. Tasks list & Create
  if (method === 'GET' && pathname === '/api/tasks') {
    const ownerId = url.searchParams.get('ownerId');
    const teamId = url.searchParams.get('teamId');
    const status = url.searchParams.get('status');
    const statusGroup = url.searchParams.get('statusGroup');
    const eventId = url.searchParams.get('eventId');
    const search = url.searchParams.get('search');
    const isAdmin = isTaskAdmin(user);

    const filter = {
      team_id: teamId ? parseInt(teamId, 10) : null,
      status,
      status_group: statusGroup,
      event_id: eventId,
      search
    };

    if (isAdmin) {
      // Admin / Support Admin can filter by any specific owner or see all resources
      filter.owner_employee_id = ownerId ? parseInt(ownerId, 10) : null;
    } else {
      // Standard employee can ONLY view tasks assigned to them or created by them
      filter.scopeToEmployeeId = user.employeeId;
    }

    const tasks = await service.getTasks(filter, user);
    return sendJson(res, 200, { data: tasks, isAdmin });
  }

  if (method === 'POST' && pathname === '/api/tasks') {
    const body = await readRequestBody(req);
    const task = await service.createTask(body, user);
    return sendJson(res, 201, { data: task });
  }

  // 7. Single Task detail, Update, Approval, Timer
  const match = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9\-]+)(\/.*)?$/);
  if (match) {
    const taskId = match[1];
    const subRoute = match[2] || '';

    // Timer Start
    if (method === 'POST' && subRoute === '/timer/start') {
      const result = await service.startTimer(taskId, user.employeeId);
      return sendJson(res, 200, { data: result });
    }

    // Timer Stop
    if (method === 'POST' && subRoute === '/timer/stop') {
      const body = await readRequestBody(req).catch(() => ({}));
      const result = await service.stopTimer(taskId, user.employeeId, body.notes);
      return sendJson(res, 200, { data: result });
    }

    // Manual Time Log
    if (method === 'POST' && subRoute === '/time-log') {
      const body = await readRequestBody(req);
      const result = await service.logManualTime(taskId, user.employeeId, body.durationMinutes, body.workDate, body.notes);
      return sendJson(res, 201, { data: result });
    }

    // Approval Decision
    if (method === 'POST' && subRoute === '/approval') {
      const body = await readRequestBody(req);
      const task = await service.submitApprovalDecision(taskId, body.decision, body.notes, user);
      return sendJson(res, 200, { data: task });
    }

    // Task Handoff to another team member
    if (method === 'POST' && subRoute === '/handoff') {
      const body = await readRequestBody(req);
      const task = await service.handoffTask(taskId, body.target_employee_id, body.team_id, body.notes, user);
      return sendJson(res, 200, { data: task });
    }

    // Return Handoff back to previous employee
    if (method === 'POST' && subRoute === '/return-handoff') {
      const body = await readRequestBody(req).catch(() => ({}));
      const task = await service.returnHandoffTask(taskId, body.notes, user);
      return sendJson(res, 200, { data: task });
    }

    // Get Single Task
    if (method === 'GET' && !subRoute) {
      const task = await service.getTaskById(taskId);
      if (!task) return sendError(res, 404, 'Task not found.');
      return sendJson(res, 200, { data: task });
    }

    // Update Single Task
    if (method === 'PATCH' && !subRoute) {
      const body = await readRequestBody(req);
      const task = await service.updateTask(taskId, body, user);
      return sendJson(res, 200, { data: task });
    }
  }

    return sendError(res, 404, `Not found: ${method} ${pathname}`);
  } catch (err) {
    console.error('[TaskApi Error]', err);
    return sendError(res, err.statusCode || 400, err.message || 'An unexpected error occurred in Task Manager.');
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('Request payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { handleTaskApi };
