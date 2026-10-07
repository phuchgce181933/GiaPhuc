// Entry point for the legacy-saplich loader.
//
// Wires the five layers and exposes `loadFromLegacySaplich()`. The
// `legacySaplich` loader does not touch the existing
// `loader/index.js` registry unless explicitly opted-in (Phase 19
// does not modify the registry; the legacy loader is invoked
// directly by tests and by a future preview endpoint).

import { readRawDump, inventory as rawInventory } from './raw-reader.js';
import { normalizeAll } from './normalize.js';
import { checkIntegrity } from './integrity.js';
import { buildSchedulingModel } from './scheduling-model.js';
import { buildLegacyBaseline } from './legacy-baseline.js';
import { config } from '../../config/index.js';

const DEFAULT_SOURCE_DIR = config.legacySourceDir;

/**
 * @typedef {Object} LegacySaplichImportResult
 * @property {string} sourceDir
 * @property {string} serverVersion
 * @property {string} toolVersion
 * @property {Object} raw        // RawDump
 * @property {Object} normalized // from normalize.js
 * @property {Object} integrity  // from integrity.js
 * @property {Object} scheduling // SchedulingInput contract
 * @property {Object} legacyBaseline
 * @property {Object} inventory  // collection → docCount
 */

/**
 * @param {{ sourceDir?: string }} [cfg]
 * @returns {LegacySaplichImportResult}
 */
export function loadFromLegacySaplich(cfg = {}) {
  const sourceDir = cfg.sourceDir ?? DEFAULT_SOURCE_DIR;
  const raw = readRawDump(sourceDir);
  const normalized = normalizeAll(raw);
  const integrity = checkIntegrity(normalized);
  const scheduling = buildSchedulingModel(normalized);
  const legacyBaseline = buildLegacyBaseline(normalized);
  const inventory = rawInventory(raw);
  return {
    sourceDir,
    serverVersion: raw.serverVersion,
    toolVersion: raw.toolVersion,
    raw,
    normalized,
    integrity,
    scheduling,
    legacyBaseline,
    inventory,
  };
}

export { readRawDump, normalizeAll, checkIntegrity, buildSchedulingModel, buildLegacyBaseline };
export { DEFAULT_SOURCE_DIR };
