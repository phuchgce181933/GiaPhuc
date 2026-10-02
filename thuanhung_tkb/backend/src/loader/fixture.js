// Fixture loader. Reads the authoritative teacher JSON and produces
// a normalized in-memory model. Does not invent missing data.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTeacher, teacherMissingFields } from '../domain/teacher.js';
import { slotsForBranch } from '../domain/constraints.js';

/**
 * @param {{ fixtureDir: string }} cfg
 * @returns {{
 *   teachers: any[],
 *   branches: any[],
 *   classes: any[],
 *   subjects: any[],
 *   curriculum: any[],
 *   assignments: any[],
 *   timeSlotsByBranch: { branchId: string, day: number, period: number }[][],
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
export function loadFromFixture(cfg) {
  const path = join(cfg.fixtureDir, 'teachers.authoritative.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const teachers = [];
  const missingData = [];
  const warnings = [];
  for (const t of raw) {
    try {
      const norm = normalizeTeacher(t);
      teachers.push(norm);
      missingData.push(...teacherMissingFields(norm));
    } catch (e) {
      warnings.push(`Skipped teacher: ${e.message}`);
    }
  }
  for (const t of teachers) {
    t.teacherIndex = undefined;
  }
  const teacherIndex = new Map(teachers.map((t) => [t.id, t]));

  // Branches: missing in fixture. Surface as MISSING.
  const branches = [];
  const branchesStatus = 'MISSING';
  const timeSlotsByBranch = new Map();
  warnings.push('MISSING DATA: Branch profile is empty (no branches in fixture).');

  // Classes: missing in fixture. No demand, no assignments.
  const classes = [];
  warnings.push('MISSING DATA: Class list is empty (no classes in fixture).');

  // Subjects: derived verbatim from teacher specializations. The
  // system does not invent subjects.
  const subjectNames = new Set();
  for (const t of teachers) for (const s of t.chuyenMon) subjectNames.add(s.tenChuyenMon);
  const subjects = [...subjectNames].map((name) => ({ id: name, name }));

  // Curriculum: missing in fixture.
  const curriculum = [];
  const curriculumStatus = 'MISSING';
  warnings.push('MISSING DATA: Curriculum is empty (no (class, subject, periods) in fixture).');

  // Assignments: derived from teachers × curriculum. Empty here.
  const assignments = [];
  const assignmentIndex = new Map();

  // Travel: not configured.
  const travelTime = null;
  const travelStatus = 'MISSING_CONFIGURATION';
  warnings.push('MISSING CONFIGURATION: TravelProvider is not registered.');

  return {
    teachers,
    branches,
    classes,
    subjects,
    curriculum,
    assignments,
    timeSlotsByBranch,
    travelTime,
    transitionMinutes: 10,
    teacherIndex,
    assignmentIndex,
    missingData,
    warnings,
    branchesStatus,
    curriculumStatus,
    travelStatus,
  };
}
