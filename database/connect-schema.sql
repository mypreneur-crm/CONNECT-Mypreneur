-- Mypreneur Connect application tables only.
-- This script does NOT create users, passwords, employees, teams, or source roles.
-- Authentication remains owned by the existing Hostinger tool/database.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS connect_role_mappings (
  source_role_name VARCHAR(100) NOT NULL,
  portal_role ENUM('admin','hr_admin','team_admin','member') NOT NULL,
  portal_team ENUM('Sales Team','Operations Team','HR Team','Digital Team') NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(35) NOT NULL,
  updated_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (source_role_name),
  KEY idx_connect_role_mappings_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_sessions (
  token_hash CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  csrf_token VARCHAR(80) NOT NULL,
  created_at VARCHAR(35) NOT NULL,
  last_seen_at VARCHAR(35) NOT NULL,
  expires_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_connect_sessions_user (user_id),
  KEY idx_connect_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_links (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_events (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_announcements (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  entity VARCHAR(80) NOT NULL,
  entity_id VARCHAR(100) NULL,
  details VARCHAR(1000) NOT NULL DEFAULT '',
  created_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_connect_audit_user (user_id),
  KEY idx_connect_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_login_attempts (
  attempt_key CHAR(64) NOT NULL,
  failures INT UNSIGNED NOT NULL DEFAULT 0,
  window_started VARCHAR(35) NOT NULL,
  blocked_until VARCHAR(35) NULL,
  updated_at VARCHAR(35) NOT NULL,
  PRIMARY KEY (attempt_key),
  KEY idx_connect_login_attempts_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_annonymous_message (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
