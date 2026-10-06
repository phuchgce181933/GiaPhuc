// Dataset loader. Reads a JSON file that contains the full
// SchedulingInput. The file is supplied by the operator; this
// loader does not invent any data. Each section is optional; a
// missing section is reported in `missingData`, not silently
// filled.
//
// Expected file shape (top-level keys are all optional):
//
//   {
//     "teachers":   Teacher[]               // see SCHEDULING_DATA_CONTRACT.md §2
//     "branches":   Branch[]
//     "classes":    Class[]
//     "subjects":   Subject[]
//     "curriculum": Curriculum[]
//     "assignments": Assignment[]            // missing assignments fail demand coverage
//     "travel":     { "matrix": { bA: { bB: minutes } } } | null
//     "transitionMinutes": number            // default 10
//   }
//
// The loader is a pure function from file bytes to the
// normalized in-memory model. It is independent of the
// orchestrator and the solver.

import { readFileSync } from 'node:fs';
import { normalizeTeacher, teacherMissingFields } from '../domain/teacher.js';
import { makeTravelProvider } from '../domain/travel/index.js';
import { slotsForBranch } from '../domain/constraints.js';

/**
 * @param {{ path: string }} cfg
 * @returns {{
 *   teachers: any[],
 *   branches: any[],
 *   classes: any[],
 *   subjects: any[],
 *   curriculum: any[],
 *   assignments: any[],
 *   timeSlotsByBranch: Map<string, any[]>,
 *   travelTime: any | null,
 *   transitionMinutes: number,
 *   teacherIndex: Map<string, any>,
 *   assignmentIndex: Map<string, any>,
 *   missingData: object[],
 *   warnings: string[],
 *   branchesStatus: 'MISSING' | 'OK',
 *   curriculumStatus: 'MISSING' | 'OK',
 *   travelStatus: 'MISSING_CONFIGURATION' | 'OK',
 * }}
 */
export function loadFromDataset(cfg) {
  if (!cfg?.path) {
    throw new TypeError('loadFromDataset: cfg.path is required');
  }
  const raw = JSON.parse(readFileSync(cfg.path, 'utf8'));
  const warnings = [];
  const missingData = [];

  // --- Teachers --------------------------------------------------------
  const teachers = [];
  const rawTeachers = Array.isArray(raw.teachers) ? raw.teachers : null;
  if (!rawTeachers) {
    missingData.push({ entity: 'Teacher', reason: 'No teacher records in dataset' });
  } else {
    for (const t of rawTeachers) {
      try {
        const norm = normalizeTeacher(t);
        teachers.push(norm);
        missingData.push(...teacherMissingFields(norm));
      } catch (e) {
        warnings.push(`Skipped teacher: ${e.message}`);
      }
    }
  }
  const teacherIndex = new Map(teachers.map((t) => [t.id, t]));

  // --- Branches --------------------------------------------------------
  const branches = Array.isArray(raw.branches) ? raw.branches : [];
  let branchesStatus = 'MISSING';
  if (branches.length > 0) {
    // Per-branch normalization: id, name, schoolDays, periods. We do
    // not invent any field that is absent — the validator will
    // catch that and surface it as INVALID_INPUT.
    for (const b of branches) {
      if (!b.schoolDays) b.schoolDays = [];
      if (!b.periods) b.periods = [];
    }
    branchesStatus = 'OK';
  } else {
    missingData.push({ entity: 'Branch', reason: 'No authoritative branch data' });
  }
  const timeSlotsByBranch = new Map();
  for (const b of branches) {
    timeSlotsByBranch.set(b.id, slotsForBranch(b));
  }

  // --- Classes ---------------------------------------------------------
  const classes = Array.isArray(raw.classes) ? raw.classes : [];
  if (classes.length === 0) {
    missingData.push({ entity: 'Class', reason: 'No authoritative class data' });
  }

  // --- Subjects --------------------------------------------------------
  // Subjects are derived from teacher specializations; any extra
  // entries in the file are merged in (not invented). The dataset
  // is the source of truth for the subject catalog.
  const subjectNames = new Set();
  for (const t of teachers) for (const s of t.chuyenMon) subjectNames.add(s.tenChuyenMon);
  if (Array.isArray(raw.subjects)) {
    for (const s of raw.subjects) {
      if (s?.name) subjectNames.add(s.name);
    }
  }
  const subjects = [...subjectNames].map((name) => ({ id: name, name }));

  // --- Curriculum ------------------------------------------------------
  const curriculum = Array.isArray(raw.curriculum) ? raw.curriculum : [];
  let curriculumStatus = 'MISSING';
  if (curriculum.length === 0) {
    missingData.push({ entity: 'Curriculum', reason: 'No authoritative curriculum data' });
  } else {
    curriculumStatus = 'OK';
  }

  // --- Assignments -----------------------------------------------------
  // Preserve supplied assignments. Missing coverage is reported by validateInput;
  // the loader never invents a teacher decision or assignment id.
  const assignments = Array.isArray(raw.assignments) ? raw.assignments : [];
  if (assignments.length === 0) {
    missingData.push({ entity: 'Assignment', reason: 'No authoritative assignment data' });
  }
  const assignmentIndex = new Map(assignments.map((a) => [a.id, a]));

  // --- Travel ----------------------------------------------------------
  let travelTime = null;
  let travelStatus = 'MISSING_CONFIGURATION';
  if (raw.travel && typeof raw.travel === 'object' && raw.travel.matrix) {
    travelTime = makeTravelProvider(raw.travel.matrix);
    travelStatus = 'OK';
  } else {
    missingData.push({ entity: 'Travel', reason: 'No travel matrix' });
  }

  const transitionMinutes = Number.isFinite(raw.transitionMinutes) ? raw.transitionMinutes : 10;

  return {
    teachers,
    branches,
    classes,
    subjects,
    curriculum,
    assignments,
    timeSlotsByBranch,
    travelTime,
    transitionMinutes,
    teacherIndex,
    assignmentIndex,
    missingData,
    warnings,
    branchesStatus,
    curriculumStatus,
    travelStatus,
  };
}
