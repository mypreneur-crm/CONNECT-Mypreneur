-- Mypreneur Task Management System Relational Schema
-- Database: u847929344_myprcr
-- Tables prefixed with connect_task_

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS connect_task_events (
  id CHAR(36) NOT NULL,
  crm_event_id INT NULL UNIQUE,
  event_name VARCHAR(180) NOT NULL,
  event_code VARCHAR(50) NOT NULL UNIQUE,
  program_type ENUM('WEBINAR', 'ACADEMY', 'FGS', 'FGC', 'WORKSHOP', 'OTHER') NOT NULL DEFAULT 'OTHER',
  delivery_mode ENUM('ONLINE', 'OFFLINE', 'HYBRID') NOT NULL DEFAULT 'ONLINE',
  event_date DATE NOT NULL,
  venue_or_link VARCHAR(255) NULL,
  owner_employee_id INT NULL,
  status ENUM('PLANNING', 'ACTIVE', 'IN_DELIVERY', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PLANNING',
  notes TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_task_events_crm_id (crm_event_id),
  KEY idx_task_events_date (event_date),
  KEY idx_task_events_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_task_tasks (
  id CHAR(36) NOT NULL,
  task_code VARCHAR(30) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  source ENUM('MANUAL', 'CRM', 'ROUTINE', 'EVENT') NOT NULL DEFAULT 'MANUAL',
  task_type ENUM('ONE_OFF', 'REGULAR', 'EVENT_WORK', 'CONTAINER') NOT NULL DEFAULT 'ONE_OFF',
  team_id INT NULL,
  owner_employee_id INT NOT NULL,
  previous_owner_employee_id INT NULL,
  creator_user_id BIGINT UNSIGNED NULL,
  parent_task_id CHAR(36) NULL,
  event_id CHAR(36) NULL,
  priority ENUM('LOW', 'NORMAL', 'HIGH', 'CRITICAL') NOT NULL DEFAULT 'NORMAL',
  status ENUM('DRAFT', 'OPEN', 'IN_PROGRESS', 'REVIEW', 'COMPLETED', 'ON_HOLD', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
  approval_status ENUM('NOT_REQUIRED', 'PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED') NOT NULL DEFAULT 'NOT_REQUIRED',
  estimated_minutes INT NOT NULL DEFAULT 0,
  planned_start DATETIME NULL,
  deadline DATETIME NOT NULL,
  completed_at DATETIME NULL,
  crm_reference_id VARCHAR(100) NULL,
  handoff_notes TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_task_owner (owner_employee_id),
  KEY idx_task_team (team_id),
  KEY idx_task_parent (parent_task_id),
  KEY idx_task_event (event_id),
  KEY idx_task_status (status),
  KEY idx_task_approval (approval_status),
  KEY idx_task_deadline (deadline),
  KEY idx_task_crm_ref (crm_reference_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_task_daily_allocations (
  id BIGINT UNSIGNED AUTO_INCREMENT NOT NULL,
  task_id CHAR(36) NOT NULL,
  employee_id INT NOT NULL,
  work_date DATE NOT NULL,
  allocated_minutes INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_alloc_task_emp_date (task_id, employee_id, work_date),
  KEY idx_alloc_emp_date (employee_id, work_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_task_time_entries (
  id CHAR(36) NOT NULL,
  task_id CHAR(36) NOT NULL,
  employee_id INT NOT NULL,
  work_date DATE NOT NULL,
  start_time DATETIME NULL,
  end_time DATETIME NULL,
  duration_minutes INT NOT NULL DEFAULT 0,
  entry_type ENUM('TIMER', 'MANUAL', 'CRM_SYNC') NOT NULL DEFAULT 'MANUAL',
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  notes VARCHAR(500) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_time_task (task_id),
  KEY idx_time_emp_date (employee_id, work_date),
  KEY idx_time_active (employee_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_task_approvals (
  id CHAR(36) NOT NULL,
  task_id CHAR(36) NOT NULL,
  approver_employee_id INT NOT NULL,
  requested_by_employee_id INT NOT NULL,
  status ENUM('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  decision_notes TEXT NULL,
  decided_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_approval_task (task_id),
  KEY idx_approval_approver (approver_employee_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_task_dependencies (
  predecessor_task_id CHAR(36) NOT NULL,
  successor_task_id CHAR(36) NOT NULL,
  dependency_type ENUM('FINISH_TO_START') NOT NULL DEFAULT 'FINISH_TO_START',
  created_at DATETIME NOT NULL,
  PRIMARY KEY (predecessor_task_id, successor_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_task_routine_templates (
  id CHAR(36) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  team_id INT NOT NULL,
  assigned_role_or_emp VARCHAR(100) NOT NULL,
  recurrence_type ENUM('DAILY', 'SELECTED_WEEKDAYS', 'WEEKLY', 'MONTHLY') NOT NULL DEFAULT 'DAILY',
  recurrence_days VARCHAR(50) NULL,
  standard_minutes INT NOT NULL DEFAULT 60,
  requires_approval TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_routine_team (team_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connect_task_audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT NOT NULL,
  task_id CHAR(36) NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_employee_id INT NULL,
  action VARCHAR(50) NOT NULL,
  details_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_task (task_id),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

