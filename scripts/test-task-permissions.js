'use strict';

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { TaskService } = require('../lib/tasks/task-service');
const assert = require('node:assert');

async function testTaskPermissions() {
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  console.log('Testing Task Permissions...');

  const service = new TaskService(db);

  // 1. Regular employee scoping
  console.log('1. Testing Regular Employee task filtering...');
  const regularEmpId = 22; // Swetha Hari
  const regularTasks = await service.getTasks({ owner_employee_id: regularEmpId }, { employeeId: regularEmpId });
  console.log(`  Regular employee ${regularEmpId} has ${regularTasks.length} assigned tasks.`);
  regularTasks.forEach(t => {
    assert.strictEqual(Number(t.owner_employee_id), regularEmpId, 'All tasks must belong to regular employee');
  });

  // 2. Admin all-tasks view
  console.log('2. Testing Admin task view across resources...');
  const allTasks = await service.getTasks({}, { role: 'admin' });
  console.log(`  Admin view retrieved ${allTasks.length} tasks across all resources.`);
  assert(allTasks.length >= regularTasks.length, 'Admin sees all tasks');

  console.log('\n=== TASK PERMISSION TESTS PASSED SUCCESSFULLY! ===\n');
  await db.close();
}

testTaskPermissions().catch(err => {
  console.error('Task permission test failed:', err);
  process.exit(1);
});
