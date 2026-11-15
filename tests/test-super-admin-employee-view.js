'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

async function testSuperAdminPermissions() {
  console.log('=== VERIFYING SUPER ADMIN WINDOW CONTROLS & PERMISSIONS ===\n');
  const baseUrl = 'http://localhost:3000';
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

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
  const superAdmin = await clientFor(5);
  console.log(`1. Super Admin User: ${superAdmin.user.name}, role: ${superAdmin.user.role}`);

  // A. Super Admin CAN manually open/close/schedule Monthly Connect window
  console.log('\n--- Testing Super Admin Monthly Connect Window Controls ---');
  // Test manual-close for 2026-11
  const closeRes = await fetch(`${baseUrl}/api/monthly-1on1/windows/close`, {
    method: 'POST',
    headers: {
      'Cookie': superAdmin.cookie,
      'X-CSRF-Token': superAdmin.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ reporting_month: '2026-11', reason: 'Test Super Admin manual close' })
  });
  console.log(`   POST /api/monthly-1on1/windows/close status: ${closeRes.status}`);
  assert.strictEqual(closeRes.status, 200, 'Super Admin must be able to manually close Monthly Connect window');

  // Test manual-open for 2026-11 (reopening)
  const openRes = await fetch(`${baseUrl}/api/monthly-1on1/windows/manual-open`, {
    method: 'POST',
    headers: {
      'Cookie': superAdmin.cookie,
      'X-CSRF-Token': superAdmin.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ reporting_month: '2026-11', reason: 'Test Super Admin manual open' })
  });
  console.log(`   POST /api/monthly-1on1/windows/manual-open status: ${openRes.status}`);
  assert.strictEqual(openRes.status, 200, 'Super Admin must be able to manually open Monthly Connect window');

  // B. Super Admin CAN manually open/close/configure EOQ window
  console.log('\n--- Testing Super Admin EOQ Window Controls ---');
  const eoqWinRes = await fetch(`${baseUrl}/api/eoq/window`, {
    method: 'POST',
    headers: {
      'Cookie': superAdmin.cookie,
      'X-CSRF-Token': superAdmin.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      year: 2026,
      quarter: 'Q4',
      status: 'open',
      start_time: '2026-10-01T00:00:00',
      end_time: '2026-12-31T23:59:59'
    })
  });
  console.log(`   POST /api/eoq/window (set to open) status: ${eoqWinRes.status}`);
  assert.strictEqual(eoqWinRes.status, 200, 'Super Admin must be able to configure EOQ window');

  // Close EOQ window
  const eoqCloseWinRes = await fetch(`${baseUrl}/api/eoq/window`, {
    method: 'POST',
    headers: {
      'Cookie': superAdmin.cookie,
      'X-CSRF-Token': superAdmin.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      year: 2026,
      quarter: 'Q4',
      status: 'closed',
      start_time: '2026-10-01T00:00:00',
      end_time: '2026-12-31T23:59:59'
    })
  });
  console.log(`   POST /api/eoq/window (set to closed) status: ${eoqCloseWinRes.status}`);
  assert.strictEqual(eoqCloseWinRes.status, 200, 'Super Admin must be able to manually close EOQ window');

  // C. Super Admin CANNOT see all employees' applications in Monthly Connect
  console.log('\n--- Testing Super Admin Blocked from Viewing All Applications ---');
  const m1TeamRes = await fetch(`${baseUrl}/api/monthly-1on1/team-reports`, {
    headers: { 'Cookie': superAdmin.cookie, 'X-CSRF-Token': superAdmin.csrfToken }
  });
  console.log(`   GET /api/monthly-1on1/team-reports status: ${m1TeamRes.status}`);
  assert.strictEqual(m1TeamRes.status, 403, 'Super Admin must get 403 Forbidden on team-reports');

  // D. Super Admin CANNOT see all employees' applications in EOQ
  const eoqRes = await fetch(`${baseUrl}/api/eoq?year=2026`, {
    headers: { 'Cookie': superAdmin.cookie, 'X-CSRF-Token': superAdmin.csrfToken }
  });
  const eoqData = await eoqRes.json();
  console.log(`   GET /api/eoq userCanViewAll for Super Admin: ${eoqData.userCanViewAll}`);
  assert.strictEqual(eoqData.userCanViewAll, false, 'Super Admin must have userCanViewAll = false');

  // Super Admin cannot review EOQ nominations
  const eoqRevRes = await fetch(`${baseUrl}/api/eoq/applications/99999/review`, {
    method: 'POST',
    headers: {
      'Cookie': superAdmin.cookie,
      'X-CSRF-Token': superAdmin.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ decision: 'Approved', manager_comments: 'Test' })
  });
  console.log(`   POST /api/eoq/applications/:id/review status: ${eoqRevRes.status}`);
  assert.strictEqual(eoqRevRes.status, 403, 'Super Admin must get 403 Forbidden on EOQ review');

  // 2. Executive Leadership (Director: User 13)
  console.log('\n--- Testing Executive Leadership (Director / CEO) ---');
  await db.run('UPDATE employees SET designation="Director" WHERE employee_id=10');
  const director = await clientFor(13);
  console.log(`   Director User: ${director.user.name}, isExecutive: ${director.user.isExecutive}`);
  assert.strictEqual(director.user.isExecutive, true);

  // Director can see all applications in Monthly Connect
  const dirTeamRes = await fetch(`${baseUrl}/api/monthly-1on1/team-reports`, {
    headers: { 'Cookie': director.cookie, 'X-CSRF-Token': director.csrfToken }
  });
  console.log(`   GET /api/monthly-1on1/team-reports for Director status: ${dirTeamRes.status}`);
  assert.strictEqual(dirTeamRes.status, 200, 'Director must be able to view all team reports');

  // Director can see all applications in EOQ
  const dirEoqRes = await fetch(`${baseUrl}/api/eoq?year=2026`, {
    headers: { 'Cookie': director.cookie, 'X-CSRF-Token': director.csrfToken }
  });
  const dirEoqData = await dirEoqRes.json();
  console.log(`   GET /api/eoq userCanViewAll for Director: ${dirEoqData.userCanViewAll}`);
  assert.strictEqual(dirEoqData.userCanViewAll, true, 'Director must have userCanViewAll = true');

  // Restore employee 10 designation
  await db.run('UPDATE employees SET designation="Operation Head" WHERE employee_id=10');

  console.log('\n✔ ALL TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

testSuperAdminPermissions().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
