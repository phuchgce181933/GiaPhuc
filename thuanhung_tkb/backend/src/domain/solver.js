// Backtracking CSP solver with a soft penalty over previous solutions
// to encourage diversity. Pure: no IO, no globals.

import { mulberry32, shuffle } from '../utils/prng.js';
import { HARD } from './constraints.js';

export function solve(input) {
  const start = Date.now();
  const { strategy, timeLimitMs = 5000, maxSolutions = 5 } = input.strategy.solver ?? {};
  const timeBudget = Math.max(50, Number(timeLimitMs ?? 5000));
  const cap = Math.max(1, Number(maxSolutions ?? 5));

  if (input.assignments.length === 0) {
    return {
      solutions: [],
      diagnostics: {
        strategiesAttempted: 1,
        totalSolveMs: Date.now() - start,
        warnings: ['INFEASIBLE_DEMAND: no assignments to schedule'],
        unresolvable: [],
      },
      failure: 'INFEASIBLE_DEMAND',
    };
  }

  const candidates = new Map();
  for (const a of input.assignments) {
    const pool = (input.timeSlotsByBranch.get(a.branchId) ?? []).slice();
    candidates.set(a.id, pool);
  }

  for (const [aId, pool] of candidates) {
    if (pool.length === 0) {
      return {
        solutions: [],
        diagnostics: {
          strategiesAttempted: 1,
          totalSolveMs: Date.now() - start,
          warnings: [`UNRESOLVABLE_ASSIGNMENT: ${aId} has no candidate slots`],
          unresolvable: [{ assignmentId: aId, reason: 'no_candidate_slots' }],
        },
        failure: 'UNRESOLVABLE_ASSIGNMENT',
      };
    }
  }

  const order = input.assignments
    .map((a) => ({ a, pool: candidates.get(a.id).length }))
    .sort((x, y) => (y.a.requiredPeriods - x.a.requiredPeriods) || (x.pool - y.pool))
    .map((x) => x.a);

  const seed = input.strategy.diversification?.seed ?? 0xC0FFEE;
  const rng = mulberry32(seed);

  if (input.strategy.diversification?.mode === 'random_seed') {
    for (const [aId, pool] of candidates) candidates.set(aId, shuffle(pool, rng));
  }

  const found = [];
  const seen = new Set();
  const slotPenalty = new Map();
  const warnings = [];
  const unresolvable = [];

  const teacherSchedules = new Map();
  const classSchedules = new Map();

  for (const t of input.teachers) teacherSchedules.set(t.id, new Set());
  for (const c of input.classes) classSchedules.set(c.id, new Set());

  function slotKey(s) { return `${s.branchId}:${s.day}:${s.period}`; }
  function hasTeacherSlot(tid, s) { return teacherSchedules.get(tid)?.has(slotKey(s)); }
  function hasClassSlot(cid, s) { return classSchedules.get(cid)?.has(slotKey(s)); }
  function addTeacherSlot(tid, s) { teacherSchedules.get(tid)?.add(slotKey(s)); }
  function delTeacherSlot(tid, s) { teacherSchedules.get(tid)?.delete(slotKey(s)); }
  function addClassSlot(cid, s) { classSchedules.get(cid)?.add(slotKey(s)); }
  function delClassSlot(cid, s) { classSchedules.get(cid)?.delete(slotKey(s)); }
  function isFeasible(a, s) {
    if (hasTeacherSlot(a.teacherId, s)) return false;
    if (hasClassSlot(a.classId, s)) return false;
    return true;
  }
  function signature(partial) {
    const parts = [];
    for (const a of order) {
      const slots = (partial.get(a.id) ?? []).map(slotKey).sort();
      parts.push(`${a.id}=${slots.join('|')}`);
    }
    return parts.join(';');
  }

  // One-solution search. Used iteratively with the slot penalty
  // updated between searches so each call finds a different
  // solution.
  function searchOne(localRng) {
    teacherSchedules.forEach((s) => s.clear());
    classSchedules.forEach((s) => s.clear());

    function tryPlace(idx, partial) {
      if (Date.now() - start > timeBudget) return null;
      if (idx === order.length) return partial;
      const a = order[idx];
      const slots = partial.get(a.id) ?? [];
      if (slots.length === a.requiredPeriods) return tryPlace(idx + 1, partial);
      const pool = candidates.get(a.id);
      const used = new Set(slots.map(slotKey));
      const remaining = pool.filter((s) => !used.has(slotKey(s)));
      const sorted = remaining
        .map((s) => ({ s, p: slotPenalty.get(slotKey(s)) ?? 0, r: localRng() }))
        .sort((x, y) => (x.p - y.p) || (x.r - y.r))
        .map((x) => x.s);
      for (const s of sorted) {
        if (!isFeasible(a, s)) continue;
        addTeacherSlot(a.teacherId, s);
        addClassSlot(a.classId, s);
        slots.push(s);
        const result = tryPlace(idx, partial);
        if (result) return result;
        slots.pop();
        delTeacherSlot(a.teacherId, s);
        delClassSlot(a.classId, s);
      }
      return null;
    }

    const initial = new Map();
    for (const a of order) initial.set(a.id, []);
    return tryPlace(0, initial);
  }

  // Run independent searches, accumulating penalty between them.
  // This is the 'solution_penalty' diversification: each search
  // starts fresh but is biased away from the slots of all previous
  // solutions.
  let currentSeed = seed;
  while (found.length < cap && Date.now() - start < timeBudget) {
    const localRng = mulberry32(currentSeed);
    const partial = searchOne(localRng);
    if (!partial) break;
    const sig = signature(partial);
    if (seen.has(sig)) {
      // Penalize this signature's slots harder to break the cycle.
      for (const slots of partial.values()) {
        for (const s of slots) {
          const k = slotKey(s);
          slotPenalty.set(k, (slotPenalty.get(k) ?? 0) + 50);
        }
      }
      currentSeed = (currentSeed * 1103515245 + 12345) >>> 0;
      continue;
    }
    seen.add(sig);
    const cand = makeCandidate(partial, { ...input, strategy: { ...input.strategy, diversification: { ...input.strategy.diversification, seed: currentSeed } } });
    found.push(cand);
    // Penalize used slots and reseed for the next search.
    for (const slots of cand.assignments.values()) {
      for (const s of slots) {
        const k = slotKey(s);
        slotPenalty.set(k, (slotPenalty.get(k) ?? 0) + 10);
      }
    }
    currentSeed = (currentSeed * 1103515245 + 12345) >>> 0;
  }

  if (found.length === 0) {
    warnings.push('NO_SOLUTION: backtracking exhausted with no feasible solution');
  }

  for (const c of found) {
    c.diagnostics.hardViolationCount = 0;
    if (HARD.H_TRAVEL_FEASIBLE.active(input)) {
      c.diagnostics.hardViolationCount += HARD.H_TRAVEL_FEASIBLE.check(c, input).length;
    }
    if (HARD.H_TRANSFER_ALLOWED.active(input)) {
      c.diagnostics.hardViolationCount += HARD.H_TRANSFER_ALLOWED.check(c, input).length;
    }
  }

  return {
    solutions: found,
    diagnostics: {
      strategiesAttempted: 1,
      totalSolveMs: Date.now() - start,
      warnings,
      unresolvable,
    },
    failure: found.length === 0 ? 'NO_SOLUTION' : null,
  };
}

function makeCandidate(assignments, input) {
  const transfers = [];
  for (const a of input.assignments) {
    const slots = assignments.get(a.id) ?? [];
    const teacher = input.teacherIndex.get(a.teacherId);
    if (!teacher?.homeBranchId) continue;
    for (const s of slots) {
      if (s.branchId !== teacher.homeBranchId) {
        transfers.push({
          teacherId: teacher.id,
          fromBranchId: teacher.homeBranchId,
          toBranchId: s.branchId,
          day: s.day,
          period: s.period,
        });
      }
    }
  }
  return {
    id: `sol-${Math.random().toString(36).slice(2, 10)}`,
    strategyId: input.strategy.id,
    assignments: new Map([...assignments.entries()].map(([k, v]) => [k, v.slice()])),
    transfers,
    diagnostics: {
      hardViolationCount: 0,
      preferenceHits: 0,
      preferenceMisses: 0,
      objectiveValues: {},
    },
  };
}
