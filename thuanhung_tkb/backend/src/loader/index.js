// Loader entry point. Picks the appropriate loader based on config.
//
// Priority:
//   1. MONGODB_URI set  → use the MongoDB loader (interface only in
//                         this phase; the user is told to use the
//                         dataset loader instead).
//   2. DATASET_PATH set → use the JSON dataset loader, which reads
//                         a single file containing the full
//                         SchedulingInput. The path must point to
//                         a file the operator provides. The loader
//                         does not invent data.
//   3. fallback         → use the authoritative teacher fixture
//                         (existing behavior, unchanged).

import { config } from '../config/index.js';
import { loadFromFixture } from './fixture.js';
import { loadFromDataset } from './dataset.js';

export function load() {
  if (config.mongoUri) {
    return {
      ...emptyModel(),
      warnings: ['MongoDB loader is not implemented in this phase. Use DATASET_PATH or the fixture.'],
    };
  }
  if (config.datasetPath) {
    return loadFromDataset({ path: config.datasetPath });
  }
  return loadFromFixture(config);
}

export function emptyModel() {
  return {
    teachers: [],
    branches: [],
    classes: [],
    subjects: [],
    curriculum: [],
    assignments: [],
    timeSlotsByBranch: [],
    travelTime: null,
    transitionMinutes: 10,
    teacherIndex: new Map(),
    assignmentIndex: new Map(),
    missingData: [],
    warnings: [],
    branchesStatus: 'MISSING',
    curriculumStatus: 'MISSING',
    travelStatus: 'MISSING_CONFIGURATION',
  };
}
