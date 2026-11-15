const { MySQLDatabase, databaseConfig } = require('../lib/database');
(async () => {
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  const rows = await db.all("SELECT id, reporting_month, status, window_start, window_end FROM monthly_1on1_reports WHERE record_type='window'");
  console.log(JSON.stringify(rows, null, 2));
  await db.close();
})();
