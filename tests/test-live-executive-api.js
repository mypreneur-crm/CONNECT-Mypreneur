'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

async function testLiveApi() {
  console.log('=== VERIFYING LIVE HTTP PERMISSION ENFORCEMENT ===\n');
  const baseUrl = 'http://localhost:3000';
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  // Ensure employee 10 is Operation Head at start
  await db.run('UPDATE employees SET designation="Operation Head" WHERE employee_id=10');

  const SESSION_SECRET = process.env.SESSION_SECRET || 'mypreneur_connect_local_secret_32chars_long_key_1234';

  function signSession(userId, csrf) {
    const payload = { v: 1, userId: Number(userId), csrf, exp: Date.now() + 3600000 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  async function clientFor(userId) {
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const token = signSession(userId, csrfToken);
    const cookie = `mc_session=${token}`;
    const bootRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { 'Cookie': cookie, 'X-CSRF-Token': csrfToken, 'Accept': 'application/json' }
    });
    const boot = await bootRes.json();
    return {
      user: boot.user,
      cookie,
      csrfToken
    };
  }

  // 1. Super Admin (User 5: Administrator)
  console.log('1. Testing Super Admin (User 5: Administrator)...');
  const adminClient = await clientFor(5);
  console.log(`   User: ${adminClient.user.name}, Designation/Title: ${adminClient.user.title}, Role: ${adminClient.user.role}, isExecutive: ${adminClient.user.isExecutive}`);
  assert.strictEqual(adminClient.user.isExecutive, false, 'Super Admin must NOT have isExecutive flag');

  // Attempt to access Team Reports (All Employee Reports)
  const adminTeamReports = await fetch(`${baseUrl}/api/monthly-1on1/team-reports`, {
    headers: { 'Cookie': adminClient.cookie, 'Accept': 'application/json' }
  });
  console.log(`   GET /api/monthly-1on1/team-reports status: ${adminTeamReports.status}`);
  assert.strictEqual(adminTeamReports.status, 403, 'Super Admin must receive 403 Forbidden on team reports');

  // Attempt to view EOQ
  const adminEoqRes = await fetch(`${baseUrl}/api/eoq?year=2026`, {
    headers: { 'Cookie': adminClient.cookie, 'Accept': 'application/json' }
  });
  const adminEoq = await adminEoqRes.json();
  console.log(`   EOQ userCanViewAll for Super Admin: ${adminEoq.userCanViewAll}`);
  assert.strictEqual(adminEoq.userCanViewAll, false, 'Super Admin must NOT have userCanViewAll in EOQ');
  console.log('   ✔ Super Admin is successfully blocked from viewing all employee applications!');

  // 2. Regular Employee (User 22: employee_id 13, Support Executive)
  console.log('\n2. Testing Regular Employee (User 22: Support Executive)...');
  const empClient = await clientFor(22);
  console.log(`   User: ${empClient.user.name}, Designation: ${empClient.user.title}, isExecutive: ${empClient.user.isExecutive}`);
  assert.strictEqual(empClient.user.isExecutive, false, 'Employee must not be executive');
  const empTeamReports = await fetch(`${baseUrl}/api/monthly-1on1/team-reports`, {
    headers: { 'Cookie': empClient.cookie, 'Accept': 'application/json' }
  });
  assert.strictEqual(empTeamReports.status, 403, 'Regular employee must receive 403 Forbidden');
  const empEoqRes = await fetch(`${baseUrl}/api/eoq?year=2026`, {
    headers: { 'Cookie': empClient.cookie, 'Accept': 'application/json' }
  });
  const empEoq = await empEoqRes.json();
  assert.strictEqual(empEoq.userCanViewAll, false, 'Employee must NOT have userCanViewAll');
  console.log('   ✔ Regular employee is successfully blocked from viewing all employee applications!');

  // 3. Temporarily set employee 10 to "Director" (Manoj sir simulation)
  console.log('\n3. Testing Executive Leadership (Director / CEO simulation)...');
  await db.run('UPDATE employees SET designation="Director" WHERE employee_id=10');

  try {
    const execClient = await clientFor(13); // User 13 is employee 10
    console.log(`   User: ${execClient.user.name}, Designation: ${execClient.user.title}, isExecutive: ${execClient.user.isExecutive}`);
    assert.strictEqual(execClient.user.isExecutive, true, 'Director must have isExecutive = true');

    // Access Team Reports
    const execTeamReports = await fetch(`${baseUrl}/api/monthly-1on1/team-reports?year=2026`, {
      headers: { 'Cookie': execClient.cookie, 'Accept': 'application/json' }
    });
    console.log(`   GET /api/monthly-1on1/team-reports status: ${execTeamReports.status}`);
    assert.strictEqual(execTeamReports.status, 200, 'Director must receive 200 OK on team reports');
    const repData = await execTeamReports.json();
    console.log(`   Found ${repData.reports.length} reports in leadership dashboard`);

    // Access EOQ
    const execEoqRes = await fetch(`${baseUrl}/api/eoq?year=2026`, {
      headers: { 'Cookie': execClient.cookie, 'Accept': 'application/json' }
    });
    const execEoq = await execEoqRes.json();
    console.log(`   EOQ userCanViewAll for Director: ${execEoq.userCanViewAll}`);
    assert.strictEqual(execEoq.userCanViewAll, true, 'Director must have userCanViewAll = true');
    console.log('   ✔ Director (Executive Leadership) has full access to all applications!');
  } finally {
    // Restore original designation
    await db.run('UPDATE employees SET designation="Operation Head" WHERE employee_id=10');
  }

  await db.close();
  console.log('\n=== LIVE API SECURITY VERIFICATION COMPLETE: 100% SUCCESS ===\n');
}

testLiveApi().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
