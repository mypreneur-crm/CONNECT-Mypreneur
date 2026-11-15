'use strict';

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { hashScryptPassword } = require('../lib/auth-provider');

(async () => {
  let db;
  try {
    db = new MySQLDatabase(databaseConfig());
    await db.ready;

    // 1. Ensure CEO role exists
    let ceoRole = await db.get("SELECT role_id FROM roles WHERE LOWER(role_name)='ceo'");
    if (!ceoRole) {
      const r = await db.run("INSERT INTO roles (role_name, description) VALUES (?, ?)", ['CEO', 'Chief Executive Officer with full executive review access']);
      ceoRole = { role_id: r.insertId };
    }

    // 2. Ensure Director role exists
    let dirRole = await db.get("SELECT role_id FROM roles WHERE LOWER(role_name)='director'");
    if (!dirRole) {
      const r = await db.run("INSERT INTO roles (role_name, description) VALUES (?, ?)", ['Director', 'Director with executive review access']);
      dirRole = { role_id: r.insertId };
    }

    const hash = await hashScryptPassword('admin123');

    // 3. Create or update user 'ceo' (Suresh)
    let ceoUser = await db.get("SELECT user_id, employee_id FROM users WHERE username='ceo'");
    if (!ceoUser) {
      const emp = await db.run(
        "INSERT INTO employees (employee_code, first_name, last_name, email, designation, status) VALUES (?, ?, ?, ?, ?, ?)",
        ['EMP-CEO', 'Suresh', 'CEO', 'suresh.ceo@mypreneur.in', 'CEO', 'ACTIVE']
      );
      const u = await db.run(
        "INSERT INTO users (employee_id, username, password_hash, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())",
        [emp.insertId, 'ceo', hash]
      );
      await db.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [u.insertId, ceoRole.role_id]);
      console.log('Created user: ceo (password: admin123, designation: CEO)');
    } else {
      await db.run("UPDATE employees SET designation='CEO' WHERE employee_id=?", [ceoUser.employee_id]);
      await db.run("UPDATE users SET password_hash=?, is_active=1 WHERE user_id=?", [hash, ceoUser.user_id]);
      console.log('Updated user: ceo (designation: CEO)');
    }

    // 4. Create or update user 'director' (Manoj)
    let dirUser = await db.get("SELECT user_id, employee_id FROM users WHERE username='director'");
    if (!dirUser) {
      const emp = await db.run(
        "INSERT INTO employees (employee_code, first_name, last_name, email, designation, status) VALUES (?, ?, ?, ?, ?, ?)",
        ['EMP-DIR', 'Manoj', 'Director', 'manoj.director@mypreneur.in', 'Director', 'ACTIVE']
      );
      const u = await db.run(
        "INSERT INTO users (employee_id, username, password_hash, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())",
        [emp.insertId, 'director', hash]
      );
      await db.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [u.insertId, dirRole.role_id]);
      console.log('Created user: director (password: admin123, designation: Director)');
    } else {
      await db.run("UPDATE employees SET designation='Director' WHERE employee_id=?", [dirUser.employee_id]);
      await db.run("UPDATE users SET password_hash=?, is_active=1 WHERE user_id=?", [hash, dirUser.user_id]);
      console.log('Updated user: director (designation: Director)');
    }

    console.log('Executive leadership accounts setup successfully.');
  } catch (err) {
    console.error('Failed to setup executive accounts:', err);
  } finally {
    process.exit(0);
  }
})();

