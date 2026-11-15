const { MySQLDatabase, databaseConfig } = require('../lib/database');

(async () => {
  const db = new MySQLDatabase(databaseConfig());
  const tables = await db.all("SHOW TABLES LIKE '%1on1%'");
  console.log("1on1 Tables in Database:", tables);
})();

