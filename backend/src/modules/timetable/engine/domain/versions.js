import { DIMENSION_CATALOG } from './dimension-catalog.js';
import { GLOBAL_SCORING_DEFAULTS } from './global-scoring.js';
export const DATASET_SOURCE = 'legacy-saplich/real';

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}
export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i=0;i<text.length;i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash,0x01000193) >>> 0; }
  return hash.toString(16).padStart(8,'0');
}
export const hashValue = (value) => fnv1a32(canonicalStringify(value));
export const dimensionCatalogVersion = (input) => hashValue(DIMENSION_CATALOG.map((d) => ({ id:d.id,direction:d.direction,defaultWeight:d.defaultWeight,active:Boolean(d.active(input)) })));
export function scoringDefaultsVersion() {
  const d=GLOBAL_SCORING_DEFAULTS;
  return hashValue({weights:d.weights,qualityFloor:d.qualityFloor,qualityWeightInSelection:d.qualityWeightInSelection,
    diversityWeightInSelection:d.diversityWeightInSelection,requireFeasibility:d.requireFeasibility,minSlotDiversity:d.minSlotDiversity});
}
