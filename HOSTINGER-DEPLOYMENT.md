# Hostinger / GitHub Deployment

## Architecture

The Connect portal and the senior's other tool may use the same Hostinger MariaDB database. Connect does not modify the other tool's users, roles, employees, or teams. Connect creates only `connect_*` application tables.

## GitHub

Push the project files to a private repository. `.env` is ignored and must never be pushed.

## Hostinger environment variables

```text
DB_HOST=localhost
DB_PORT=3306
DB_NAME=<database name>
DB_USER=<database user>
DB_PASSWORD=<database password>
DB_TABLE_PREFIX=connect_
DB_POOL_SIZE=10
DB_SSL=false

AUTH_USERS_TABLE=users
AUTH_EMPLOYEES_TABLE=employees
AUTH_USER_ROLES_TABLE=user_roles
AUTH_ROLES_TABLE=roles
AUTH_TEAMS_TABLE=teams

PORTAL_ADMIN_ROLES=ADMIN,SERVICE ADMIN
PORTAL_SALES_ADMIN_ROLES=SALES ADMIN
PORTAL_OPERATIONS_ADMIN_ROLES=OPERATION ADMIN
PORTAL_HR_ADMIN_ROLES=HR ADMIN
PORTAL_DIGITAL_ADMIN_ROLES=DIGITAL ADMIN

ALLOW_LEGACY_SHA256_PASSWORDS=true
NODE_ENV=production
HOST=0.0.0.0
TRUST_PROXY=true
DATA_DIR=<private persistent folder>
```

Set `ALLOW_LEGACY_SHA256_PASSWORDS=false` after the senior migrates password hashes to the supported scrypt format.

Do not add user passwords as environment variables. This version never seeds users.

## Build and start

```text
Node.js: 22
Build command: npm install
Start command: npm start
Entry file: server.js
```

## Database administrator responsibilities

The senior creates and manages:

- employee record
- user record
- password hash
- role record
- user-role assignment
- team assignment
- `connect_role_mappings` row for each source role allowed into Connect

A user must be active, their employee must be active, and at least one assigned role must have an active Connect mapping.

## First verification

```bash
npm run sync-roles
npm run check-db
npm run test-login -- kaviya
npm start
```

Open `/api/health`, then test every role in the browser.

## Syncing Service Admin Kaviya on Hostinger Database

If deploying to Hostinger and Kaviya does not have Service Admin access:

1. **Update Hostinger Environment Variables**:
   In the Hostinger Node.js Dashboard, set:
   `PORTAL_ADMIN_ROLES=ADMIN,SERVICE ADMIN`

2. **Execute Database SQL Script**:
   In Hostinger phpMyAdmin (SQL tab), execute [`database/hostinger-fix-kaviya-service-admin.sql`](file:///c:/Users/kaviy/OneDrive/Documents/Myprenuer/mypreneur%20connect/final%208%20%283%29/final%208/database/hostinger-fix-kaviya-service-admin.sql) or run `npm run sync-roles` via SSH.

3. **Restart the Node.js application** in Hostinger panel.

