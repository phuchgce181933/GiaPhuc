import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function loadDotenv() {
  // Minimal .env loader. No external dep.
  try {
    const raw = readFileSync(resolve(root, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* .env is optional */ }
}
loadDotenv();

export const config = {
  port: Number(process.env.PORT ?? 4010),
  fixtureDir: resolve(root, process.env.FIXTURE_DIR ?? '../../data/fixtures'),
  mongoUri: process.env.MONGODB_URI ?? null,
  datasetPath: process.env.DATASET_PATH ?? null,
};

export const ROOT = root;
