'use strict';

const SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS links (
  id CHAR(36) NOT NULL,
  title VARCHAR(120) NOT NULL,
  url TEXT NULL,
  category ENUM('Policies','Sales Team','Operations Team','HR Team','Digital Team') NOT NULL,
  source ENUM('link','file') NOT NULL,
  file_name VARCHAR(180) NULL,
  file_type VARCHAR(180) NULL,
  file_size BIGINT UNSIGNED NULL,
  file_storage_key VARCHAR(255) NULL,
  description VARCHAR(300) NOT NULL DEFAULT '',
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  open_type ENUM('same','new') NOT NULL DEFAULT 'new',
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at VARCHAR(35) NOT NULL,
  updated_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_connect_links_category (category),
  KEY idx_connect_links_pinned (category,pinned)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS events (
  id CHAR(36) NOT NULL,
  title VARCHAR(120) NOT NULL,
  date DATE NOT NULL,
  time VARCHAR(80) NOT NULL DEFAULT '',
  type ENUM('Online','Offline','Meeting') NOT NULL DEFAULT 'Meeting',
  location VARCHAR(240) NOT NULL DEFAULT '',
  notes VARCHAR(300) NOT NULL DEFAULT '',
  created_by BIGINT UNSIGNED NULL,
  created_at VARCHAR(35) NOT NULL,
  updated_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_connect_events_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS announcements (
  id CHAR(36) NOT NULL,
  title VARCHAR(140) NOT NULL,
  date DATE NOT NULL,
  time VARCHAR(10) NOT NULL DEFAULT '',
  body VARCHAR(600) NOT NULL DEFAULT '',
  kind ENUM('none','link','file') NOT NULL DEFAULT 'none',
  link TEXT NULL,
  file_name VARCHAR(180) NULL,
  file_type VARCHAR(180) NULL,
  file_size BIGINT UNSIGNED NULL,
  file_storage_key VARCHAR(255) NULL,
  author VARCHAR(120) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at VARCHAR(35) NOT NULL,
  updated_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_connect_announcements_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS annonymous_message (
  id CHAR(36) NOT NULL,
  to_user_id BIGINT UNSIGNED NOT NULL,
  strengths TEXT NOT NULL,
  improvements TEXT NOT NULL,
  suggestions TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_connect_anon_to_user (to_user_id),
  KEY idx_connect_anon_unread (to_user_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]);

async function initializeSchema(db) {
  for (const statement of SCHEMA_STATEMENTS) await db.exec(statement);
}

module.exports = { SCHEMA_STATEMENTS, initializeSchema };
