'use strict';

const { MySQLDatabase, databaseConfig } = require('../lib/database');

async function migrate() {
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  console.log('Connected to MySQL database.');

  const statements = [
    `CREATE TABLE IF NOT EXISTS connect_chat_conversations (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      type ENUM('DIRECT', 'GROUP') NOT NULL DEFAULT 'DIRECT',
      title VARCHAR(255) NULL,
      avatar VARCHAR(255) NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at VARCHAR(35) NOT NULL,
      updated_at VARCHAR(35) NOT NULL,
      last_message_text TEXT NULL,
      last_message_at VARCHAR(35) NULL,
      KEY idx_conv_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS connect_chat_members (
      conversation_id VARCHAR(36) NOT NULL,
      employee_id BIGINT UNSIGNED NOT NULL,
      joined_at VARCHAR(35) NOT NULL,
      last_read_message_id VARCHAR(36) NULL,
      last_read_at VARCHAR(35) NULL,
      PRIMARY KEY (conversation_id, employee_id),
      KEY idx_chat_members_emp (employee_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS connect_chat_messages (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      conversation_id VARCHAR(36) NOT NULL,
      sender_employee_id BIGINT UNSIGNED NOT NULL,
      sender_user_id BIGINT UNSIGNED NULL,
      message_type ENUM('TEXT', 'IMAGE', 'FILE', 'CALL_LOG') NOT NULL DEFAULT 'TEXT',
      content TEXT NOT NULL,
      file_url VARCHAR(500) NULL,
      file_name VARCHAR(255) NULL,
      file_size BIGINT UNSIGNED NULL,
      file_type VARCHAR(100) NULL,
      created_at VARCHAR(35) NOT NULL,
      KEY idx_chat_msg_conv (conversation_id, created_at),
      KEY idx_chat_msg_sender (sender_employee_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS connect_employee_presence (
      employee_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      status ENUM('ONLINE', 'AWAY', 'OFFLINE') NOT NULL DEFAULT 'OFFLINE',
      custom_status VARCHAR(255) NULL,
      last_heartbeat BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at VARCHAR(35) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS connect_chat_calls (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      caller_employee_id BIGINT UNSIGNED NOT NULL,
      receiver_employee_id BIGINT UNSIGNED NOT NULL,
      conversation_id VARCHAR(36) NULL,
      call_type ENUM('AUDIO', 'VIDEO') NOT NULL DEFAULT 'AUDIO',
      status ENUM('RINGING', 'ACCEPTED', 'DECLINED', 'ENDED', 'MISSED', 'BUSY') NOT NULL DEFAULT 'RINGING',
      sdp_offer LONGTEXT NULL,
      sdp_answer LONGTEXT NULL,
      caller_ice LONGTEXT NULL,
      callee_ice LONGTEXT NULL,
      started_at VARCHAR(35) NOT NULL,
      connected_at VARCHAR(35) NULL,
      ended_at VARCHAR(35) NULL,
      KEY idx_call_active (receiver_employee_id, status),
      KEY idx_call_caller (caller_employee_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];

  for (const sql of statements) {
    try {
      await db.exec(sql);
      console.log('Executed statement successfully.');
    } catch (err) {
      console.error('Migration error on statement:', err.message);
    }
  }

  console.log('Chat tables migration completed successfully!');
  await db.close();
}

migrate().catch(err => {
  console.error('Fatal migration failure:', err);
  process.exit(1);
});
