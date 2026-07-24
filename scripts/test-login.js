'use strict';

const readline = require('node:readline/promises');
const process = require('node:process');
const { stdin, stdout } = require('node:process');
const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { DatabaseAuthProvider } = require('../lib/auth-provider');

async function main() {
  const username = String(process.argv[2] || '').trim();
  if (!username) throw new Error('Usage: npm run test-login -- USERNAME');

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const password = await rl.question('Password: ');
  rl.close();

  const db = new MySQLDatabase(databaseConfig());
  try {
    await db.ready;
    const auth = new DatabaseAuthProvider(db);
    const user = await auth.findByLogin(username);
    const valid = Boolean(user && user.active && await auth.verifyPassword(password, user.passwordHash));
    if (!valid) throw new Error('Login failed: invalid credentials, inactive user, unsupported password hash, or missing Connect role mapping.');
    console.log('Login test successful.');
    console.log(JSON.stringify({ username: user.username, name: user.name, role: user.role, team: user.team }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
