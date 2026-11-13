'use strict';

const crypto = require('node:crypto');

function uuidv4() {
  return crypto.randomUUID();
}

/**
 * Helper to format Date into MySQL DATETIME string (YYYY-MM-DD HH:MM:SS)
 */
function toSqlDatetime(d) {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toSqlDate(d) {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

class TaskService {
  constructor(db) {
    this.db = db;
  }

  // =========================================================================
  // 1. SMART SEARCH & DUPLICATE PREVENTION
  // =========================================================================

  /**
   * Searches open/in-progress tasks to prevent duplicates before creation.
   */
  async searchDuplicates({ query, teamId, excludeTaskId }) {
    if (!query || query.trim().length < 2) return [];
    const term = `%${query.trim()}%`;
    const params = [term, term, term];

    let sql = `
      SELECT t.id, t.task_code, t.title, t.description, t.status, t.priority,
             t.approval_status, t.deadline, t.estimated_minutes, t.team_id,
             t.owner_employee_id, tm.team_name,
             CONCAT(e.first_name, ' ', e.last_name) AS owner_name,
             e.employee_code, ev.event_name, ev.program_type
      FROM connect_task_tasks t
      LEFT JOIN teams tm ON t.team_id = tm.team_id
      LEFT JOIN employees e ON t.owner_employee_id = e.employee_id
      LEFT JOIN connect_task_events ev ON t.event_id = ev.id
      WHERE (t.title LIKE ? OR t.description LIKE ? OR t.task_code LIKE ?)
        AND t.status NOT IN ('COMPLETED', 'CANCELLED')
    `;

    if (teamId) {
      sql += ' AND t.team_id = ?';
      params.push(teamId);
    }
    if (excludeTaskId) {
      sql += ' AND t.id != ?';
      params.push(excludeTaskId);
    }

    sql += ' ORDER BY t.created_at DESC LIMIT 10;';

    const rows = await this.db.all(sql, params);
    return rows.map(r => this._formatTaskRecord(r));
  }

  // =========================================================================
  // 2. TASK CRUD & HIERARCHY
  // =========================================================================

  /**
   * Generates next readable task code like TSK-2026-0001
   */
  async generateNextTaskCode() {
    const year = new Date().getFullYear();
    const prefix = `TSK-${year}-`;
    const row = await this.db.get(
      "SELECT task_code FROM connect_task_tasks WHERE task_code LIKE ? ORDER BY task_code DESC LIMIT 1",
      [`${prefix}%`]
    );
    let nextNum = 1;
    if (row && row.task_code) {
      const match = row.task_code.match(new RegExp(`^TSK-${year}-(\\d+)$`));
      if (match) {
        nextNum = parseInt(match[1], 10) + 1;
      }
    }
    return `${prefix}${String(nextNum).padStart(4, '0')}`;
  }

  /**
   * Creates a new task or subtask.
   */
  async createTask(data, actor) {
    const id = uuidv4();
    const taskCode = await this.generateNextTaskCode();
    const now = new Date();
    const sqlNow = toSqlDatetime(now);

    const title = String(data.title || '').trim();
    if (!title) throw new Error('Task title is required.');

    const ownerEmployeeId = parseInt(data.owner_employee_id || actor?.employeeId, 10);
    if (!ownerEmployeeId) throw new Error('Accountable task owner employee ID is required.');

    let rawDeadline = data.deadline || data.due_date;
    if (!rawDeadline) {
      const def = new Date();
      def.setDate(def.getDate() + 3);
      def.setHours(18, 30, 0, 0);
      rawDeadline = def;
    }
    const deadline = toSqlDatetime(rawDeadline);
    if (!deadline) throw new Error('Valid deadline date and time is required.');

    const estimatedMinutes = Math.max(0, parseInt(data.estimated_minutes || '0', 10));
    const requiresApproval = Boolean(data.requires_approval);
    const approvalStatus = requiresApproval ? 'PENDING' : 'NOT_REQUIRED';

    const parentTaskId = data.parent_task_id || null;
    if (parentTaskId) {
      // Validate parent exists
      const parent = await this.db.get("SELECT id FROM connect_task_tasks WHERE id = ?", [parentTaskId]);
      if (!parent) throw new Error('Specified parent task does not exist.');
    }

    const teamId = data.team_id ? parseInt(data.team_id, 10) : null;
    const eventId = data.event_id || null;
    const source = data.source || (eventId ? 'EVENT' : (parentTaskId ? 'MANUAL' : 'MANUAL'));
    const taskType = parentTaskId ? 'ONE_OFF' : (eventId ? 'EVENT_WORK' : (data.task_type || 'ONE_OFF'));

    await this.db.run(
      `INSERT INTO connect_task_tasks (
        id, task_code, title, description, source, task_type,
        team_id, owner_employee_id, previous_owner_employee_id, creator_user_id, parent_task_id, event_id,
        priority, status, approval_status, estimated_minutes, planned_start,
        deadline, crm_reference_id, handoff_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        taskCode,
        title,
        data.description || '',
        source,
        taskType,
        teamId,
        ownerEmployeeId,
        null,
        actor?.userId || null,
        parentTaskId,
        eventId,
        data.priority || 'NORMAL',
        'OPEN',
        approvalStatus,
        estimatedMinutes,
        toSqlDatetime(data.planned_start) || sqlNow,
        deadline,
        data.crm_reference_id || null,
        data.handoff_notes || null,
        sqlNow,
        sqlNow
      ]
    );

    // Initial daily allocation (allocated to deadline work date only if estimated minutes > 0)
    if (estimatedMinutes > 0) {
      const deadlineDate = toSqlDate(deadline);
      await this.db.run(
        `INSERT INTO connect_task_daily_allocations (
          task_id, employee_id, work_date, allocated_minutes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE allocated_minutes = ?, updated_at = ?`,
        [id, ownerEmployeeId, deadlineDate, estimatedMinutes, sqlNow, sqlNow, estimatedMinutes, sqlNow]
      );
    }

    // If approval required, create approval request record
    if (requiresApproval) {
      const approverEmployeeId = parseInt(data.approver_employee_id || actor?.employeeId, 10);
      if (approverEmployeeId) {
        await this.db.run(
          `INSERT INTO connect_task_approvals (
            id, task_id, approver_employee_id, requested_by_employee_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
          [uuidv4(), id, approverEmployeeId, actor?.employeeId || ownerEmployeeId, sqlNow, sqlNow]
        );
      }
    }

    // Audit log
    await this.logAudit({
      taskId: id,
      actorUserId: actor?.userId,
      actorEmployeeId: actor?.employeeId,
      action: 'TASK_CREATED',
      details: { taskCode, title, ownerEmployeeId, estimatedMinutes, requiresApproval }
    });

    return await this.getTaskById(id);
  }

  /**
   * Fetches task by ID with subtasks, active timer, and SLA info.
   */
  async getTaskById(taskId) {
    const row = await this.db.get(
      `SELECT t.*, tm.team_name,
              CONCAT(e.first_name, ' ', IFNULL(e.last_name, '')) AS owner_name,
              e.employee_code, ev.event_name, ev.program_type, ev.delivery_mode,
              CONCAT(creator.first_name, ' ', IFNULL(creator.last_name, '')) AS creator_name,
              CONCAT(prev.first_name, ' ', IFNULL(prev.last_name, '')) AS previous_owner_name,
              prev_tm.team_name AS previous_team_name
       FROM connect_task_tasks t
       LEFT JOIN teams tm ON t.team_id = tm.team_id
       LEFT JOIN employees e ON t.owner_employee_id = e.employee_id
       LEFT JOIN employees creator ON t.creator_user_id = creator.employee_id
       LEFT JOIN employees prev ON t.previous_owner_employee_id = prev.employee_id
       LEFT JOIN teams prev_tm ON prev.team_id = prev_tm.team_id
       LEFT JOIN connect_task_events ev ON t.event_id = ev.id
       WHERE t.id = ?`,
      [taskId]
    );
    if (!row) return null;

    const task = this._formatTaskRecord(row);

    // Fetch subtasks
    const subtaskRows = await this.db.all(
      `SELECT t.*, tm.team_name,
              CONCAT(e.first_name, ' ', IFNULL(e.last_name, '')) AS owner_name,
              e.employee_code
       FROM connect_task_tasks t
       LEFT JOIN teams tm ON t.team_id = tm.team_id
       LEFT JOIN employees e ON t.owner_employee_id = e.employee_id
       WHERE t.parent_task_id = ?
       ORDER BY t.created_at ASC`,
      [taskId]
    );
    task.subtasks = subtaskRows.map(s => this._formatTaskRecord(s));

    // Calculate subtask progress rollup
    if (task.subtasks.length > 0) {
      const totalEstimated = task.subtasks.reduce((acc, c) => acc + (c.estimated_minutes || 0), 0);
      const completedEstimated = task.subtasks
        .filter(c => c.status === 'COMPLETED')
        .reduce((acc, c) => acc + (c.estimated_minutes || 0), 0);
      task.rollup_progress_pct = totalEstimated > 0 ? Math.round((completedEstimated / totalEstimated) * 100) : 0;
      task.subtasks_total = task.subtasks.length;
      task.subtasks_completed = task.subtasks.filter(c => c.status === 'COMPLETED').length;
    } else {
      task.rollup_progress_pct = task.status === 'COMPLETED' ? 100 : (task.status === 'IN_PROGRESS' ? 50 : 0);
      task.subtasks_total = 0;
      task.subtasks_completed = 0;
    }

    // Fetch dependencies
    const deps = await this.db.all(
      `SELECT d.predecessor_task_id, p.task_code, p.title, p.status
       FROM connect_task_dependencies d
       JOIN connect_task_tasks p ON d.predecessor_task_id = p.id
       WHERE d.successor_task_id = ?`,
      [taskId]
    );
    task.dependencies = deps;
    task.has_unresolved_dependencies = deps.some(d => d.status !== 'COMPLETED');

    // Fetch active timer for this task (with employee info)
    const activeTimer = await this.db.get(
      `SELECT te.*, CONCAT(e.first_name, ' ', IFNULL(e.last_name, '')) AS employee_name
       FROM connect_task_time_entries te
       LEFT JOIN employees e ON te.employee_id = e.employee_id
       WHERE te.task_id = ? AND te.is_active = 1 LIMIT 1`,
      [taskId]
    );
    task.active_timer = activeTimer || null;

    // Fetch time utilisation by employee
    const timeByEmp = await this.db.all(
      `SELECT 
         e.employee_id,
         CONCAT(e.first_name, ' ', IFNULL(e.last_name, '')) AS employee_name,
         e.employee_code,
         IFNULL(tm.team_id, 0) AS team_id,
         IFNULL(tm.team_name, 'Staff') AS team_name,
         SUM(te.duration_minutes) AS total_minutes,
         COUNT(te.id) AS session_count
       FROM connect_task_time_entries te
       JOIN employees e ON te.employee_id = e.employee_id
       LEFT JOIN teams tm ON e.team_id = tm.team_id
       WHERE te.task_id = ?
       GROUP BY e.employee_id, e.first_name, e.last_name, e.employee_code, tm.team_id, tm.team_name
       ORDER BY total_minutes DESC`,
      [taskId]
    );
    task.time_by_employee = timeByEmp;

    // Fetch time utilisation by team
    const timeByTeam = await this.db.all(
      `SELECT 
         IFNULL(tm.team_id, 0) AS team_id,
         IFNULL(tm.team_name, 'Other') AS team_name,
         SUM(te.duration_minutes) AS total_minutes,
         COUNT(DISTINCT te.employee_id) AS member_count,
         COUNT(te.id) AS session_count
       FROM connect_task_time_entries te
       JOIN employees e ON te.employee_id = e.employee_id
       LEFT JOIN teams tm ON e.team_id = tm.team_id
       WHERE te.task_id = ?
       GROUP BY tm.team_id, tm.team_name
       ORDER BY total_minutes DESC`,
      [taskId]
    );
    task.time_by_team = timeByTeam;

    // Detailed time entries history
    const entries = await this.db.all(
      `SELECT 
         te.id,
         te.task_id,
         te.employee_id,
         CONCAT(e.first_name, ' ', IFNULL(e.last_name, '')) AS employee_name,
         IFNULL(tm.team_name, 'Staff') AS team_name,
         te.work_date,
         te.start_time,
         te.end_time,
         te.duration_minutes,
         te.entry_type,
         te.is_active,
         te.notes
       FROM connect_task_time_entries te
       JOIN employees e ON te.employee_id = e.employee_id
       LEFT JOIN teams tm ON e.team_id = tm.team_id
       WHERE te.task_id = ?
       ORDER BY te.start_time DESC, te.created_at DESC`,
      [taskId]
    );
    task.time_entries = entries;

    const totalMinutes = entries.reduce((acc, x) => acc + (x.duration_minutes || 0), 0);
    task.actual_logged_minutes = totalMinutes;
    task.actual_minutes = totalMinutes;

    return task;
  }

  /**
   * Lists tasks with rich filtering, SLA overdue check, and team breakdown.
   */
  async getTasks(filter = {}, actor = {}) {
    const params = [];
    let sql = `
      SELECT t.*, tm.team_name,
             CONCAT(e.first_name, ' ', IFNULL(e.last_name, '')) AS owner_name,
             e.employee_code, ev.event_name, ev.program_type,
             CONCAT(prev.first_name, ' ', IFNULL(prev.last_name, '')) AS previous_owner_name,
             prev_tm.team_name AS previous_team_name,
             (SELECT IFNULL(SUM(duration_minutes), 0) FROM connect_task_time_entries WHERE task_id = t.id) AS actual_minutes,
             (SELECT COUNT(DISTINCT employee_id) FROM connect_task_time_entries WHERE task_id = t.id) AS contributor_count
      FROM connect_task_tasks t
      LEFT JOIN teams tm ON t.team_id = tm.team_id
      LEFT JOIN employees e ON t.owner_employee_id = e.employee_id
      LEFT JOIN employees prev ON t.previous_owner_employee_id = prev.employee_id
      LEFT JOIN teams prev_tm ON prev.team_id = prev_tm.team_id
      LEFT JOIN connect_task_events ev ON t.event_id = ev.id
      WHERE 1=1
    `;

    if (filter.scopeToEmployeeId) {
      sql += ' AND (t.owner_employee_id = ? OR t.creator_user_id = ?)';
      params.push(filter.scopeToEmployeeId, filter.scopeToEmployeeId);
    } else if (filter.owner_employee_id) {
      sql += ' AND t.owner_employee_id = ?';
      params.push(filter.owner_employee_id);
    }
    if (filter.team_id) {
      sql += ' AND t.team_id = ?';
      params.push(filter.team_id);
    }
    if (filter.status) {
      sql += ' AND t.status = ?';
      params.push(filter.status);
    } else if (filter.status_group === 'OPEN') {
      sql += " AND t.status NOT IN ('COMPLETED', 'CANCELLED')";
    } else if (filter.status_group === 'COMPLETED') {
      sql += " AND t.status = 'COMPLETED'";
    }
    if (filter.event_id) {
      sql += ' AND t.event_id = ?';
      params.push(filter.event_id);
    }
    if (filter.priority) {
      sql += ' AND t.priority = ?';
      params.push(filter.priority);
    }
    if (filter.search) {
      sql += ' AND (t.title LIKE ? OR t.task_code LIKE ?)';
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }

    sql += ' ORDER BY t.deadline ASC, t.created_at DESC LIMIT 200;';

    const rows = await this.db.all(sql, params);
    return rows.map(r => this._formatTaskRecord(r));
  }

  /**
   * Updates a task status, details, or assignments.
   */
  async updateTask(taskId, data, actor) {
    const existing = await this.getTaskById(taskId);
    if (!existing) throw new Error('Task not found.');

    const now = new Date();
    const sqlNow = toSqlDatetime(now);

    // If attempting to complete task, ensure all child subtasks are completed (AT07)!
    if (data.status === 'COMPLETED') {
      const openSubtasks = await this.db.all(
        "SELECT task_code, title FROM connect_task_tasks WHERE parent_task_id = ? AND status NOT IN ('COMPLETED', 'CANCELLED')",
        [taskId]
      );
      if (openSubtasks.length > 0) {
        const codes = openSubtasks.map(s => s.task_code).join(', ');
        throw new Error(`Cannot complete parent task: Active subtasks remaining (${codes}). All child subtasks must be completed first.`);
      }

      // Check unresolved dependencies
      const unfinishedDeps = await this.db.all(
        `SELECT p.task_code FROM connect_task_dependencies d
         JOIN connect_task_tasks p ON d.predecessor_task_id = p.id
         WHERE d.successor_task_id = ? AND p.status != 'COMPLETED'`,
        [taskId]
      );
      if (unfinishedDeps.length > 0) {
        throw new Error(`Cannot complete task: Dependent predecessor task (${unfinishedDeps[0].task_code}) is not completed.`);
      }
    }

    const updates = [];
    const params = [];

    if (data.title !== undefined) {
      updates.push('title = ?');
      params.push(String(data.title).trim());
    }
    if (data.description !== undefined) {
      updates.push('description = ?');
      params.push(data.description);
    }
    if (data.priority !== undefined) {
      updates.push('priority = ?');
      params.push(data.priority);
    }
    if (data.status !== undefined) {
      updates.push('status = ?');
      params.push(data.status);
      if (data.status === 'COMPLETED') {
        updates.push('completed_at = ?');
        params.push(sqlNow);
      }
    }
    if (data.deadline !== undefined) {
      updates.push('deadline = ?');
      params.push(toSqlDatetime(data.deadline));
    }
    if (data.estimated_minutes !== undefined) {
      updates.push('estimated_minutes = ?');
      params.push(Math.max(0, parseInt(data.estimated_minutes, 10)));
    }
    if (data.team_id !== undefined) {
      updates.push('team_id = ?');
      params.push(data.team_id ? parseInt(data.team_id, 10) : null);
    }
    if (data.owner_employee_id !== undefined) {
      updates.push('owner_employee_id = ?');
      params.push(parseInt(data.owner_employee_id, 10));
    }
    if (data.previous_owner_employee_id !== undefined) {
      updates.push('previous_owner_employee_id = ?');
      params.push(data.previous_owner_employee_id ? parseInt(data.previous_owner_employee_id, 10) : null);
    }
    if (data.handoff_notes !== undefined) {
      updates.push('handoff_notes = ?');
      params.push(data.handoff_notes);
    }

    // Auto-stop active timer if task is completed or moved to review
    if (data.status === 'COMPLETED' || data.status === 'REVIEW' || data.status === 'IN_REVIEW') {
      const empId = Number(actor?.employeeId);
      if (empId) {
        await this.stopTimer(taskId, empId, `Task marked ${data.status}`).catch(() => {});
      }
    }

    updates.push('updated_at = ?');
    params.push(sqlNow);
    params.push(taskId);

    await this.db.run(
      `UPDATE connect_task_tasks SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    await this.logAudit({
      taskId,
      actorUserId: actor?.userId,
      actorEmployeeId: actor?.employeeId,
      action: 'TASK_UPDATED',
      details: data
    });

    return await this.getTaskById(taskId);
  }

  /**
   * Hands off task to another team member based on dependency/specialization.
   * Automatically stops any active timer for current owner and records handoff link.
   */
  async handoffTask(taskId, targetEmployeeId, targetTeamId, notes, actor) {
    const task = await this.getTaskById(taskId);
    if (!task) throw new Error('Task not found.');

    const currentEmpId = Number(actor?.employeeId || task.owner_employee_id);
    const targetEmpId = Number(targetEmployeeId);
    if (!targetEmpId) throw new Error('Target team member is required for handoff.');

    // 1. Auto-stop active timer on this task for current employee
    if (currentEmpId) {
      await this.stopTimer(taskId, currentEmpId, `Handed off to employee #${targetEmpId}: ${notes || ''}`).catch(() => {});
    }

    // 2. Fetch target employee details to determine team if not provided
    let finalTeamId = targetTeamId ? parseInt(targetTeamId, 10) : null;
    const targetEmp = await this.db.get('SELECT employee_id, team_id, first_name, last_name FROM employees WHERE employee_id = ?', [targetEmpId]);
    if (!targetEmp) throw new Error('Target employee not found.');
    if (!finalTeamId) {
      finalTeamId = targetEmp.team_id || task.team_id;
    }

    const sqlNow = toSqlDatetime(new Date());
    const handoffMsg = notes ? String(notes).trim() : '';

    // 3. Update task: set owner to target, record previous_owner_employee_id as current owner, update team_id, store handoff_notes
    await this.db.run(
      `UPDATE connect_task_tasks
       SET owner_employee_id = ?,
           previous_owner_employee_id = ?,
           team_id = ?,
           handoff_notes = ?,
           status = CASE WHEN status = 'COMPLETED' THEN 'OPEN' ELSE status END,
           updated_at = ?
       WHERE id = ?`,
      [targetEmpId, task.owner_employee_id, finalTeamId, handoffMsg, sqlNow, taskId]
    );

    // 4. Log audit entry
    await this.logAudit({
      taskId,
      actorUserId: actor?.userId,
      actorEmployeeId: currentEmpId,
      action: 'TASK_HANDOFF',
      details: {
        from_employee_id: task.owner_employee_id,
        to_employee_id: targetEmpId,
        to_team_id: finalTeamId,
        notes: handoffMsg
      }
    });

    return await this.getTaskById(taskId);
  }

  /**
   * Returns a handed-off task back to the previous employee.
   * Automatically stops any active timer for the second employee.
   */
  async returnHandoffTask(taskId, notes, actor) {
    const task = await this.getTaskById(taskId);
    if (!task) throw new Error('Task not found.');

    if (!task.previous_owner_employee_id) {
      throw new Error('No previous owner recorded for this task to return to.');
    }

    const currentEmpId = Number(actor?.employeeId || task.owner_employee_id);
    const prevEmpId = Number(task.previous_owner_employee_id);

    // 1. Auto-stop active timer for current employee on this task
    if (currentEmpId) {
      await this.stopTimer(taskId, currentEmpId, `Work finished & returned: ${notes || ''}`).catch(() => {});
    }

    // 2. Fetch previous employee details to restore team
    const prevEmp = await this.db.get('SELECT employee_id, team_id, first_name, last_name FROM employees WHERE employee_id = ?', [prevEmpId]);
    const restoredTeamId = prevEmp?.team_id || task.team_id;

    const sqlNow = toSqlDatetime(new Date());
    const returnMsg = notes ? String(notes).trim() : 'Work completed and returned to original assignee';

    const combinedNotes = task.handoff_notes 
      ? `${task.handoff_notes}\n[Returned]: ${returnMsg}`
      : `[Returned]: ${returnMsg}`;

    // 3. Update task back to previous owner
    await this.db.run(
      `UPDATE connect_task_tasks
       SET owner_employee_id = ?,
           previous_owner_employee_id = ?,
           team_id = ?,
           handoff_notes = ?,
           updated_at = ?
       WHERE id = ?`,
      [prevEmpId, currentEmpId, restoredTeamId, combinedNotes, sqlNow, taskId]
    );

    // 4. Log audit entry
    await this.logAudit({
      taskId,
      actorUserId: actor?.userId,
      actorEmployeeId: currentEmpId,
      action: 'TASK_RETURN_HANDOFF',
      details: {
        from_employee_id: currentEmpId,
        to_employee_id: prevEmpId,
        notes: returnMsg
      }
    });

    return await this.getTaskById(taskId);
  }

  // =========================================================================
  // 3. APPROVAL WORKFLOW GATES
  // =========================================================================

  /**
   * Submits an approval decision (APPROVE, CHANGES_REQUESTED, REJECT).
   */
  async submitApprovalDecision(taskId, decision, notes, actor) {
    const valid = ['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'];
    if (!valid.includes(decision)) throw new Error('Invalid approval decision.');

    const sqlNow = toSqlDatetime(new Date());

    // Update approval record
    await this.db.run(
      `UPDATE connect_task_approvals 
       SET status = ?, decision_notes = ?, decided_at = ?, updated_at = ?
       WHERE task_id = ? AND status = 'PENDING'`,
      [decision, notes || '', sqlNow, sqlNow, taskId]
    );

    // Update task approval_status
    await this.db.run(
      `UPDATE connect_task_tasks 
       SET approval_status = ?, updated_at = ?
       WHERE id = ?`,
      [decision, sqlNow, taskId]
    );

    await this.logAudit({
      taskId,
      actorUserId: actor?.userId,
      actorEmployeeId: actor?.employeeId,
      action: `APPROVAL_${decision}`,
      details: { decision, notes }
    });

    return await this.getTaskById(taskId);
  }

  // =========================================================================
  // 4. TIMER & TIME TRACKING (Strict 1 Active Timer Across Devices)
  // =========================================================================

  /**
   * Starts a timer on a task.
   * Enforces:
   * 1. If approval is PENDING, throws error! (AT02)
   * 2. Automatically pauses/stops any running timer for this employee! (AT14)
   */
  async startTimer(taskId, employeeId) {
    const task = await this.getTaskById(taskId);
    if (!task) throw new Error('Task not found.');

    if (task.approval_status === 'PENDING') {
      throw new Error('Timer blocked: Task is awaiting approval before productive work can start.');
    }
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
      throw new Error(`Cannot start timer: Task is already ${task.status.toLowerCase()}.`);
    }

    const empId = Number(employeeId);
    if (!empId) {
      throw new Error('Valid employee ID is required to start a timer.');
    }

    const now = new Date();
    const sqlNow = toSqlDatetime(now);
    const workDate = toSqlDate(now);

    // Pause any other active timer for this employee across all devices
    const activeEntries = await this.db.all(
      "SELECT id, task_id, start_time FROM connect_task_time_entries WHERE employee_id = ? AND is_active = 1",
      [empId]
    );
    for (const active of activeEntries) {
      const startTime = new Date(active.start_time);
      const elapsedMins = Math.max(1, Math.round((now.getTime() - startTime.getTime()) / 60000));
      await this.db.run(
        `UPDATE connect_task_time_entries 
         SET is_active = 0, end_time = ?, duration_minutes = duration_minutes + ?, updated_at = ?
         WHERE id = ?`,
        [sqlNow, elapsedMins, sqlNow, active.id]
      );
    }

    // Start new active timer
    const entryId = uuidv4();
    await this.db.run(
      `INSERT INTO connect_task_time_entries (
        id, task_id, employee_id, work_date, start_time, duration_minutes, entry_type, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 'TIMER', 1, ?, ?)`,
      [entryId, taskId, empId, workDate, sqlNow, sqlNow, sqlNow]
    );

    // Auto update task status to IN_PROGRESS if OPEN
    if (task.status === 'OPEN' || task.status === 'DRAFT') {
      await this.db.run("UPDATE connect_task_tasks SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?", [sqlNow, taskId]);
    }

    return { active: true, taskId, employeeId: empId, startTime: sqlNow };
  }

  /**
   * Stops an active timer.
   */
  async stopTimer(taskId, employeeId, notes) {
    const empId = Number(employeeId);
    if (!empId) {
      throw new Error('Valid employee ID is required to stop timer.');
    }
    const now = new Date();
    const sqlNow = toSqlDatetime(now);

    const active = await this.db.get(
      "SELECT id, start_time FROM connect_task_time_entries WHERE task_id = ? AND employee_id = ? AND is_active = 1 LIMIT 1",
      [taskId, empId]
    );
    if (!active) {
      return { active: false, message: 'No running timer found.' };
    }

    const startTime = new Date(active.start_time);
    const elapsedMins = Math.max(1, Math.round((now.getTime() - startTime.getTime()) / 60000));

    await this.db.run(
      `UPDATE connect_task_time_entries 
       SET is_active = 0, end_time = ?, duration_minutes = duration_minutes + ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [sqlNow, elapsedMins, notes || '', sqlNow, active.id]
    );

    return { active: false, taskId, employeeId: empId, elapsedMins };
  }

  /**
   * Retrieves active running timer for an employee if any.
   */
  async getActiveTimer(employeeId) {
    const empId = Number(employeeId);
    if (!empId) return null;
    const active = await this.db.get(
      `SELECT e.id, e.task_id, e.employee_id, e.start_time, e.entry_type,
              t.title AS task_title, t.task_code, t.team_id
       FROM connect_task_time_entries e
       JOIN connect_task_tasks t ON e.task_id = t.id
       WHERE e.employee_id = ? AND e.is_active = 1
       LIMIT 1`,
      [empId]
    );
    return active || null;
  }

  /**
   * Logs manual time entry.
   */
  async logManualTime(taskId, employeeId, durationMinutes, workDate, notes) {
    const empId = Number(employeeId);
    if (!empId) {
      throw new Error('Valid employee ID is required to log time.');
    }
    const mins = Math.max(1, parseInt(durationMinutes, 10));
    const now = new Date();
    const sqlNow = toSqlDatetime(now);
    const dateStr = workDate || toSqlDate(now);

    const entryId = uuidv4();
    await this.db.run(
      `INSERT INTO connect_task_time_entries (
        id, task_id, employee_id, work_date, duration_minutes, entry_type, is_active, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'MANUAL', 0, ?, ?, ?)`,
      [entryId, taskId, empId, dateStr, mins, notes || '', sqlNow, sqlNow]
    );

    return { logged: true, durationMinutes: mins };
  }

  // =========================================================================
  // 5. CRM REGULAR WORKLOAD INTEGRATION (Approved User Rules)
  // =========================================================================

  /**
   * Extracts and derives CRM daily regular workload for Operations, Sales, and Digital teams:
   * - Operations: mentees & mentee_conversion (Open, In-progress, assigned day)
   * - Sales: clients & client_call_status (Active pipeline leads, client status)
   * - Digital: digital_marketing_requests (Open, In-progress requests)
   */
  async getCrmRegularWorkload(employeeId, teamName, dateStr) {
    const targetDate = dateStr ? new Date(dateStr) : new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDayName = dayNames[targetDate.getDay()];

    let items = [];
    let totalEstimatedMinutes = 0;

    try {
      // Resolve employee and team info from DB if teamName is missing or for username matching
      const emp = await this.db.get(
        `SELECT e.employee_id, e.first_name, e.last_name, t.team_name, u.username
         FROM employees e
         LEFT JOIN teams t ON e.team_id = t.team_id
         LEFT JOIN users u ON u.employee_id = e.employee_id
         WHERE e.employee_id = ?`,
        [employeeId]
      );

    const resolvedTeam = teamName || emp?.team_name || '';
    const lowerTeam = String(resolvedTeam).toLowerCase();
    const username = emp?.username || '';
    const firstName = emp?.first_name || '';

    // 1. MENTEES & MENTEE CONVERSIONS (Active Status, Progress for Owned Mentees)
    const hasUsername = Boolean(username && String(username).trim());
    const menteeOwnerClause = hasUsername
      ? '(m.operation_owner = ? OR m.operation_owner = ? OR m.operation_owner = ?)'
      : '(m.operation_owner = ? OR m.operation_owner = ?)';
    const menteeOwnerParams = hasUsername
      ? [employeeId, String(employeeId), username]
      : [employeeId, String(employeeId)];

    // 1a. Mentees (Strictly Progress 50, Active client_status, Operations Team, No Refunds, Owned by employee)
    const mentees = await this.db.all(
      `SELECT m.mentee_id, m.brand_name, m.priority, m.assigned_day, m.statusId,
              c.full_name AS client_name, s.status_name
       FROM mentees m
       JOIN clients c ON m.client_id = c.client_id
       LEFT JOIN Status s ON m.statusId = s.status_id
       WHERE c.client_status = 'ACTIVE'
         AND c.team_id = (SELECT team_id FROM teams WHERE LOWER(team_name) = 'operations' LIMIT 1)
         AND ${menteeOwnerClause}
         AND m.statusId = 50
         AND c.client_id NOT IN (SELECT client_id FROM mentee_refund_cases WHERE case_status IN ('OPEN','IN_PROGRESS'))
       ORDER BY m.priority DESC, m.mentee_id DESC`,
      menteeOwnerParams
    );

    for (const m of mentees) {
      const isScheduledToday = m.assigned_day === currentDayName;
      items.push({
        source: 'CRM_MENTEES',
        title: `Mentee: ${m.brand_name || m.client_name || 'Mentee #' + m.mentee_id}`,
        detail: `Status: ${m.status_name || 'Progress'} · Call Day: ${m.assigned_day || 'Unscheduled'}`,
        refId: `MENTEE-${m.mentee_id}`,
        priority: m.priority === 'High' ? 'HIGH' : 'NORMAL',
        isScheduledToday,
        assignedDay: m.assigned_day,
        estimatedMinutes: isScheduledToday ? 30 : 0
      });
      if (isScheduledToday) {
        totalEstimatedMinutes += 30;
      }
    }

    // 1b. Mentee Conversions (Strictly Progress 62, Active client_status, Owned by staff)
    let conversions = [];
    if (hasUsername || employeeId) {
      const convOwnerClause = hasUsername
        ? '(mc.ownership = ? OR mc.ownership = ? OR mc.ownership = ?)'
        : '(mc.ownership = ? OR mc.ownership = ?)';
      const convOwnerParams = hasUsername
        ? [username, employeeId, String(employeeId)]
        : [employeeId, String(employeeId)];

      conversions = await this.db.all(
        `SELECT mc.conversion_id, mc.client_id, mc.ownership, mc.assigned_day_to_call,
                mc.preferred_call_time, mc.mentee_status, c.full_name AS client_name,
                c.lead_code, c.phone, s.status_name
         FROM mentee_conversion mc
         JOIN clients c ON mc.client_id = c.client_id
         LEFT JOIN Status s ON mc.mentee_status = s.status_id
         WHERE c.client_status = 'ACTIVE'
           AND mc.mentee_status = 62
           AND c.client_id NOT IN (SELECT client_id FROM mentee_refund_cases WHERE case_status IN ('OPEN','IN_PROGRESS'))
           AND ${convOwnerClause}
         ORDER BY mc.conversion_id DESC`,
        convOwnerParams
      );
    }

    for (const mc of conversions) {
      const isScheduledToday = mc.assigned_day_to_call === currentDayName;
      items.push({
        source: 'CRM_CONVERSION',
        title: `Mentee Conversion: ${mc.client_name || 'Client #' + mc.client_id} (${mc.phone || ''})`,
        detail: `Status: ${mc.status_name || 'Progress'} · Call Day: ${mc.assigned_day_to_call || 'Unscheduled'}${mc.preferred_call_time ? ' at ' + mc.preferred_call_time : ''}`,
        refId: `CONV-${mc.conversion_id}`,
        priority: 'NORMAL',
        isScheduledToday,
        assignedDay: mc.assigned_day_to_call,
        estimatedMinutes: isScheduledToday ? 30 : 0
      });
      if (isScheduledToday) {
        totalEstimatedMinutes += 30;
      }
    }

    // 2. SALES TEAM
    if (lowerTeam.includes('sales')) {
      // Query active clients in pipeline assigned to this sales staff
      const clients = await this.db.all(
        `SELECT c.client_id, c.full_name, c.phone, c.lead_code, c.pipeline_stage, c.client_status
         FROM clients c
         WHERE c.assigned_to = ? AND c.client_status = 'ACTIVE'
         LIMIT 20`,
        [employeeId]
      );

      for (const c of clients) {
        // Standard 15 min per sales follow-up call
        const estMins = 15;
        items.push({
          source: 'CRM_SALES',
          title: `Sales Follow-up: ${c.full_name} (${c.lead_code || c.phone})`,
          refId: `LEAD-${c.client_id}`,
          priority: 'NORMAL',
          pipelineStage: c.pipeline_stage,
          isScheduledToday: true,
          estimatedMinutes: estMins
        });
        totalEstimatedMinutes += estMins;
      }
    }

    // 3. DIGITAL TEAM
    if (lowerTeam.includes('digital')) {
      // Query open and in-progress digital requests
      const requests = await this.db.all(
        `SELECT request_id, title, priority, status, service_types, target_date
         FROM digital_marketing_requests
         WHERE assigned_to = ? AND status_id IN (63, 64)
         ORDER BY priority DESC`,
        [employeeId]
      );

      for (const r of requests) {
        // Standard 60 min per creative deliverable
        const estMins = 60;
        items.push({
          source: 'CRM_DIGITAL',
          title: `Digital Deliverable: ${r.title || 'Request #' + r.request_id}`,
          refId: `DIGITAL-${r.request_id}`,
          priority: r.priority === 'URGENT' || r.priority === 'HIGH' ? 'HIGH' : 'NORMAL',
          status: r.status,
          isScheduledToday: true,
          estimatedMinutes: estMins
        });
        totalEstimatedMinutes += estMins;
      }
    }
    } catch (crmErr) {
      console.warn('[getCrmRegularWorkload Warning]', crmErr.message);
    }

    return {
      team: teamName,
      employeeId,
      workDate: toSqlDate(targetDate),
      dayName: currentDayName,
      items,
      totalItems: items.length,
      scheduledTodayMinutes: totalEstimatedMinutes,
      totalEstimatedMinutes: totalEstimatedMinutes
    };
  }

  // =========================================================================
  // 6. 8-HOUR CAPACITY & UTILIZATION ENGINE (480 MINS BASELINE: 60% DAILY / 40% TASKS)
  // =========================================================================

  /**
   * Computes 8-hour daily capacity (excluding 1h lunch/break),
   * 60% target daily workload (288m), 40% target other task assignments (192m),
   * planned allocation %, actual utilization %, remaining assignable minutes, and over-allocation.
   */
  async getEmployeeDailyCapacityAndUtilization(employeeId, dateStr, teamName) {
    const workDate = dateStr ? toSqlDate(dateStr) : toSqlDate(new Date());

    // 1. Effective Capacity: Baseline = 480 minutes (8 actual working hours, 1h lunch & break excluded)
    const BASELINE_MINUTES = 480;
    const DAILY_WORKLOAD_RATIO = 0.60;   // 60% for Daily Workload / CRM regular calls & routine (288 mins = 4h 48m)
    const TASK_ASSIGNMENT_RATIO = 0.40;  // 40% for Other Task Assignments & Projects (192 mins = 3h 12m)
    let effectiveCapacity = BASELINE_MINUTES;

    // Check if employee is on leave today (safe try/catch so leaves schema variations never break capacity)
    let leaveDetails = null;
    let isOnLeave = false;
    try {
      const leave = await this.db.get(
        `SELECT leave_duration, reason FROM leaves 
         WHERE employee_id = ? AND UPPER(status) = 'APPROVED'
           AND start_date <= ? AND end_date >= ?
         LIMIT 1`,
        [employeeId, workDate, workDate]
      );

      if (leave) {
        isOnLeave = true;
        const dur = String(leave.leave_duration || '').toUpperCase();
        leaveDetails = {
          duration: leave.leave_duration || 'FULL_DAY',
          reason: leave.reason || ''
        };
        if (dur === 'FULL_DAY') {
          effectiveCapacity = 0;
        } else if (dur === 'HALF_DAY') {
          effectiveCapacity = 240; // 4.0 working hours
        }
      }
    } catch (leaveErr) {
      // leaves table not present or column difference - retain baseline capacity
    }

    const targetCapacityBaseline = effectiveCapacity > 0 ? effectiveCapacity : BASELINE_MINUTES;
    const dailyWorkloadTargetMinutes = Math.round(targetCapacityBaseline * DAILY_WORKLOAD_RATIO); // 288m (4h 48m)
    const taskAssignmentsTargetMinutes = Math.round(targetCapacityBaseline * TASK_ASSIGNMENT_RATIO); // 192m (3h 12m)

    // 2. Planned Workload: Connect Tasks Daily Allocations (Other task assignments)
    const allocRow = await this.db.get(
      `SELECT SUM(allocated_minutes) AS total_alloc 
       FROM connect_task_daily_allocations 
       WHERE employee_id = ? AND work_date = ?`,
      [employeeId, workDate]
    );
    let taskAllocMinutes = parseInt(allocRow?.total_alloc || '0', 10);

    // Fallback: If no explicit daily allocation is found for this work_date, check active tasks in connect_task_tasks
    if (taskAllocMinutes === 0) {
      try {
        const activeTasksRow = await this.db.get(
          `SELECT SUM(COALESCE(NULLIF(estimated_minutes, 0), 30)) AS fallback_alloc, COUNT(*) as active_count
           FROM connect_task_tasks
           WHERE owner_employee_id = ?
             AND status IN ('OPEN', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD')
             AND (deadline IS NULL OR DATE(deadline) >= ?)`,
          [employeeId, workDate]
        );
        if (activeTasksRow && parseInt(activeTasksRow.active_count || '0', 10) > 0) {
          taskAllocMinutes = parseInt(activeTasksRow.fallback_alloc || '0', 10);
        }
      } catch (fallbackErr) {
        // Safe ignore
      }
    }

    // 3. Planned Workload: CRM Regular Tasks for today (60% Daily Workload)
    const crmWorkload = await this.getCrmRegularWorkload(employeeId, teamName, workDate);
    const crmMinutes = crmWorkload.scheduledTodayMinutes || 0;

    const totalPlannedMinutes = taskAllocMinutes + crmMinutes;

    // 4. Actual Worked Time
    const timeRow = await this.db.get(
      `SELECT SUM(duration_minutes) AS total_actual
       FROM connect_task_time_entries
       WHERE employee_id = ? AND work_date = ?`,
      [employeeId, workDate]
    );
    const actualMinutesWorked = parseInt(timeRow?.total_actual || '0', 10);

    // 5. Calculations
    let plannedAllocationPct = 0;
    let actualUtilizationPct = 0;
    let dailyWorkloadPct = 0;
    let taskAssignmentsPct = 0;

    if (effectiveCapacity > 0) {
      plannedAllocationPct = Math.round((totalPlannedMinutes / effectiveCapacity) * 100);
      actualUtilizationPct = Math.round((actualMinutesWorked / effectiveCapacity) * 100);
      dailyWorkloadPct = dailyWorkloadTargetMinutes > 0 ? Math.round((crmMinutes / dailyWorkloadTargetMinutes) * 100) : 0;
      taskAssignmentsPct = taskAssignmentsTargetMinutes > 0 ? Math.round((taskAllocMinutes / taskAssignmentsTargetMinutes) * 100) : 0;
    } else {
      // Full-day leave (effectiveCapacity === 0): Calculate against baseline 480m so planned workloads are not shown as 0%
      plannedAllocationPct = Math.round((totalPlannedMinutes / BASELINE_MINUTES) * 100);
      actualUtilizationPct = Math.round((actualMinutesWorked / BASELINE_MINUTES) * 100);
      dailyWorkloadPct = dailyWorkloadTargetMinutes > 0 ? Math.round((crmMinutes / dailyWorkloadTargetMinutes) * 100) : 0;
      taskAssignmentsPct = taskAssignmentsTargetMinutes > 0 ? Math.round((taskAllocMinutes / taskAssignmentsTargetMinutes) * 100) : 0;
    }

    const remainingAssignableMinutes = Math.max(0, effectiveCapacity - actualMinutesWorked - totalPlannedMinutes);
    const remainingTaskQuotaMinutes = Math.max(0, taskAssignmentsTargetMinutes - taskAllocMinutes);
    const remainingDailyWorkloadQuotaMinutes = Math.max(0, dailyWorkloadTargetMinutes - crmMinutes);
    const overAllocationMinutes = effectiveCapacity > 0
      ? Math.max(0, actualMinutesWorked + totalPlannedMinutes - effectiveCapacity)
      : 0; // If on full day leave, it's not a standard shift overflow, it's leave!
    const isTaskQuotaExceeded = effectiveCapacity > 0 && taskAllocMinutes > taskAssignmentsTargetMinutes;
    const isOverAllocated = effectiveCapacity > 0 && overAllocationMinutes > 0;

    return {
      employeeId,
      workDate,
      effectiveCapacity,
      baselineMinutes: BASELINE_MINUTES,
      dailyWorkloadTargetMinutes,
      taskAssignmentsTargetMinutes,
      dailyWorkloadPct,
      taskAssignmentsPct,
      taskAllocMinutes,
      crmMinutes,
      totalPlannedMinutes,
      actualMinutesWorked,
      plannedAllocationPct,
      actualUtilizationPct,
      remainingAssignableMinutes,
      remainingTaskQuotaMinutes,
      remainingDailyWorkloadQuotaMinutes,
      overAllocationMinutes,
      isTaskQuotaExceeded,
      isOverAllocated,
      isOnLeave,
      leaveDetails
    };
  }

  /**
   * Returns list of all active staff members for assignment and capacity planning.
   */
  async getTeamMembers() {
    const rows = await this.db.all(
      `SELECT e.employee_id, 
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''), u.username, CONCAT('Employee #', e.employee_id)) AS name,
              e.team_id, tm.team_name AS department, e.designation, u.user_id, u.username
       FROM employees e
       LEFT JOIN teams tm ON e.team_id = tm.team_id
       LEFT JOIN users u ON u.employee_id = e.employee_id
       WHERE e.status = 'ACTIVE' OR e.status IS NULL
       ORDER BY e.first_name ASC, e.last_name ASC`
    );
    return rows;
  }

  /**
   * Returns team-wide capacity summary for all active team members.
   */
  async getTeamCapacitySummary(dateStr) {
    const members = await this.getTeamMembers();
    const result = [];
    for (const m of members) {
      const cap = await this.getEmployeeDailyCapacityAndUtilization(m.employee_id, dateStr, m.department);
      result.push({
        employee_id: m.employee_id,
        team_id: m.team_id,
        name: m.name || m.username || `Employee #${m.employee_id}`,
        department: m.department || 'General',
        designation: m.designation || 'Staff',
        capacity: cap
      });
    }
    return result;
  }

  // =========================================================================
  // 7. EVENT WORKSPACES (FGS, FGC, WEBINAR, ACADEMY)
  // =========================================================================

  /**
   * Creates an event workspace with optional parallel multi-team workstream generation.
   */
  async createEvent(data, actor) {
    const id = uuidv4();
    const now = new Date();
    const sqlNow = toSqlDatetime(now);

    const eventName = String(data.event_name || '').trim();
    if (!eventName) throw new Error('Event name is required.');

    const eventCode = data.event_code || `EVT-${eventName.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)}-${now.getFullYear()}`;
    const eventDate = toSqlDate(data.event_date);
    if (!eventDate) throw new Error('Valid event date is required.');

    await this.db.run(
      `INSERT INTO connect_task_events (
        id, event_name, event_code, program_type, delivery_mode,
        event_date, venue_or_link, owner_employee_id, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PLANNING', ?, ?, ?)`,
      [
        id,
        eventName,
        eventCode,
        data.program_type || 'OTHER',
        data.delivery_mode || 'ONLINE',
        eventDate,
        data.venue_or_link || '',
        data.owner_employee_id ? parseInt(data.owner_employee_id, 10) : null,
        data.notes || '',
        sqlNow,
        sqlNow
      ]
    );

    // Optionally instantiate standard cross-team workstream template tasks
    if (data.instantiate_template) {
      await this._instantiateEventTemplate(id, data.program_type, eventDate, actor);
    }

    return await this.getEventById(id);
  }

  async getEvents() {
    const rows = await this.db.all(
      `SELECT ev.*, CONCAT(e.first_name, ' ', e.last_name) AS owner_name,
              COUNT(t.id) AS total_tasks,
              SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_tasks
       FROM connect_task_events ev
       LEFT JOIN employees e ON ev.owner_employee_id = e.employee_id
       LEFT JOIN connect_task_tasks t ON ev.id = t.event_id
       GROUP BY ev.id
       ORDER BY ev.event_date ASC`
    );
    return rows.map(r => ({
      ...r,
      total_tasks: parseInt(r.total_tasks || '0', 10),
      completed_tasks: parseInt(r.completed_tasks || '0', 10),
      progress_pct: r.total_tasks > 0 ? Math.round((r.completed_tasks / r.total_tasks) * 100) : 0
    }));
  }

  async getEventById(eventId) {
    const row = await this.db.get(
      `SELECT ev.*, CONCAT(e.first_name, ' ', e.last_name) AS owner_name
       FROM connect_task_events ev
       LEFT JOIN employees e ON ev.owner_employee_id = e.employee_id
       WHERE ev.id = ?`,
      [eventId]
    );
    if (!row) return null;

    const tasks = await this.getTasks({ event_id: eventId });
    return { ...row, tasks };
  }

  async _instantiateEventTemplate(eventId, programType, eventDateStr, actor) {
    const eventDate = new Date(eventDateStr);

    const templates = [
      {
        title: `[Digital] Create Promotional Creatives & Ad Assets for ${programType}`,
        teamName: 'Digital',
        daysOffset: -10,
        estimatedMinutes: 180,
        priority: 'HIGH'
      },
      {
        title: `[Sales] Lead Outreach & Ticket Counselling for ${programType}`,
        teamName: 'Sales',
        daysOffset: -7,
        estimatedMinutes: 240,
        priority: 'HIGH'
      },
      {
        title: `[Operations] Venue / Streaming & Logistics Setup for ${programType}`,
        teamName: 'Operations',
        daysOffset: -3,
        estimatedMinutes: 180,
        priority: 'CRITICAL'
      },
      {
        title: `[Accounts] Event Budget Clearance & Registration Reconciliation`,
        teamName: 'HR',
        daysOffset: 1,
        estimatedMinutes: 120,
        priority: 'NORMAL'
      }
    ];

    for (const tpl of templates) {
      // Find team ID
      const teamRow = await this.db.get("SELECT team_id FROM teams WHERE team_name LIKE ? LIMIT 1", [`%${tpl.teamName}%`]);
      const teamId = teamRow?.team_id || null;

      // Find team member or default to actor
      const empRow = teamId ? await this.db.get("SELECT employee_id FROM employees WHERE team_id = ? LIMIT 1", [teamId]) : null;
      const ownerEmployeeId = empRow?.employee_id || actor?.employeeId || 1;

      const targetDeadline = new Date(eventDate);
      targetDeadline.setDate(targetDeadline.getDate() + tpl.daysOffset);

      await this.createTask({
        title: tpl.title,
        description: `Automated cross-team task for ${programType} event`,
        team_id: teamId,
        owner_employee_id: ownerEmployeeId,
        event_id: eventId,
        priority: tpl.priority,
        estimated_minutes: tpl.estimatedMinutes,
        deadline: targetDeadline.toISOString(),
        source: 'EVENT',
        task_type: 'EVENT_WORK'
      }, actor);
    }
  }

  // =========================================================================
  // 8. AUDIT LOGGING & FORMATTING
  // =========================================================================

  async logAudit({ taskId, actorUserId, actorEmployeeId, action, details }) {
    try {
      await this.db.run(
        `INSERT INTO connect_task_audit_log (task_id, actor_user_id, actor_employee_id, action, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [taskId || null, actorUserId || null, actorEmployeeId || null, action, JSON.stringify(details || {})]
      );
    } catch (e) {
      console.error('[TaskService] Audit log error:', e.message);
    }
  }

  _formatTaskRecord(r) {
    const deadlineDate = r.deadline ? new Date(r.deadline) : null;
    const now = new Date();
    let isOverdue = false;
    let overdueHours = 0;
    let overdueDays = 0;
    let overdueText = '';

    if (deadlineDate && r.status !== 'COMPLETED' && r.status !== 'CANCELLED') {
      const diffMs = now.getTime() - deadlineDate.getTime();
      if (diffMs > 0) {
        isOverdue = true;
        overdueHours = Math.floor(diffMs / (1000 * 60 * 60));
        overdueDays = Math.floor(overdueHours / 24);
        if (overdueDays >= 1) {
          overdueText = `Overdue by ${overdueDays} day${overdueDays > 1 ? 's' : ''}`;
        } else {
          overdueText = `Overdue by ${overdueHours}h`;
        }
      }
    }

    return {
      ...r,
      due_date: r.deadline,
      actual_minutes: parseInt(r.actual_minutes || r.actual_logged_minutes || '0', 10),
      contributor_count: parseInt(r.contributor_count || '0', 10),
      previous_owner_name: r.previous_owner_name || null,
      previous_team_name: r.previous_team_name || null,
      handoff_notes: r.handoff_notes || null,
      is_overdue: isOverdue,
      overdue_hours: overdueHours,
      overdue_days: overdueDays,
      overdue_text: overdueText,
      badge_color: isOverdue ? 'red' : (r.status === 'COMPLETED' ? 'green' : 'slate')
    };
  }
}

module.exports = { TaskService };
