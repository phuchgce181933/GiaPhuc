import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import env from '../../../../config/index.js';
const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '../../../../..');
export const ROOT = resolve(here, '..');
export const config = {
  mainDatabaseName: env.MONGODB_DB,
  databaseName: env.TIMETABLE.MONGODB_DB,
  fixtureDir: resolve(backendRoot, 'data/timetable/fixtures'),
  legacySourceDir: resolve(backendRoot, 'data/timetable/source/legacy-saplich'),
  // File adapters are for migration and isolated regression tests only.
  catalogDir: resolve(backendRoot, 'data/timetable/legacy-state/catalog'),
  persistenceDir: resolve(backendRoot, 'data/timetable/legacy-state/schedules'),
  transferPolicy: env.TIMETABLE.TRANSFER_POLICY,
  previewLimit: env.TIMETABLE.PREVIEW_LIMIT,
  previewTtlSeconds: env.TIMETABLE.PREVIEW_TTL_SECONDS,
};
