'use strict';

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { hashScryptPassword } = require('../lib/auth-provider');

(async () => {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  const password = String(process.argv[3] || '').trim();
  const roleName = String(process.argv[4] || 'EMPLOYEE').trim().toUpperCase();
  const teamName = String(process.argv[5] || 'Sales').trim();

  if (!username || !password) {
    console.log('Usage: node --env-file=.env scripts/add-user.js <username> <password> [role] [team]');
    console.log('Example: node --env-file=.env scripts/add-user.js john Password@123 ADMIN Sales');
    process.exit(1);
  }

  let db;
  try {
    db = new MySQLDatabase(databaseConfig());
    await db.ready;

    const existing = await db.get('SELECT user_id FROM users WHERE LOWER(username)=?', [username]);
    const hash = await hashScryptPassword(password);

    if (existing) {
      await db.run('UPDATE users SET password_hash=?, is_active=1 WHERE user_id=?', [hash, existing.user_id]);
      console.log(`Updated password for existing user '${username}'.`);
    } else {
      let team = await db.get('SELECT team_id FROM teams WHERE LOWER(team_name)=LOWER(?)', [teamName]);
      let teamId = team?.team_id || null;

      if (!teamId) {
        const teamRes = await db.run('INSERT INTO teams (team_name) VALUES (?)', [teamName]);
        teamId = teamRes.insertId;
      }

      const empRes = await db.run(
        'INSERT INTO employees (first_name, last_name, email, designation, status, team_id) VALUES (?, ?, ?, ?, ?, ?)',
        [username, 'User', `${username}@mypreneur.in`, 'Team Member', 'ACTIVE', teamId]
      );

      const userRes = await db.run(
        'INSERT INTO users (employee_id, username, password_hash, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())',
        [empRes.insertId, username, hash]
      );

      let role = await db.get('SELECT role_id FROM roles WHERE LOWER(role_name)=LOWER(?)', [roleName]);
      let roleId = role?.role_id || null;
      if (!roleId) {
        const roleRes = await db.run('INSERT INTO roles (role_name) VALUES (?)', [roleName]);
        roleId = roleRes.insertId;
      }

      await db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [userRes.insertId, roleId]);
      console.log(`Successfully created new user '${username}' with role '${roleName}' and team '${teamName}'!`);
    }
  } catch (error) {
    console.error('Error adding user:', error.message);
  } finally {
    if (db) await db.close().catch(() => {});
  }
})();
