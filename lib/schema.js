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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS eoq_windows (
  id CHAR(36) NOT NULL,
  year INT NOT NULL,
  quarter ENUM('Q1','Q2','Q3','Q4') NOT NULL,
  status ENUM('upcoming','open','closed') NOT NULL DEFAULT 'upcoming',
  start_time VARCHAR(35) NOT NULL DEFAULT '',
  end_time VARCHAR(35) NOT NULL DEFAULT '',
  created_at VARCHAR(35) NOT NULL,
  updated_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY idx_eoq_year_quarter (year, quarter)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS eoq_nominations (
  id CHAR(36) NOT NULL,
  app_code VARCHAR(50) NOT NULL DEFAULT '',
  year INT NOT NULL,
  quarter ENUM('Q1','Q2','Q3','Q4') NOT NULL,
  role ENUM('Employee','Manager') NOT NULL DEFAULT 'Employee',
  nominated_employee_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  nominated_employee_name VARCHAR(180) NOT NULL DEFAULT '',
  submitted_by_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  submitted_by_name VARCHAR(180) NOT NULL DEFAULT '',
  file_name VARCHAR(180) NULL,
  file_type VARCHAR(180) NULL,
  file_size BIGINT UNSIGNED NULL,
  file_storage_key VARCHAR(255) NULL,
  before_after_json LONGTEXT NULL,
  achievement_details TEXT NULL,
  benefits_json LONGTEXT NULL,
  skills_values_json LONGTEXT NULL,
  evidence_json LONGTEXT NULL,
  status ENUM('Draft','Submitted','Under Review','Reopened for Editing','Resubmitted','Approved','Not Approved') NOT NULL DEFAULT 'Draft',
  submitted_at VARCHAR(35) NOT NULL DEFAULT '',
  reopen_reason TEXT NULL,
  manager_comments TEXT NULL,
  reviewed_by_id BIGINT UNSIGNED NULL,
  reviewed_by_name VARCHAR(180) NULL,
  reviewed_at VARCHAR(35) NOT NULL DEFAULT '',
  created_at VARCHAR(35) NOT NULL,
  updated_at VARCHAR(35) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY idx_eoq_year_quarter_user (year, quarter, submitted_by_id),
  KEY idx_eoq_year_quarter_nominee (year, quarter, nominated_employee_id),
  KEY idx_eoq_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]);

async function initializeSchema(db) {
  for (const statement of SCHEMA_STATEMENTS) await db.exec(statement);

  const eoqNomCols = [
    { col: 'app_code', type: "VARCHAR(50) NOT NULL DEFAULT ''" },
    { col: 'role', type: "ENUM('Employee','Manager') NOT NULL DEFAULT 'Employee'" },
    { col: 'nominated_employee_id', type: 'BIGINT UNSIGNED NOT NULL DEFAULT 0' },
    { col: 'nominated_employee_name', type: "VARCHAR(180) NOT NULL DEFAULT ''" },
    { col: 'submitted_by_id', type: 'BIGINT UNSIGNED NOT NULL DEFAULT 0' },
    { col: 'submitted_by_name', type: "VARCHAR(180) NOT NULL DEFAULT ''" },
    { col: 'file_name', type: 'VARCHAR(180) NULL' },
    { col: 'file_type', type: 'VARCHAR(180) NULL' },
    { col: 'file_size', type: 'BIGINT UNSIGNED NULL' },
    { col: 'file_storage_key', type: 'VARCHAR(255) NULL' },
    { col: 'before_after_json', type: 'LONGTEXT NULL' },
    { col: 'achievement_details', type: 'TEXT NULL' },
    { col: 'benefits_json', type: 'LONGTEXT NULL' },
    { col: 'skills_values_json', type: 'LONGTEXT NULL' },
    { col: 'evidence_json', type: 'LONGTEXT NULL' },
    { col: 'status', type: "ENUM('Draft','Submitted','Under Review','Reopened for Editing','Resubmitted','Approved','Not Approved') NOT NULL DEFAULT 'Draft'" },
    { col: 'submitted_at', type: "VARCHAR(35) NOT NULL DEFAULT ''" },
    { col: 'reopen_reason', type: 'TEXT NULL' },
    { col: 'manager_comments', type: 'TEXT NULL' },
    { col: 'reviewed_by_id', type: 'BIGINT UNSIGNED NULL' },
    { col: 'reviewed_by_name', type: 'VARCHAR(180) NULL' },
    { col: 'reviewed_at', type: "VARCHAR(35) NOT NULL DEFAULT ''" },
    { col: 'updated_at', type: "VARCHAR(35) NOT NULL DEFAULT ''" }
  ];

  for (const c of eoqNomCols) {
    try {
      await db.exec(`ALTER TABLE eoq_nominations ADD COLUMN ${c.col} ${c.type}`);
    } catch (e) {}
  }

  const eoqWinCols = [
    { col: 'status', type: "ENUM('upcoming','open','closed') NOT NULL DEFAULT 'upcoming'" },
    { col: 'start_time', type: "VARCHAR(35) NOT NULL DEFAULT ''" },
    { col: 'end_time', type: "VARCHAR(35) NOT NULL DEFAULT ''" }
  ];

  for (const c of eoqWinCols) {
    try {
      await db.exec(`ALTER TABLE eoq_windows ADD COLUMN ${c.col} ${c.type}`);
    } catch (e) {}
  }
}

module.exports = { SCHEMA_STATEMENTS, initializeSchema };
