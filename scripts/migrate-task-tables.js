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

  // Ensure tasks with NULL creator_user_id are restored from audit log, or fallback to Admin (1)
  try {
    await db.run(`
      UPDATE connect_task_tasks t
      JOIN connect_task_audit_log a ON t.id = a.task_id AND a.action = 'TASK_CREATED'
      SET t.creator_user_id = a.actor_employee_id
      WHERE t.creator_user_id IS NULL AND a.actor_employee_id IS NOT NULL
    `);
    await db.run("UPDATE connect_task_tasks SET creator_user_id = 1 WHERE creator_user_id IS NULL");
    console.log("✓ Ensured accurate creator_user_id on connect_task_tasks");
  } catch (e) {
    console.warn("Could not backfill creator_user_id:", e.message);
  }

  // Ensure event_id is linked for known event-related tasks
  try {
    const academyTaskCodes = [
      'TSK-2026-0001', 'TSK-2026-0002', 'TSK-2026-0003', 'TSK-2026-0007',
      'TSK-2026-0009', 'TSK-2026-0010', 'TSK-2026-0027', 'TSK-2026-0028',
      'TSK-2026-0030', 'TSK-2026-0031', 'TSK-2026-0032', 'TSK-2026-0034',
      'TSK-2026-0035', 'TSK-2026-0038', 'TSK-2026-0039', 'TSK-2026-0046',
      'TSK-2026-0077', 'TSK-2026-0085', 'TSK-2026-0086', 'TSK-2026-0094',
      'TSK-2026-0099'
    ];
    const academyEvt = await db.get("SELECT id FROM connect_task_events WHERE event_code = 'ACDYBCH1' OR event_name LIKE '%Academy%' LIMIT 1");
    if (academyEvt) {
      const placeholders = academyTaskCodes.map(() => '?').join(',');
      await db.run(
        `UPDATE connect_task_tasks SET event_id = ?, source = 'EVENT', task_type = 'EVENT_WORK' WHERE (event_id IS NULL OR event_id = '') AND task_code IN (${placeholders})`,
        [academyEvt.id, ...academyTaskCodes]
      );
      console.log(`✓ Linked ${academyTaskCodes.length} Academy tasks to event workspace ${academyEvt.id}`);
    }

    // FGC 17 tasks
    const fgc17Evt = await db.get("SELECT id FROM connect_task_events WHERE event_code = 'FGC17' OR event_name LIKE '%FGC HOSUR%' LIMIT 1");
    if (fgc17Evt) {
      const fgc17Codes = ['TSK-2026-0018', 'TSK-2026-0045', 'TSK-2026-0054', 'TSK-2026-0055', 'TSK-2026-0059', 'TSK-2026-0060', 'TSK-2026-0064', 'TSK-2026-0074', 'TSK-2026-0076'];
      const placeholders = fgc17Codes.map(() => '?').join(',');
      await db.run(
        `UPDATE connect_task_tasks SET event_id = ?, source = 'EVENT', task_type = 'EVENT_WORK' WHERE (event_id IS NULL OR event_id = '') AND task_code IN (${placeholders})`,
        [fgc17Evt.id, ...fgc17Codes]
      );
      console.log(`✓ Linked FGC 17 tasks to event workspace ${fgc17Evt.id}`);
    }

    // FGC 18 tasks
    const fgc18Evt = await db.get("SELECT id FROM connect_task_events WHERE event_code = 'FGC18' OR event_name LIKE '%Foodpreneur Growth Conclave 18%' LIMIT 1");
    if (fgc18Evt) {
      const fgc18Codes = ['TSK-2026-0019', 'TSK-2026-0062', 'TSK-2026-0097'];
      const placeholders = fgc18Codes.map(() => '?').join(',');
      await db.run(
        `UPDATE connect_task_tasks SET event_id = ?, source = 'EVENT', task_type = 'EVENT_WORK' WHERE (event_id IS NULL OR event_id = '') AND task_code IN (${placeholders})`,
        [fgc18Evt.id, ...fgc18Codes]
      );
      console.log(`✓ Linked FGC 18 tasks to event workspace ${fgc18Evt.id}`);
    }

    // VSL tasks
    const vslEvt = await db.get("SELECT id FROM connect_task_events WHERE event_code = 'VSL' OR event_name LIKE '%VIDEO SALES LETTER%' LIMIT 1");
    if (vslEvt) {
      const vslCodes = ['TSK-2026-0089', 'TSK-2026-0090', 'TSK-2026-0091', 'TSK-2026-0093', 'TSK-2026-0100'];
      const placeholders = vslCodes.map(() => '?').join(',');
      await db.run(
        `UPDATE connect_task_tasks SET event_id = ?, source = 'EVENT', task_type = 'EVENT_WORK' WHERE (event_id IS NULL OR event_id = '') AND task_code IN (${placeholders})`,
        [vslEvt.id, ...vslCodes]
      );
      console.log(`✓ Linked VSL tasks to event workspace ${vslEvt.id}`);
    }
  } catch (linkErr) {
    console.warn("Could not backfill event_ids:", linkErr.message);
  }

  // Ensure connect_employee_messages table exists
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS connect_employee_messages (
        id CHAR(36) NOT NULL,
        from_user_id BIGINT UNSIGNED NOT NULL,
        from_employee_id BIGINT UNSIGNED NULL,
        to_employee_id BIGINT UNSIGNED NOT NULL,
        message_type ENUM('message','link') NOT NULL DEFAULT 'message',
        content TEXT NOT NULL,
        link_url TEXT NULL,
        link_title VARCHAR(255) NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        created_at VARCHAR(35) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_emp_msg_to (to_employee_id, is_read),
        KEY idx_emp_msg_thread (from_user_id, to_employee_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("✓ Table connect_employee_messages created/verified");
  } catch (e) {
    console.warn("Could not create connect_employee_messages:", e.message);
  }

  await db.close();
  console.log('\nMigration completed successfully!');
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

