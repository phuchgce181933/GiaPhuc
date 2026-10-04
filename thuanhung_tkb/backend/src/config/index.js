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

/**
 * PHASE 30 — AI provider configuration.
 *
 * Read here and ONLY here; feature code receives the resulting
 * object and never touches `process.env`.
 *
 * `AI_PROVIDER` selects the implementation. `mock` is the default
 * so that `npm test` and CI never need a GPU, a Python runtime, or
 * a model (brief §27, §45). `airllm` is opt-in.
 *
 * Nothing secret is read, stored, or logged here. `AIRLLM_SERVICE_TOKEN`
 * is an optional internal shared secret between the two local
 * services; it is never echoed back by /health and never written to
 * a log line (brief §36, §43).
 */
export function aiConfig() {
  const provider = (process.env.AI_PROVIDER ?? 'mock').trim().toLowerCase();
  return {
    provider,
    // Local Python AirLLM service. Loopback by default: this must
    // never be a public address (brief §43).
    serviceUrl: (process.env.AIRLLM_SERVICE_URL ?? 'http://127.0.0.1:8077').trim(),
    serviceToken: process.env.AIRLLM_SERVICE_TOKEN ?? null,
    requestTimeoutMs: positiveInt(process.env.AI_REQUEST_TIMEOUT_MS, 30_000),
    // Model selection. A local path is preferred so nothing is
    // fetched at runtime (brief §6); an id is allowed but must be
    // set explicitly by the operator.
    modelPath: process.env.AIRLLM_MODEL_PATH ?? null,
    modelId: process.env.AIRLLM_MODEL_ID ?? null,
    cacheDir: process.env.AIRLLM_CACHE_DIR ?? null,
    device: process.env.AIRLLM_DEVICE ?? null,
    dtype: process.env.AIRLLM_DTYPE ?? null,
    // Remote model code is OFF unless an operator turns it on by
    // hand. See ai/providers/airllm-planner.js for why this cannot
    // be left to AirLLM's own default (brief §8).
    allowRemoteCode: process.env.AIRLLM_ALLOW_REMOTE_CODE === 'true',
    // Integration tests (brief §28, §30) are opt-in. When this is
    // false the AirLLM tests skip instead of failing.
    integrationEnabled: process.env.AIRLLM_INTEGRATION === '1',
  };
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 4010),
  fixtureDir: resolve(root, process.env.FIXTURE_DIR ?? '../../data/fixtures'),
  mongoUri: process.env.MONGODB_URI ?? null,
  datasetPath: process.env.DATASET_PATH ?? null,
  ai: aiConfig(),
  /**
   * PHASE 33 — where committed schedules are written.
   *
   * Read here and ONLY here, like every other env access in this
   * project. `MONGODB_URI` above is still the one env var with no
   * code behind it: nothing opens a Mongo client, and Phase 33
   * deliberately did not add one (see
   * `src/persistence/schedule-store.js` for why, and
   * `docs/PHASE_33_SCHEDULE_COMMIT_PERSISTENCE.md` for the migration
   * path). It is left in place so the future switch is a config
   * change rather than a redesign.
   */
  persistenceDir: resolve(root, process.env.PERSISTENCE_DIR ?? 'data/schedules'),
};

export const ROOT = root;
