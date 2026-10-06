import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';

const WRITES = new Map();
const empty = () => ({ schemaVersion: 1, revision: 0, teachers: {}, subjects: {}, classes: {} });

// Operator changes are separate from the immutable import. Missing files mean
// no changes; corrupt or inaccessible files must not silently revert the roster.
export class CatalogStore {
  constructor(file) { this.file = resolve(file); }
  read() {
    let raw;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    const value = JSON.parse(raw);
    if (value.schemaVersion !== 1 || !Number.isInteger(value.revision)
      || ['teachers','subjects','classes'].some((key) => !value[key] || Array.isArray(value[key]) || typeof value[key] !== 'object')) {
      throw new Error('Invalid catalog data.');
    }
    return value;
  }
  update(change) {
    const previous = WRITES.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const state = this.read();
      const result = change(state);
      state.revision += 1;
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, this.file);
      } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      return result;
    });
    WRITES.set(this.file, operation);
    operation.finally(() => { if (WRITES.get(this.file) === operation) WRITES.delete(this.file); }).catch(() => {});
    return operation;
  }
}

export function defaultCatalogStore() { return new CatalogStore(resolve(config.catalogDir, 'catalog.json')); }
