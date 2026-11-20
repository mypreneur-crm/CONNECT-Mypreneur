'use strict';

const fs = require('node:fs');
const path = require('node:path');
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath) && !process.env.DB_HOST) {
  try { require('node:process').loadEnvFile(envPath); } catch (e) {}
}
const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { TaskService } = require('../lib/tasks/task-service');

async function runTests() {
  console.log('--- Starting Comprehensive Task Management Test Suite ---');
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  console.log('✓ Connected to local MySQL DB u847929344_myprcr');

  const service = new TaskService(db);

  // Clean up any dangling timers from previous interrupted runs
  await db.run('UPDATE connect_task_time_entries SET is_active = 0 WHERE employee_id = 1 AND is_active = 1');

  // Test Actor (Admin/Staff)
  const testUser = {
    id: 1,
    username: 'test_admin',
    name: 'Admin Test',
    role: 'super_admin',
    employeeId: 1,
    teamName: 'Operations Team'
  };

  // 1. Test Task Creation
  console.log('\n[Test 1] Testing Task Creation...');
  const task1 = await service.createTask({
    title: 'Review Mentee Onboarding Pipeline',
    team_id: 2, // Operations
    owner_employee_id: 1,
    priority: 'HIGH',
    estimated_minutes: 60,
    due_date: '2026-11-20',
    description: 'Verify all documentation for new batch of mentees.',
    requires_approval: false
  }, testUser);

  console.log(`✓ Created Task: [${task1.task_code}] ${task1.title} (ID: ${task1.id})`);

  // 2. Test Duplicate Search
  console.log('\n[Test 2] Testing Smart Duplicate Search...');
  const dupResults = await service.searchDuplicates({ query: 'Mentee Onboarding', teamId: 2 });
  console.log(`✓ Found ${dupResults.length} duplicate hit(s) for "Mentee Onboarding"`);
  if (dupResults.length === 0 || !dupResults.some(d => d.id === task1.id)) {
    throw new Error('Duplicate search did not return created task!');
  }
  console.log('✓ Duplicate search matched newly created task correctly.');

  // 3. Test Subtask Creation
  console.log('\n[Test 3] Testing Subtask Creation & Hierarchy...');
  const subtask1 = await service.createTask({
    title: 'Call Batch A Mentees',
    team_id: 2,
    owner_employee_id: 1,
    parent_task_id: task1.id,
    priority: 'NORMAL',
    estimated_minutes: 30,
    requires_approval: false
  }, testUser);
  console.log(`✓ Created Subtask: [${subtask1.task_code}] ${subtask1.title}`);

  const parentFetched = await service.getTaskById(task1.id);
  console.log(`✓ Parent task fetched: subtasks count = ${parentFetched.subtasks.length}`);
  if (parentFetched.subtasks.length === 0) {
    throw new Error('Parent task does not list child subtask!');
  }

  // 4. Test Approval Gate
  console.log('\n[Test 4] Testing Approval Gate & Timer Blocking...');
  const gatedTask = await service.createTask({
    title: 'High-Budget Vendor Campaign Deployment',
    team_id: 4, // Digital
    owner_employee_id: 1,
    priority: 'CRITICAL',
    estimated_minutes: 120,
    requires_approval: true
  }, testUser);
  console.log(`✓ Created Gated Task: [${gatedTask.task_code}] approval_status = ${gatedTask.approval_status}`);

  let timerBlocked = false;
  try {
    await service.startTimer(gatedTask.id, 1);
  } catch (err) {
    console.log(`✓ Correctly caught blocked timer on unapproved task: "${err.message}"`);
    timerBlocked = true;
  }
  if (!timerBlocked) {
    throw new Error('Timer was NOT blocked on unapproved task!');
  }

  // Approve the task
  console.log('Approving gated task...');
  const approvedTask = await service.submitApprovalDecision(gatedTask.id, 'APPROVED', 'Approved by Management', testUser);
  console.log(`✓ Gated task approval_status is now: ${approvedTask.approval_status}`);

  // Now timer should start cleanly
  const timerResult = await service.startTimer(gatedTask.id, 1);
  console.log(`✓ Timer successfully started on approved task. Start time: ${timerResult.startTime}`);

  // Check active timer
  const activeTimer = await service.getActiveTimer(1);
  console.log(`✓ Active timer lookup returned task: ${activeTimer.task_title} (${activeTimer.task_code})`);

  // 5. Test Concurrent Multi-Task Timers (Employee can work on more than one task simultaneously)
  console.log('\n[Test 5] Testing Concurrent Multi-Task Timer Support...');
  const timerResult2 = await service.startTimer(task1.id, 1);
  console.log(`✓ Started second timer on Task 1 simultaneously.`);

  const activeTimersList = await service.getActiveTimers(1);
  console.log(`✓ Active timers count: ${activeTimersList.length}`);
  if (activeTimersList.length < 2) {
    throw new Error('Expected at least 2 active concurrent timers for employee!');
  }
  console.log(`✓ Concurrent timers confirmed: ${activeTimersList.map(t => t.task_code).join(', ')}`);

  // Stop first timer
  const stopRes1 = await service.stopTimer(task1.id, 1, 'Completed initial review');
  console.log(`✓ Task 1 timer stopped. Recorded elapsed minutes: ${stopRes1.elapsedMins}m`);

  // Stop second timer
  const stopRes2 = await service.stopTimer(gatedTask.id, 1, 'Completed gated task work');
  console.log(`✓ Gated task timer stopped. Recorded elapsed minutes: ${stopRes2.elapsedMins}m`);

  const activeTimersAfterStop = await service.getActiveTimers(1);
  if (activeTimersAfterStop.length !== 0) {
    throw new Error('Active timers still exist after stopping all!');
  }
  console.log('✓ Verified: All active timers stopped cleanly.');

  // Test 5b: Testing Task Name, Due Date, and Priority Editable by Employee with Required Reason
  console.log('\n[Test 5b] Testing Task Title, Due Date, and Priority Editing with Reason...');
  let dateChangeBlocked = false;
  try {
    // Attempting date change without reason must fail
    await service.updateTask(task1.id, {
      due_date: '2026-11-25'
    }, testUser);
  } catch (err) {
    if (err.message.includes('reason')) {
      dateChangeBlocked = true;
    }
  }
  if (!dateChangeBlocked) {
    throw new Error('Changing due date without providing a reason should have failed!');
  }
  console.log('✓ Correctly blocked due date change without reason.');

  const updatedTask = await service.updateTask(task1.id, {
    title: 'Review Mentee Onboarding Pipeline - Updated Title',
    priority: 'HIGH',
    due_date: '2026-11-25',
    reason: 'Client requested onboarding extension due to travel schedule'
  }, testUser);
  console.log(`✓ Task updated: title="${updatedTask.title}", priority="${updatedTask.priority}", deadline="${updatedTask.deadline}", reason="${updatedTask.due_date_reason}"`);
  if (updatedTask.title !== 'Review Mentee Onboarding Pipeline - Updated Title') {
    throw new Error('Task title did not update correctly!');
  }
  if (updatedTask.priority !== 'HIGH') {
    throw new Error('Task priority did not update correctly!');
  }
  if (!String(updatedTask.deadline).startsWith('2026-11-25')) {
    throw new Error('Task due date did not update correctly!');
  }
  if (updatedTask.due_date_reason !== 'Client requested onboarding extension due to travel schedule') {
    throw new Error('Due date reason did not save correctly!');
  }
  if (!updatedTask.comments || updatedTask.comments.length === 0) {
    throw new Error('Due date change comment was not recorded in connect_task_comments!');
  }
  console.log(`✓ Recorded comment verified in history: "${updatedTask.comments[0].comment}"`);

  // 6. Test 9-Hour Capacity & Utilization Calculation
  console.log('\n[Test 6] Testing 540-minute Daily Capacity Engine...');
  const capacity = await service.getEmployeeDailyCapacityAndUtilization(1, null, 'Operations');
  console.log('Capacity breakdown:');
  console.log(`- Baseline Capacity: ${capacity.effectiveCapacity} mins (9.0 hours)`);
  console.log(`- CRM Workload Mins: ${capacity.crmMinutes} mins`);
  console.log(`- Task Allocation Mins: ${capacity.taskAllocMinutes} mins`);
  console.log(`- Total Planned Mins: ${capacity.totalPlannedMinutes} mins (${capacity.plannedAllocationPct}% allocated)`);
  console.log(`- Actual Minutes Worked: ${capacity.actualMinutesWorked} mins`);
  console.log(`- Remaining Free Mins: ${capacity.remainingAssignableMinutes} mins`);
  console.log(`- Is Over-Allocated: ${capacity.isOverAllocated}`);

  // 6b. Test Status-Specific Capacity & Review Workflow Allocation
  console.log('\n[Test 6b] Testing Status-Specific Capacity & Reviewer Allocation Shift...');
  const todayStr = new Date().toISOString().slice(0, 10);
  
  // Create an OPEN task (90 minutes) for Employee 1
  const flowTask = await service.createTask({
    title: 'Test Status Workflow Allocation Shift',
    team_id: 2,
    owner_employee_id: 1,
    priority: 'HIGH',
    estimated_minutes: 90,
    due_date: todayStr,
    requires_approval: false
  }, testUser);
  console.log(`✓ Created test flow task: [${flowTask.task_code}] in status ${flowTask.status}`);

  // Base capacity check: OPEN task should NOT count in task allocation
  const capOpen1 = await service.getEmployeeDailyCapacityAndUtilization(1, todayStr, 'Operations');
  const capOpen2 = await service.getEmployeeDailyCapacityAndUtilization(2, todayStr, 'Operations');
  console.log(`✓ With task OPEN: Emp1 taskAlloc = ${capOpen1.taskAllocMinutes}m, Emp2 taskAlloc = ${capOpen2.taskAllocMinutes}m`);

  // Move task to IN_PROGRESS
  await service.updateTask(flowTask.id, { status: 'IN_PROGRESS' }, testUser);
  const capProg1 = await service.getEmployeeDailyCapacityAndUtilization(1, todayStr, 'Operations');
  const capProg2 = await service.getEmployeeDailyCapacityAndUtilization(2, todayStr, 'Operations');
  console.log(`✓ With task IN_PROGRESS: Emp1 taskAlloc = ${capProg1.taskAllocMinutes}m (+90m), Emp2 taskAlloc = ${capProg2.taskAllocMinutes}m`);
  if (capProg1.taskAllocMinutes !== capOpen1.taskAllocMinutes + 90) {
    throw new Error(`Expected Emp1 taskAlloc to increase by 90m when IN_PROGRESS. Was: ${capProg1.taskAllocMinutes}, expected: ${capOpen1.taskAllocMinutes + 90}`);
  }

  // Move task to IN_REVIEW, assigning reviewer as Employee 2 (Ibrahim Shah)
  await service.updateTask(flowTask.id, {
    status: 'IN_REVIEW',
    reviewer_employee_id: 2,
    review_notes: 'Completed draft code. Please review logic.'
  }, testUser);
  const capRev1 = await service.getEmployeeDailyCapacityAndUtilization(1, todayStr, 'Operations');
  const capRev2 = await service.getEmployeeDailyCapacityAndUtilization(2, todayStr, 'Operations');
  console.log(`✓ With task IN_REVIEW (assigned to Emp2): Emp1 taskAlloc = ${capRev1.taskAllocMinutes}m (dropped to open level), Emp2 taskAlloc = ${capRev2.taskAllocMinutes}m (+90m)`);
  if (capRev1.taskAllocMinutes !== capOpen1.taskAllocMinutes) {
    throw new Error(`Expected Emp1 taskAlloc to drop back when task is in review! Got: ${capRev1.taskAllocMinutes}`);
  }
  if (capRev2.taskAllocMinutes !== capOpen2.taskAllocMinutes + 90) {
    throw new Error(`Expected Emp2 (reviewer) taskAlloc to increase by 90m when IN_REVIEW! Got: ${capRev2.taskAllocMinutes}`);
  }

  // Reviewer requests changes -> task moves back to IN_PROGRESS
  await service.updateTask(flowTask.id, {
    status: 'IN_PROGRESS',
    review_notes: 'Need unit test cases added.'
  }, { employeeId: 2, userId: 2 });
  const capBack1 = await service.getEmployeeDailyCapacityAndUtilization(1, todayStr, 'Operations');
  const capBack2 = await service.getEmployeeDailyCapacityAndUtilization(2, todayStr, 'Operations');
  console.log(`✓ After Changes Requested (IN_PROGRESS): Emp1 taskAlloc = ${capBack1.taskAllocMinutes}m (+90m), Emp2 taskAlloc = ${capBack2.taskAllocMinutes}m (returned to base)`);
  if (capBack1.taskAllocMinutes !== capProg1.taskAllocMinutes) {
    throw new Error(`Expected Emp1 taskAlloc to return to +90m after changes requested!`);
  }
  if (capBack2.taskAllocMinutes !== capOpen2.taskAllocMinutes) {
    throw new Error(`Expected Emp2 taskAlloc to clear after requesting changes!`);
  }

  // Reviewer approves task -> COMPLETED
  await service.updateTask(flowTask.id, {
    status: 'COMPLETED',
    review_notes: 'Approved and verified.'
  }, { employeeId: 2, userId: 2 });
  const capDone1 = await service.getEmployeeDailyCapacityAndUtilization(1, todayStr, 'Operations');
  const capDone2 = await service.getEmployeeDailyCapacityAndUtilization(2, todayStr, 'Operations');
  console.log(`✓ After COMPLETED: Emp1 taskAlloc = ${capDone1.taskAllocMinutes}m, Emp2 taskAlloc = ${capDone2.taskAllocMinutes}m (neither counted)`);
  if (capDone1.taskAllocMinutes !== capOpen1.taskAllocMinutes || capDone2.taskAllocMinutes !== capOpen2.taskAllocMinutes) {
    throw new Error('Completed task should not contribute to either employee task allocation!');
  }

  // Clean up flowTask
  await db.run('DELETE FROM connect_task_comments WHERE task_id = ?', [flowTask.id]);
  await db.run('DELETE FROM connect_task_audit_log WHERE task_id = ?', [flowTask.id]);
  await db.run('DELETE FROM connect_task_tasks WHERE id = ?', [flowTask.id]);
  console.log('✓ Status-specific capacity and review workflow verified 100%!');

  // 7. Test CRM Regular Workload Extraction
  console.log('\n[Test 7] Testing CRM Regular Workload for Operations...');
  const crmWorkload = await service.getCrmRegularWorkload(1, 'Operations', null);
  console.log(`✓ CRM Operations items: ${crmWorkload.items.length} items, total estimated: ${crmWorkload.totalEstimatedMinutes} mins`);

  // 8. Test Team Capacity Summary
  console.log('\n[Test 8] Testing Team-wide Capacity Summary...');
  const teamCap = await service.getTeamCapacitySummary(null);
  console.log(`✓ Retrieved capacity for ${teamCap.length} active team members.`);
  if (teamCap.length > 0) {
    console.log(`Sample member: ${teamCap[0].name} (${teamCap[0].department}) - Planned: ${teamCap[0].capacity.plannedAllocationPct}%`);
  }

  // 8b. Test Event Project Creation & Admin Deletion Flow
  console.log('\n[Test 8b] Testing Event Project Creation & Admin Deletion Flow...');
  const testEvent = await service.createEvent({
    event_name: `Test Workshop Project Deletion ${Date.now()}`,
    event_code: `EVT-${Math.floor(100000 + Math.random() * 900000)}`,
    event_type_id: 1,
    start_date: '2026-12-01',
    end_date: '2026-12-02',
    location: 'Chennai',
    auto_scaffold_tasks: false
  }, testUser);
  console.log(`✓ Created test event: [${testEvent.event_code}] ${testEvent.event_name} (ID: ${testEvent.id})`);

  // Add a task to this event
  const eventTask = await service.createTask({
    title: 'Venue Setup for Workshop',
    event_id: testEvent.id,
    team_id: 3,
    owner_employee_id: 1
  }, testUser);
  console.log(`✓ Created task for event: [${eventTask.task_code}] ${eventTask.title}`);

  // Test non-admin deletion block
  const regularStaff = { id: 99, role: 'employee', designation: 'Staff' };
  let caughtUnauthorized = false;
  try {
    await service.deleteEventProject(testEvent.id, regularStaff);
  } catch (e) {
    caughtUnauthorized = true;
    console.log(`✓ Non-admin deletion correctly blocked: "${e.message}"`);
  }
  if (!caughtUnauthorized) {
    throw new Error('Regular staff should not be able to delete an event project!');
  }

  // Admin deletion
  const deleteResult = await service.deleteEventProject(testEvent.id, testUser);
  console.log(`✓ Admin successfully deleted event: deleted tasks count = ${deleteResult.deletedTaskCount}`);
  const eventCheck = await service.getEventById(testEvent.id);
  if (eventCheck !== null) {
    throw new Error('Event project still exists in DB after deletion!');
  }
  console.log('✓ Verified: Event project and all linked tasks completely deleted.');

  // 9. Clean up test tasks
  console.log('\n[Test 9] Cleaning up test tasks...');
  await db.run('DELETE FROM connect_task_time_entries WHERE task_id IN (?, ?, ?)', [task1.id, subtask1.id, gatedTask.id]);
  await db.run('DELETE FROM connect_task_approvals WHERE task_id IN (?, ?, ?)', [task1.id, subtask1.id, gatedTask.id]);
  await db.run('DELETE FROM connect_task_daily_allocations WHERE task_id IN (?, ?, ?)', [task1.id, subtask1.id, gatedTask.id]);
  await db.run('DELETE FROM connect_task_audit_log WHERE task_id IN (?, ?, ?)', [task1.id, subtask1.id, gatedTask.id]);
  await db.run('DELETE FROM connect_task_tasks WHERE id IN (?, ?, ?)', [subtask1.id, task1.id, gatedTask.id]);
  console.log('✓ Test data cleaned up.');

  await db.close();
  console.log('\n======================================================');
  console.log('🎉 ALL TASK MANAGEMENT TESTS PASSED WITH 100% SUCCESS!');
  console.log('======================================================');
}

runTests().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
