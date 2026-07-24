'use strict';

const mysql = require('mysql2/promise');
const { rewritePortalTables } = require('./table-names');

function required(name, env = process.env) {
  const value = String(env[name] || '').trim();
  if (!value) {
    const error = new Error(`Missing required database environment variable: ${name}`);
    error.code = 'MISSING_DATABASE_CONFIG';
    throw error;
  }
  return value;
}

function positiveInteger(value, fallback, name) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    const error = new Error(`${name} must be a positive integer.`);
    error.code = 'INVALID_DATABASE_CONFIG';
    throw error;
  }
  return parsed;
}

function databaseConfig(env = process.env) {
  const sslEnabled = String(env.DB_SSL || '').toLowerCase() === 'true';
  return {
    host: required('DB_HOST', env),
    port: positiveInteger(env.DB_PORT, 3306, 'DB_PORT'),
    user: required('DB_USER', env),
    password: required('DB_PASSWORD', env),
    database: required('DB_NAME', env),
    waitForConnections: true,
    connectionLimit: Math.max(2, positiveInteger(env.DB_POOL_SIZE, 10, 'DB_POOL_SIZE')),
    queueLimit: 0,
    connectTimeout: positiveInteger(env.DB_CONNECT_TIMEOUT_MS, 10000, 'DB_CONNECT_TIMEOUT_MS'),
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
    multipleStatements: false,
    ...(sslEnabled
      ? {
          ssl: {
            rejectUnauthorized:
              String(env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false'
          }
        }
      : {})
  };
}

class MySQLDatabase {
  constructor(config = databaseConfig(), pool = null) {
    this.config = config;
    this.pool = pool || mysql.createPool(config);
    this.closed = false;
    this.ready = this.get('SELECT 1 AS ok');
  }

  sql(sql) {
    return rewritePortalTables(sql);
  }

  async run(sql, params = []) {
    const [result] = await this.pool.execute(this.sql(sql), params);
    return {
      changes: Number(result.affectedRows || 0),
      lastInsertRowid: Number(result.insertId || 0),
      affectedRows: Number(result.affectedRows || 0),
      insertId: Number(result.insertId || 0)
    };
  }

  async get(sql, params = []) {
    const [rows] = await this.pool.execute(this.sql(sql), params);
    return rows[0] || undefined;
  }

  async all(sql, params = []) {
    const [rows] = await this.pool.execute(this.sql(sql), params);
    return rows;
  }

  async exec(sql) {
    const statements = String(sql)
      .split(/;\s*(?:\r?\n|$)/)
      .map(statement => statement.trim())
      .filter(Boolean);

    const connection = await this.pool.getConnection();
    try {
      for (const statement of statements) {
        await connection.query(this.sql(statement));
      }
    } finally {
      connection.release();
    }
  }

  async transaction(operations) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const results = [];

      for (const operation of operations) {
        const sql = this.sql(operation.sql);
        const params = operation.params || [];

        if (operation.action === 'get') {
          const [rows] = await connection.execute(sql, params);
          results.push(rows[0] || undefined);
        } else if (operation.action === 'all') {
          const [rows] = await connection.execute(sql, params);
          results.push(rows);
        } else {
          const [result] = await connection.execute(sql, params);
          results.push({
            changes: Number(result.affectedRows || 0),
            lastInsertRowid: Number(result.insertId || 0),
            affectedRows: Number(result.affectedRows || 0),
            insertId: Number(result.insertId || 0)
          });
        }
      }

      await connection.commit();
      return results;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {}
      throw error;
    } finally {
      connection.release();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

module.exports = { MySQLDatabase, databaseConfig, required, positiveInteger };
