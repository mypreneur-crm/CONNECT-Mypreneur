'use strict';

/**
 * MYPRENEUR CONNECT — AUTOMATED ENCRYPTED DATABASE BACKUP UTILITY
 * 
 * Usage:
 *   Backup:  node --env-file=.env scripts/backup-database.js
 *   Restore: node --env-file=.env scripts/backup-database.js --restore ./backups/backup-2026-10-27T12-00-00.enc
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const RETENTION_DAYS = 30;

function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_SECRET || process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('ENCRYPTION_SECRET or SESSION_SECRET must be at least 32 characters to run encrypted backups.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptPayload(data) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(data, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    version: 1,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('base64'),
    timestamp: new Date().toISOString()
  });
}

function decryptPayload(payloadStr) {
  const parsed = JSON.parse(payloadStr);
  const key = getEncryptionKey();
  const iv = Buffer.from(parsed.iv, 'hex');
  const tag = Buffer.from(parsed.tag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

async function runBackup() {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  console.log('[Backup] Connecting to database...');
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  try {
    const tableRows = await db.all("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
    const tables = tableRows.map(r => Object.values(r)[0]);
    console.log(`[Backup] Found ${tables.length} tables to back up.`);

    const backupDump = {};
    for (const table of tables) {
      const rows = await db.all(`SELECT * FROM \`${table}\``);
      backupDump[table] = rows;
    }

    const jsonString = JSON.stringify(backupDump, null, 2);
    const encryptedData = encryptPayload(jsonString);

    const filename = `connect-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.enc`;
    const targetFile = path.join(BACKUP_DIR, filename);

    await fs.promises.writeFile(targetFile, encryptedData, { encoding: 'utf8', mode: 0o600 });
    console.log(`[Backup] Successfully created encrypted backup: ${targetFile}`);

    // Clean up older backups beyond retention policy
    const files = await fs.promises.readdir(BACKUP_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.enc')) continue;
      const filePath = path.join(BACKUP_DIR, file);
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > RETENTION_DAYS * 24 * 60 * 60 * 1000) {
        await fs.promises.unlink(filePath);
        console.log(`[Backup] Pruned expired backup: ${file}`);
      }
    }
  } finally {
    await db.close();
  }
}

async function runRestore(targetEncFile) {
  console.log(`[Restore] Reading encrypted backup from ${targetEncFile}...`);
  const raw = await fs.promises.readFile(targetEncFile, 'utf8');
  const decryptedJson = decryptPayload(raw);
  const tables = JSON.parse(decryptedJson);

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  try {
    console.log(`[Restore] Tables found in backup: ${Object.keys(tables).join(', ')}`);
    for (const [table, rows] of Object.entries(tables)) {
      if (!rows || rows.length === 0) continue;
      console.log(`[Restore] Table '${table}': ${rows.length} rows to restore.`);
    }
    console.log('[Restore] Backup integrity verified. To execute full insert restore, review data mapping.');
  } finally {
    await db.close();
  }
}

const args = process.argv.slice(2);
if (args[0] === '--restore' && args[1]) {
  runRestore(args[1]).catch(err => {
    console.error('[Restore Error]:', err.message);
    process.exit(1);
  });
} else {
  runBackup().catch(err => {
    console.error('[Backup Error]:', err.message);
    process.exit(1);
  });
}
