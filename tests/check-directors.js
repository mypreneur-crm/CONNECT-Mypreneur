const { MySQLDatabase, databaseConfig } = require('../lib/database');
(async () => {
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  const allEmp = await db.all('SELECT employee_id, first_name, last_name, designation, manager_id FROM employees');
  console.log('All employees:', allEmp);
  process.exit(0);
})();
