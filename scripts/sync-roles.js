'use strict';

const { MySQLDatabase, databaseConfig } = require('../lib/database');

const REAL_ROLES = Object.freeze([
  { id: 1, name: 'ADMIN', desc: 'System Administrator with full access' },
  { id: 2, name: 'EMPLOYEE', desc: 'Standard Employee/Mentor access' },
  { id: 9, name: 'HR ADMIN', desc: 'HR Manager with employee, leave and payroll access' },
  { id: 10, name: 'Reporting Manager', desc: 'Manager with team leave approval access' },
  { id: 11, name: 'SALES ADMIN', desc: 'Sales Admin' },
  { id: 12, name: 'OPERATION ADMIN', desc: 'Operational Admin Activities' },
  { id: 13, name: 'SERVICE ADMIN', desc: 'Service Administrator with Connect management access' }
]);

async function syncRoles(db) {
  // Remove legacy/incorrect roles like 'service.admin' or 'service_admin'
  const legacyRoles = await db.all("SELECT role_id FROM roles WHERE LOWER(role_name) IN ('service.admin', 'service_admin')");
  for (const leg of legacyRoles) {
    await db.run('DELETE FROM user_roles WHERE role_id=?', [leg.role_id]);
    await db.run('DELETE FROM roles WHERE role_id=?', [leg.role_id]);
  }

  // Insert or update real roles
  for (const r of REAL_ROLES) {
    const existing = await db.get('SELECT * FROM roles WHERE role_id=?', [r.id]);
    if (existing) {
      await db.run('UPDATE roles SET role_name=?, description=? WHERE role_id=?', [r.name, r.desc, r.id]);
    } else {
      await db.run('INSERT INTO roles (role_id, role_name, description) VALUES (?, ?, ?)', [r.id, r.name, r.desc]);
    }
  }

  // Assign SERVICE ADMIN (role_id 13) to user of employee_id 13
  const emp13User = await db.get('SELECT user_id, username FROM users WHERE employee_id=13');
  if (emp13User) {
    await db.run('DELETE FROM user_roles WHERE user_id=?', [emp13User.user_id]);
    await db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, 13)', [emp13User.user_id]);
    console.log(`Successfully assigned SERVICE ADMIN (role_id 13) to user '${emp13User.username}' (user_id ${emp13User.user_id}, employee_id 13).`);
  } else {
    console.log('Employee ID 13 not found in users table.');
  }

  console.log('Role sync completed successfully.');
}

if (require.main === module) {
  (async () => {
    let db;
    try {
      db = new MySQLDatabase(databaseConfig());
      await db.ready;
      await syncRoles(db);
    } catch (err) {
      console.error('Error syncing roles:', err.message);
      process.exitCode = 1;
    } finally {
      if (db) await db.close().catch(() => {});
    }
  })();
}

module.exports = { syncRoles, REAL_ROLES };
