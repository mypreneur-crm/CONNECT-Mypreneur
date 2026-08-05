'use strict';

function validatePrefix(value) {
  const prefix = String(value || 'connect_').trim();
  if (!/^[A-Za-z0-9_]{1,32}$/.test(prefix)) {
    throw new Error('DB_TABLE_PREFIX may contain only letters, numbers, and underscores.');
  }
  return prefix;
}

const TABLE_PREFIX = validatePrefix(process.env.DB_TABLE_PREFIX || 'connect_');
const BASE_TABLES = Object.freeze(['links', 'events', 'announcements', 'annonymous_message']);
const TABLES = Object.freeze(Object.fromEntries(BASE_TABLES.map(name => [name, `${TABLE_PREFIX}${name}`])));

function rewritePortalTables(sql) {
  let output = String(sql);
  for (const name of BASE_TABLES) {
    output = output.replace(new RegExp(`\\b${name}\\b`, 'g'), TABLES[name]);
  }
  return output;
}

module.exports = { TABLE_PREFIX, TABLES, rewritePortalTables, validatePrefix };
