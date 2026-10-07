import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const WRITES = new Map();
export function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('Invalid teacher preference data. Existing data was not overwritten.');
  }
  for (const row of Object.values(value)) {
    if (row.preferredSession != null && !['morning','afternoon','both','sang','chieu','ca_hai'].includes(row.preferredSession)) throw new Error('Invalid saved teaching session.');
    if (row.desiredTeachingSessionsPerWeek != null && (!Number.isInteger(row.desiredTeachingSessionsPerWeek) || row.desiredTeachingSessionsPerWeek < 0 || row.desiredTeachingSessionsPerWeek > 15)) throw new Error('Invalid saved desired sessions.');
    if (row.preferredOffDay != null && !['NONE','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'].includes(row.preferredOffDay)) throw new Error('Invalid saved off day.');
    if (row.preferredOffPart != null && !['NONE','MORNING','AFTERNOON','FULL_DAY'].includes(row.preferredOffPart)) throw new Error('Invalid saved off-day part.');
    if (row.preferredTransferBranchIds != null && (!Array.isArray(row.preferredTransferBranchIds) || row.preferredTransferBranchIds.some((id) => typeof id !== 'string'))) throw new Error('Invalid saved transfer preferences.');
  }
  return value;
}

// Operator-owned overlays deliberately live apart from the read-only legacy dump.
export class TeacherPreferenceStore {
  constructor(file) { this.file = file; }
  readAll() {
    let raw;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    return validatePreferences(JSON.parse(raw));
  }
  get(teacherId) { return this.readAll()[teacherId] ?? null; }
  put(teacherId, preference) { return this.update(teacherId, () => preference); }
  update(teacherId, change) {
    const key = resolve(this.file);
    const operation = (WRITES.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const all = this.readAll();
      all[teacherId] = change(all[teacherId] ?? null);
      validatePreferences(all);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(all, null, 2), { encoding: 'utf8', flag: 'wx' });
        await rename(tmp, this.file);
      } finally { await unlink(tmp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      return all[teacherId];
    });
    WRITES.set(key, operation);
    operation.finally(() => { if (WRITES.get(key) === operation) WRITES.delete(key); }).catch(() => {});
    return operation;
  }
}

export function defaultTeacherPreferenceStore(persistenceDir) {
  return new TeacherPreferenceStore(resolve(persistenceDir, 'teacher-preferences.json'));
}
