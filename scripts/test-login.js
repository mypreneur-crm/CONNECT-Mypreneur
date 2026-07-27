'use strict';

const readline = require('node:readline');
const { stdin, stdout } = require('node:process');
const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { DatabaseAuthProvider } = require('../lib/auth-provider');

function readPassword(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    stdout.write(prompt);
    let value = '';
    const onData = chunk => {
      const text = chunk.toString();
      for (const char of text) {
        if (char === '\n' || char === '\r') {
          stdin.off('data', onData);
          stdout.write('\n');
          rl.close();
          resolve(value);
          return;
        }
        if (char === '\u0003') process.exit(130);
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const login = String(process.argv[2] || '').trim();
  if (!login) {
    console.error('Usage: npm run test-login -- username');
    process.exitCode = 1;
    return;
  }
  const password = await readPassword('Password: ');
  let db;
  try {
    db = new MySQLDatabase(databaseConfig());
    await db.ready;
    const auth = new DatabaseAuthProvider(db);
    const user = await auth.findByLogin(login, { requireAccess: false });
    const valid = Boolean(user && user.active && user.portalAccess && await auth.verifyPassword(password, user.passwordHash));
    if (!valid) throw new Error('Login failed. Check password, role, team assignment, and access environment variables.');
    console.log('Login test successful.');
    console.log(JSON.stringify({ username: user.username, name: user.name, role: user.role, team: user.team }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (db) await db.close().catch(() => {});
  }
})();
