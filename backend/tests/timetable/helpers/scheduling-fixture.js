import { loadFromLegacySaplich } from '../../../src/modules/timetable/engine/loader/legacy-saplich/index.js';
import { loadBenchmarkDataset } from '../../../src/modules/timetable/engine/loader/catalog-dataset.js';

// An explicit permission scenario for positive solver/commit tests. It keeps
// every real teacher, class, subject and demand, but grants test-only branch
// permissions. Production NEVER infers permissions from historical assignments.
// Tests of the unconfigured legacy dataset must use the original loaders.
export function withExplicitTestTransferPolicy(input) {
  const branches = input.branches.map((branch) => branch.id);
  const teachers = input.teachers.map((teacher) => ({ ...teacher, allowedTransferBranches: branches.filter((branchId) => branchId !== teacher.homeBranchId) }));
  return { ...input, teachers, teacherIndex: new Map(teachers.map((teacher) => [teacher.id, teacher])) };
}

export function loadLegacySchedulingFixture(options) {
  const loaded = loadFromLegacySaplich(options);
  return { ...loaded, scheduling: withExplicitTestTransferPolicy(loaded.scheduling) };
}

export function loadSchedulingFixture(options = {}) {
  // Positive test scenarios must not inherit an operator's live preference file.
  const loaded = loadBenchmarkDataset({ transferPolicy:'EXPLICIT', ...options,
    catalogStore:options.catalogStore ?? {read:() => ({schemaVersion:1,revision:0,teachers:{},subjects:{},classes:{}})},
    preferenceStore: options.preferenceStore ?? { readAll: () => ({}) } });
  let input = withExplicitTestTransferPolicy(loaded.input);
  if (options?.impossible) {
    input = { ...input, branches: input.branches.map((branch) => ({ ...branch, schoolDays: [2], periods: [2] })),
      timeSlotsByBranch: new Map(input.branches.map((branch) => [branch.id, [{ branchId: branch.id, day: 2, period: 2, session: 'sang' }]])) };
  }
  return { ...loaded, input, provenance: { ...loaded.provenance, testPolicy: 'EXPLICIT_TEST_TRANSFER_PERMISSION' } };
}
