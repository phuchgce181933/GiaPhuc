import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Operator-owned overlays deliberately live apart from the read-only legacy dump.
export class TeacherPreferenceStore {
  constructor(file) { this.file = file; }
  readAll() {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  get(teacherId) { return this.readAll()[teacherId] ?? null; }
  async put(teacherId, preference) {
    const all = this.readAll();
    all[teacherId] = preference;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
    await rename(tmp, this.file);
    return all[teacherId];
  }
}

export function defaultTeacherPreferenceStore(persistenceDir) {
  return new TeacherPreferenceStore(resolve(persistenceDir, 'teacher-preferences.json'));
}
