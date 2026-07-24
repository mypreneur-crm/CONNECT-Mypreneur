'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'mysql2/promise') {
    return { createPool() { throw new Error('Unit tests do not create a real database connection.'); } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { rewritePortalTables, TABLES, validatePrefix } = require('../lib/table-names');
const { SCHEMA_STATEMENTS } = require('../lib/schema');
const {
  DatabaseAuthProvider,
  authSchemaConfig,
  validateIdentifier,
  resolvePortalAccess,
  hashScryptPassword
} = require('../lib/auth-provider');
const { LocalFileStore } = require('../lib/file-store');
Module._load = originalLoad;

(async () => {
  assert.throws(() => databaseConfig({}), /DB_HOST/);
  const config = databaseConfig({
    DB_HOST: 'localhost', DB_PORT: '3306', DB_USER: 'db_user', DB_PASSWORD: 'secret', DB_NAME: 'crm'
  });
  assert.equal(config.database, 'crm');
  assert.equal(config.multipleStatements, false);

  assert.equal(validateIdentifier('user_roles', 'TEST'), 'user_roles');
  assert.throws(() => validateIdentifier('users;DROP', 'TEST'), /letters/);
  assert.throws(() => validatePrefix('bad-prefix'), /letters/);

  const authConfig = authSchemaConfig({});
  assert.equal(authConfig.usersTable, '`users`');
  assert.equal(authConfig.rolesTable, '`roles`');

  assert.deepEqual(resolvePortalAccess([
    { source_role_name: 'SALES_MEMBER', portal_role: 'member', portal_team: 'Sales Team', mapping_active: 1 }
  ]), { role: 'member', team: 'Sales Team', sourceRoles: ['SALES_MEMBER'] });

  assert.equal(resolvePortalAccess([{ source_role_name: 'EMPLOYEE', portal_role: null }]), null);

  assert.deepEqual(resolvePortalAccess([
    { source_role_name: 'SALES_MEMBER', portal_role: 'member', portal_team: 'Sales Team', mapping_active: 1 },
    { source_role_name: 'ADMIN', portal_role: 'admin', portal_team: null, mapping_active: 1 }
  ]), { role: 'admin', team: null, sourceRoles: ['ADMIN', 'SALES_MEMBER'] });

  assert.throws(() => resolvePortalAccess([
    { source_role_name: 'SALES_ADMIN', portal_role: 'team_admin', portal_team: 'Sales Team', mapping_active: 1 },
    { source_role_name: 'OPS_ADMIN', portal_role: 'team_admin', portal_team: 'Operations Team', mapping_active: 1 }
  ]), /conflicting/i);

  const scryptHash = await hashScryptPassword('Correct-Password-2026!');
  const secureProvider = new DatabaseAuthProvider({}, { ALLOW_LEGACY_SHA256_PASSWORDS: 'false' });
  assert.equal(await secureProvider.verifyPassword('Correct-Password-2026!', scryptHash), true);
  assert.equal(await secureProvider.verifyPassword('wrong', scryptHash), false);

  const legacyHash = crypto.createHash('sha256').update('Legacy-Password').digest('hex');
  const legacyDisabled = new DatabaseAuthProvider({}, { ALLOW_LEGACY_SHA256_PASSWORDS: 'false' });
  const legacyEnabled = new DatabaseAuthProvider({}, { ALLOW_LEGACY_SHA256_PASSWORDS: 'true' });
  assert.equal(await legacyDisabled.verifyPassword('Legacy-Password', legacyHash), false);
  assert.equal(await legacyEnabled.verifyPassword('Legacy-Password', legacyHash), true);

  const authRows = [
    {
      id: 25,
      username: 'sales.person',
      password_hash: scryptHash,
      active: 1,
      alt: 'sales.person@example.com',
      first_name: 'Sales',
      last_name: 'Person',
      title: 'Executive',
      employee_status: 'ACTIVE',
      source_role_name: 'SALES_MEMBER',
      portal_role: 'member',
      portal_team: 'Sales Team',
      mapping_active: 1
    }
  ];
  const queryCalls = [];
  const fakeAuthDb = {
    async all(sql, params) { queryCalls.push({ sql, params }); return authRows; },
    async get() { return { count: 1 }; }
  };
  const provider = new DatabaseAuthProvider(fakeAuthDb, {});
  const user = await provider.findByLogin('sales.person');
  assert.equal(user.username, 'sales.person');
  assert.equal(user.role, 'member');
  assert.equal(user.team, 'Sales Team');
  assert(queryCalls[0].sql.includes('`users`'));
  assert(queryCalls[0].sql.includes('role_mappings'));

  const poolCalls = [];
  const fakePool = {
    async execute(sql, params) {
      poolCalls.push({ sql, params });
      if (/SELECT 1 AS ok/i.test(sql)) return [[{ ok: 1 }], []];
      return [{ affectedRows: 1, insertId: 1 }, []];
    },
    async getConnection() {
      return {
        async query(sql) { poolCalls.push({ sql, params: [] }); return [[], []]; },
        async execute(sql, params) { poolCalls.push({ sql, params }); return [{ affectedRows: 1 }, []]; },
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}
      };
    },
    async end() {}
  };
  const fakeDb = new MySQLDatabase(config, fakePool);
  await fakeDb.ready;
  await fakeDb.run('INSERT INTO sessions(token_hash) VALUES (?)', ['x']);
  assert(poolCalls.some(call => call.sql.includes(TABLES.sessions)));
  assert(!rewritePortalTables('SELECT * FROM users').includes('connect_users'));
  assert(rewritePortalTables('SELECT * FROM role_mappings').includes(TABLES.role_mappings));
  await fakeDb.close();

  const combinedSchema = SCHEMA_STATEMENTS.map(rewritePortalTables).join('\n');
  assert(combinedSchema.includes(TABLES.role_mappings));
  assert(!/CREATE TABLE IF NOT EXISTS\s+connect_users/i.test(combinedSchema));
  assert(!/CREATE TABLE IF NOT EXISTS\s+users/i.test(combinedSchema));

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mypreneur-connect-files-'));
  try {
    const store = new LocalFileStore(temp);
    await store.init();
    const saved = await store.save('links', 'policy.txt', Buffer.from('protected'));
    assert.equal((await store.stat(saved.storageKey)).isFile(), true);
    await store.remove(saved.storageKey);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const root = path.resolve(__dirname, '..');
  const jsFiles = [
    'server.js', 'lib/database.js', 'lib/schema.js', 'lib/auth-provider.js',
    'lib/file-store.js', 'lib/table-names.js', 'scripts/check-database.js', 'scripts/test-login.js'
  ];
  for (const file of jsFiles) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });

  const source = jsFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert(!source.includes('scryptSync'));
  assert(!source.includes('DatabaseSync'));
  assert(!source.includes('INITIAL_USERS'));
  assert(!source.includes('ALLOW_ENV_USER_SEED'));
  assert(!/ADMIN_PASSWORD|SALES_ADMIN_PASSWORD|OPS_ADMIN_PASSWORD/.test(source));
  assert(!/process\.env\.[A-Z0-9_]*PASSWORD\s*\|\|\s*['"`][^'"`]+/.test(source));

  const schemaFile = fs.readFileSync(path.join(root, 'database/connect-schema.sql'), 'utf8');
  assert(!/DROP\s+TABLE/i.test(schemaFile));
  assert(!/CREATE TABLE IF NOT EXISTS\s+(?!connect_)/i.test(schemaFile));
  assert(!/INSERT\s+INTO\s+users/i.test(schemaFile));

  const ui = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert(ui.includes('data-pin='));
  assert(ui.includes('Pinned'));
  assert(ui.includes('openInNewTab(endpoint)'));
  assert(ui.includes('Upcoming Events'));

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert(packageJson.dependencies.mysql2);
  assert(!packageJson.scripts['setup-users']);

  console.log('Unit tests passed: database-managed users, database role mapping, scrypt and optional legacy verification, isolated connect_* data, protected files, UI fixes, and no seeded or hardcoded users/passwords.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
