'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { SCHEMA_STATEMENTS } = require('../lib/schema');
const { resolvePortalAccess, accessConfig, mapSourceTeam, hashScryptPassword, verifyScryptPassword, DatabaseAuthProvider } = require('../lib/auth-provider');
const { LocalFileStore } = require('../lib/file-store');

const env = {
  PORTAL_ADMIN_ROLES: 'service.admin,service_admin,service admin',
  PORTAL_SALES_ADMIN_ROLES: 'sales.admin',
  PORTAL_OPERATIONS_ADMIN_ROLES: 'operation.admin,operations.admin',
  PORTAL_HR_ADMIN_ROLES: 'hr.admin',
  PORTAL_DIGITAL_ADMIN_ROLES: 'digital.admin',
  PORTAL_SALES_TEAMS: 'Sales',
  PORTAL_OPERATIONS_TEAMS: 'Operations',
  PORTAL_HR_TEAMS: 'HR',
  PORTAL_DIGITAL_TEAMS: 'Digital',
  ALLOW_LEGACY_SHA256_PASSWORDS: 'true'
};
const config = accessConfig(env);

assert.deepEqual(resolvePortalAccess(['service.admin'], null, config), { role: 'admin', team: null });
assert.deepEqual(resolvePortalAccess(['ADMIN'], 'Sales', config), { role: 'member', team: 'Sales Team' });
assert.deepEqual(resolvePortalAccess(['EMPLOYEE'], 'Sales', config), { role: 'member', team: 'Sales Team' });
assert.deepEqual(resolvePortalAccess(['EMPLOYEE'], 'Operations', config), { role: 'member', team: 'Operations Team' });
assert.deepEqual(resolvePortalAccess(['EMPLOYEE'], 'HR', config), { role: 'member', team: 'HR Team' });
assert.deepEqual(resolvePortalAccess(['EMPLOYEE'], 'Digital', config), { role: 'member', team: 'Digital Team' });
assert.equal(mapSourceTeam('Sales', config), 'Sales Team');
assert.deepEqual(resolvePortalAccess(['EMPLOYEE'], 'Accounts', config), { role: 'member', team: 'Accounts Team' });

assert.equal(SCHEMA_STATEMENTS.length, 6);
const schemaText = SCHEMA_STATEMENTS.join('\n').toLowerCase();
for (const forbidden of ['role_mappings', 'audit_logs', 'login_attempts', 'sessions', 'users']) {
  assert.equal(schemaText.includes(forbidden), false, `Schema must not create ${forbidden}`);
}
for (const required of ['create table if not exists links', 'create table if not exists events', 'create table if not exists announcements', 'create table if not exists annonymous_message', 'create table if not exists eoq_windows', 'create table if not exists eoq_nominations']) {
  assert.equal(schemaText.includes(required), true, `Missing ${required}`);
}

(async () => {
  const encoded = await hashScryptPassword('StrongPassword@2026');
  assert.equal(await verifyScryptPassword('StrongPassword@2026', encoded), true);
  assert.equal(await verifyScryptPassword('WrongPassword', encoded), false);

  const mockDb = {};
  const provider = new DatabaseAuthProvider(mockDb, env);
  const sha = crypto.createHash('sha256').update('LegacyPassword').digest('hex');
  assert.equal(await provider.verifyPassword('LegacyPassword', sha), true);
  assert.equal(await provider.verifyPassword('WrongPassword', sha), false);

  const root = path.resolve(__dirname, '..');
  const source = [
    fs.readFileSync(path.join(root, 'server.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'lib', 'auth-provider.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'lib', 'schema.js'), 'utf8')
  ].join('\n');
  for (const forbidden of ['Jinjaa@12390', 'Sales@2026', 'Ops@2026', 'connect_role_mappings', 'connect_audit_logs']) {
    assert.equal(source.includes(forbidden), false, `Source contains forbidden value: ${forbidden}`);
  }

  const store = new LocalFileStore(path.join(__dirname, 'scratch_test_uploads'));
  assert.equal(store.allowedKinds.has('eoq'), true, 'LocalFileStore must support eoq category');
  await store.init();
  const saved = await store.save('eoq', 'test_nomination.docx', Buffer.from('test docx content'));
  assert.equal(saved.storageKey.startsWith('eoq/'), true);
  await store.remove(saved.storageKey);
  await fs.promises.rm(path.join(__dirname, 'scratch_test_uploads'), { recursive: true, force: true });

  console.log('Unit tests passed: existing database authentication, direct role/team access, three Connect tables, secure sessions, and no hardcoded users or passwords.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
