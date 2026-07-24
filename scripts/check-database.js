'use strict';

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const { initializeSchema, countRoleMappings } = require('../lib/schema');
const { DatabaseAuthProvider } = require('../lib/auth-provider');
const { TABLES } = require('../lib/table-names');

async function main() {
  const db = new MySQLDatabase(databaseConfig());
  try {
    await db.ready;
    await initializeSchema(db);
    const mappings = await countRoleMappings(db);
    const auth = new DatabaseAuthProvider(db);
    await auth.countMappedRoles();
    console.log('Database connection successful.');
    console.log(`Connect role-mapping table: ${TABLES.role_mappings}`);
    console.log(`Active Connect role mappings: ${mappings}`);
    console.log('Usernames and passwords are read only from the existing authentication tables.');
    if (!mappings) {
      console.log('ACTION REQUIRED: ask the database administrator to add role mappings before login testing.');
    }
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error('Database check failed.');
  console.error(error.message);
  process.exitCode = 1;
});
