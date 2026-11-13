'use strict';

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath) && !process.env.DB_HOST) {
  try { require('node:process').loadEnvFile(envPath); } catch (e) {}
}
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

  // Ensure handoff columns exist on connect_task_tasks
  const existingCols = await db.all(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connect_task_tasks'"
  );
  const colNames = existingCols.map(c => c.COLUMN_NAME);
  if (!colNames.includes('previous_owner_employee_id')) {
    await db.run("ALTER TABLE connect_task_tasks ADD COLUMN previous_owner_employee_id INT NULL AFTER owner_employee_id");
    console.log("✓ Added column previous_owner_employee_id to connect_task_tasks");
  } else {
    console.log("✓ Column previous_owner_employee_id already present");
  }
  if (!colNames.includes('handoff_notes')) {
    await db.run("ALTER TABLE connect_task_tasks ADD COLUMN handoff_notes TEXT NULL AFTER description");
    console.log("✓ Added column handoff_notes to connect_task_tasks");
  } else {
    console.log("✓ Column handoff_notes already present");
  }

  // Ensure crm_event_id column exists on connect_task_events
  const eventCols = await db.all(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connect_task_events'"
  );
  const eventColNames = eventCols.map(c => c.COLUMN_NAME);
  if (!eventColNames.includes('crm_event_id')) {
    await db.run("ALTER TABLE connect_task_events ADD COLUMN crm_event_id INT NULL AFTER id, ADD UNIQUE KEY idx_task_events_crm_id (crm_event_id)");
    console.log("✓ Added column crm_event_id to connect_task_events");
  } else {
    console.log("✓ Column crm_event_id already present on connect_task_events");
  }

  // Ensure event_date can be NULL
  try {
    await db.run("ALTER TABLE connect_task_events MODIFY COLUMN event_date DATE NULL");
    console.log("✓ Ensured event_date allows NULL in connect_task_events");
  } catch (e) {
    console.warn("Could not modify event_date:", e.message);
  }

  await db.close();
  console.log('\nMigration completed successfully!');
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

