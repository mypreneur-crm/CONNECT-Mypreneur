'use strict';

const fs = require('fs');
const path = require('path');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

async function runMigration() {
  console.log('Connecting to database...');
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  console.log('Database connected.');

  const sqlFile = path.join(__dirname, '..', 'database', 'create-task-management-schema.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');

  // Split on semicolons outside of quotes
  const statements = sql
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('SET NAMES'));

  console.log(`Executing ${statements.length} DDL statements...`);
  for (const stmt of statements) {
    if (!stmt) continue;
    try {
      await db.run(stmt);
      const match = stmt.match(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/i);
      const tableName = match ? match[1] : 'statement';
      console.log(`✓ Table created/verified: ${tableName}`);
    } catch (err) {
      console.error('Error executing statement:', stmt.slice(0, 100), err.message);
      throw err;
    }
  }

  // Verify created tables
  const tables = await db.all("SHOW TABLES LIKE 'connect_task_%'");
  console.log('\nVerified connect_task_* tables:');
  for (const t of tables) {
    console.log(` - ${Object.values(t)[0]}`);
  }

  await db.close();
  console.log('\nMigration completed successfully!');
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

