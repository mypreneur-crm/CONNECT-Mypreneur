'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class LocalFileStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.allowedKinds = new Set(['links', 'announcements', 'eoq']);
  }

  async init() {
    await Promise.all([
      fs.promises.mkdir(path.join(this.rootDir, 'links'), { recursive: true }),
      fs.promises.mkdir(path.join(this.rootDir, 'announcements'), { recursive: true }),
      fs.promises.mkdir(path.join(this.rootDir, 'eoq'), { recursive: true }),
      fs.promises.mkdir(path.join(this.rootDir, '.tmp'), { recursive: true })
    ]);
  }

  resolve(storageKey) {
    const key = String(storageKey || '').replace(/\\/g, '/');
    if (!key || key.startsWith('/') || key.includes('..')) throw new Error('Invalid file storage key.');
    const fullPath = path.resolve(this.rootDir, key);
    if (fullPath !== this.rootDir && !fullPath.startsWith(this.rootDir + path.sep)) {
      throw new Error('Invalid file storage path.');
    }
    return fullPath;
  }

  async save(kind, originalName, buffer) {
    if (!this.allowedKinds.has(kind)) throw new Error('Invalid storage category.');
    const extension = path.extname(String(originalName || '')).toLowerCase();
    const storageKey = `${kind}/${crypto.randomUUID()}${extension}`;
    const finalPath = this.resolve(storageKey);
    const tempPath = path.join(this.rootDir, '.tmp', `${crypto.randomUUID()}.upload`);
    await fs.promises.writeFile(tempPath, buffer, { flag: 'wx', mode: 0o600 });
    try {
      await fs.promises.rename(tempPath, finalPath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    return { storageKey, size: buffer.length };
  }

  async remove(storageKey) {
    if (!storageKey) return;
    await fs.promises.rm(this.resolve(storageKey), { force: true });
  }

  async stat(storageKey) {
    return fs.promises.stat(this.resolve(storageKey));
  }

  createReadStream(storageKey) {
    return fs.createReadStream(this.resolve(storageKey));
  }
}

module.exports = { LocalFileStore };
