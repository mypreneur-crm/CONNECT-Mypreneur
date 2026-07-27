'use strict';

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { initializeSchema } = require('../lib/schema');
const { DatabaseAuthProvider } = require('../lib/auth-provider');
const { TABLES } = require('../lib/table-names');

(async () => {
  let db;
  try {
    db = new MySQLDatabase(databaseConfig());
    await db.ready;
    await initializeSchema(db);
    const auth = new DatabaseAuthProvider(db);
    const checks = await Promise.all([
      db.get(`SELECT COUNT(*) AS count FROM ${auth.schema.usersTable}`),
      db.get(`SELECT COUNT(*) AS count FROM ${auth.schema.rolesTable}`),
      db.get(`SELECT COUNT(*) AS count FROM ${auth.schema.teamsTable}`),
      db.get(`SELECT COUNT(*) AS count FROM ${auth.schema.loginHistoryTable}`)
    ]);
    console.log('Database connection successful.');
    console.log(`Existing users: ${Number(checks[0]?.count || 0)}`);
    console.log(`Existing roles: ${Number(checks[1]?.count || 0)}`);
    console.log(`Existing teams: ${Number(checks[2]?.count || 0)}`);
    console.log(`Existing login-history rows: ${Number(checks[3]?.count || 0)}`);
    console.log('Connect tables:', Object.values(TABLES).join(', '));
  } catch (error) {
    console.error('Database check failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (db) await db.close().catch(() => {});
  }
})();
