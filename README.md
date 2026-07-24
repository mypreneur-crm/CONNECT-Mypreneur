# Mypreneur Connect — Database-Managed Authentication

This version does not create or hardcode any user, username, password, role, or team assignment.

The senior's existing authentication database owns:

- users
- employee profiles
- passwords
- source roles
- team assignments
- activation and deactivation

Mypreneur Connect owns only application data in isolated `connect_*` tables:

- `connect_role_mappings`
- `connect_sessions`
- `connect_links`
- `connect_events`
- `connect_announcements`
- `connect_audit_logs`
- `connect_login_attempts`

## Login flow

1. User enters username/email and password.
2. Connect reads the existing `users`, `employees`, `user_roles`, `roles`, and `teams` tables.
3. Connect verifies the password using the database hash.
4. Connect looks up the source role in `connect_role_mappings`.
5. The mapping decides the Connect permission and team.
6. A user without an active mapping cannot log in to Connect.

## Required database schema from the existing tool

The defaults match the uploaded Hostinger dump:

- `users.user_id`, `users.employee_id`, `users.username`, `users.password_hash`, `users.is_active`
- `employees.employee_id`, `employees.email`, `employees.first_name`, `employees.last_name`, `employees.designation`, `employees.status`, `employees.team_id`
- `user_roles.user_id`, `user_roles.role_id`
- `roles.role_id`, `roles.role_name`
- `teams.team_id`, `teams.team_name`

Table names are configurable through `AUTH_*` environment variables. Column names are based on the uploaded dump. If the senior changes column names, update `lib/auth-provider.js` or provide a compatible SQL view.

## Password formats

Supported:

- `scrypt$<salt>$<hash>` — secure Node.js format
- 64-character legacy SHA-256 — only when `ALLOW_LEGACY_SHA256_PASSWORDS=true`

The uploaded CRM dump uses the legacy 64-character format. This is supported for compatibility, but unsalted SHA-256 should be migrated to a modern salted password hash.

## Local Node.js test

1. Install Node.js 22.5 or newer.
2. Extract the project.
3. Open PowerShell in the project folder.
4. Run `npm.cmd install`.
5. Copy `.env.example` to `.env`.
6. Add the test database connection details to `.env`.
7. Import `database/connect-schema.sql` or allow the server to create the Connect tables.
8. Ask the senior to create one database user, source role, role assignment, and a row in `connect_role_mappings`.
9. Run `npm.cmd run check-db`.
10. Run `npm.cmd run test-login -- USERNAME`.
11. Run `npm.cmd run start:env`.
12. Open `http://localhost:3000`.

## Role mapping examples

The senior chooses the source role names. Example only:

```sql
INSERT INTO connect_role_mappings
(source_role_name, portal_role, portal_team, active, created_at, updated_at)
VALUES
('CONNECT_ADMIN', 'admin', NULL, 1, NOW(), NOW()),
('CONNECT_SALES_ADMIN', 'team_admin', 'Sales Team', 1, NOW(), NOW()),
('CONNECT_SALES_MEMBER', 'member', 'Sales Team', 1, NOW(), NOW()),
('CONNECT_OPERATIONS_ADMIN', 'team_admin', 'Operations Team', 1, NOW(), NOW()),
('CONNECT_OPERATIONS_MEMBER', 'member', 'Operations Team', 1, NOW(), NOW()),
('CONNECT_HR_ADMIN', 'hr_admin', 'HR Team', 1, NOW(), NOW()),
('CONNECT_HR_MEMBER', 'member', 'HR Team', 1, NOW(), NOW()),
('CONNECT_DIGITAL_ADMIN', 'team_admin', 'Digital Team', 1, NOW(), NOW()),
('CONNECT_DIGITAL_MEMBER', 'member', 'Digital Team', 1, NOW(), NOW());
```

These are database records, not code constants. The senior may use different source role names.

## GitHub safety

Commit:

- source code
- `.env.example`
- SQL schema

Never commit:

- `.env`
- database password
- user passwords
- production uploads
- `node_modules`
