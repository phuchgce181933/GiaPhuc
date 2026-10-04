// PHASE 32 — API CONTRACT: request vocabulary + validation.
//
// This module is the ONLY place where an HTTP request body is
// turned into a generation request. It is deliberately free of
// Express, of the solver, and of every other domain module except
// `strategies.js`, which owns the shared vocabulary constants. That
// independence is what lets the contract be tested without booting a
// server, and it keeps the AI layer's import hygiene intact: nothing
// here reaches solver internals (Phase 29 §36).
//
// WHAT A CLIENT MAY ASK FOR
// -------------------------
//   candidateCount      one of 1 | 3 | 5 | 10   (required-ish; defaults to 3)
//   optimizationMode    one of the four OPTIMIZATION_MODES (optional)
//   useAI               boolean (optional, defaults to true)
//
// That is the entire vocabulary. A client cannot name a teacher, a
// class, a day, a session, a period, a weight, a constraint, a
// branch, or a seed, and it cannot ask for a strategy document.
//
// WHY THE FORBIDDEN KEYS ARE REJECTED RATHER THAN IGNORED
// --------------------------------------------------------
// A body that carries `{"candidateCount": 3, "teacherId": "..."}`
// has two plausible readings: the client asked us to pin a teacher,
// or the client is confused about the contract. Silently dropping
// the field would answer the first question with a schedule that
// ignores it, and the caller would have no way to know. So the
// contract reports the field back as a validation issue, and the
// solver never runs. This is the same reason Phase 14 separates
// `issues` (refuse) from `missing` (proceed), applied to the request
// side of the boundary.
//
// The forbidden set is derived from the SchedulingInput shape, not
// hand-listed from the brief, so a new domain field cannot leak in
// silently. It is asserted against the real input's keys in
// `tests/phase32_api_e2e.test.js` (check 22).

import { ALLOWED_CANDIDATE_COUNTS, OPTIMIZATION_MODES } from '../domain/strategies.js';

export const API_VERSION = 'phase32-v1';

/** Default candidate count when the client omits it. */
export const DEFAULT_CANDIDATE_COUNT = 3;

/**
 * The full list of keys a generate request may carry. Anything else
 * is a validation issue.
 */
export const ALLOWED_REQUEST_KEYS = Object.freeze([
  'candidateCount',
  'optimizationMode',
  'useAI',
]);

/**
 * Request keys that would let a client construct a schedule itself
 * rather than request one. Kept as an explicit list (rather than
 * "everything not in ALLOWED_REQUEST_KEYS") so the error message can
 * say *why* a field was refused instead of only that it is unknown.
 *
 * These are the field names of the legacy SchedulingInput plus the
 * solver/constraint control knobs. Refusing them is the mechanism
 * behind "the backend is authoritative" (brief §4): a client that
 * can set `weights` or `teacherId` can bypass the constraint catalog
 * and the AI validation boundary entirely.
 */
export const FORBIDDEN_REQUEST_KEYS = Object.freeze([
  // Entities the backend owns.
  'teacherId', 'teacherIds', 'teacher',
  'classId', 'classIds', 'class',
  'subjectId', 'subjects',
  'branchId', 'branchIds', 'branch',
  'assignmentId', 'assignments',
  'slots', 'placements', 'schedule', 'solution', 'solutions',
  // Time identity — the client does not author a timetable.
  'day', 'days', 'session', 'sessions', 'period', 'periods',
  // Solver + constraint control.
  'seed', 'strategy', 'strategies', 'weights', 'scoringWeights',
  'constraints', 'constraintOverrides', 'hardConstraints',
  'travelStatus', 'travelTime', 'transferStatus', 'transfer',
  'optimizationModeRaw', 'timeBudgetMs', 'maxSearchIterations',
  // Bypass attempts.
  'input', 'model', 'dataset', 'skipValidation', 'force',
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_REQUEST_KEYS);
const ALLOWED_SET = new Set(ALLOWED_REQUEST_KEYS);

const ALLOWED_MODES = Object.freeze(Object.values(OPTIMIZATION_MODES));

/**
 * @typedef {Object} ValidationIssue
 * @property {string} field    the offending key or path
 * @property {string} code     stable machine-readable code
 * @property {string} message  human-readable, safe to render
 */

/**
 * @typedef {Object} GenerateRequest
 * @property {number}  candidateCount
 * @property {string}  optimizationMode
 * @property {boolean} useAI
 */

/**
 * validateGenerateRequest(body) ->
 *   { ok: true,  request, issues: [] }
 *   { ok: false, issues: ValidationIssue[] }
 *
 * NEVER throws. A malformed body is a validation result, not an
 * exception, because a malformed body is a client error and the
 * client's request is exactly what a 400 is for.
 */
export function validateGenerateRequest(body) {
  const issues = [];

  // A missing body, null, a string, an array — all malformed. An
  // array is called out explicitly because `[]` passes a naive
  // `typeof === 'object'` check and would otherwise be read as an
  // empty request.
  if (body === undefined || body === null) {
    return { ok: true, request: defaultRequest(), issues: [] };
  }
  if (Array.isArray(body)) {
    issues.push(issue('body', 'INVALID_BODY', 'Request body must be a JSON object.'));
    return { ok: false, issues };
  }
  if (typeof body !== 'object') {
    issues.push(issue('body', 'INVALID_BODY', 'Request body must be a JSON object.'));
    return { ok: false, issues };
  }

  for (const key of Object.keys(body)) {
    if (FORBIDDEN_SET.has(key)) {
      issues.push(issue(
        key,
        'FORBIDDEN_FIELD',
        `"${key}" cannot be supplied by a client. The backend owns the data, the `
        + 'constraints, and the solver settings; a request may only carry '
        + `${ALLOWED_REQUEST_KEYS.join(', ')}.`,
      ));
      continue;
    }
    if (!ALLOWED_SET.has(key)) {
      issues.push(issue(
        key,
        'UNKNOWN_FIELD',
        `Unknown field "${key}". Allowed fields: ${ALLOWED_REQUEST_KEYS.join(', ')}.`,
      ));
    }
  }

  // ---- candidateCount ---------------------------------------------
  let candidateCount = DEFAULT_CANDIDATE_COUNT;
  if ('candidateCount' in body) {
    const raw = body.candidateCount;
    // `999` must be a 400, not a silent snap to 10 (brief §23). The
    // vocabulary is a closed set and a value outside it is refused
    // rather than rounded. A JSON body could also send it as the
    // string "3", which is refused too — silently coercing it would
    // let a client that does not agree with the contract still get a
    // schedule, and the disagreement would never surface.
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      issues.push(issue(
        'candidateCount',
        'INVALID_CANDIDATE_COUNT',
        `candidateCount must be an integer. Allowed values: ${ALLOWED_CANDIDATE_COUNTS.join(', ')}.`,
      ));
    } else if (!ALLOWED_CANDIDATE_COUNTS.includes(raw)) {
      issues.push(issue(
        'candidateCount',
        'INVALID_CANDIDATE_COUNT',
        `candidateCount ${raw} is not allowed. Allowed values: ${ALLOWED_CANDIDATE_COUNTS.join(', ')}.`,
      ));
    } else {
      candidateCount = raw;
    }
  }

  // ---- optimizationMode -------------------------------------------
  let optimizationMode = OPTIMIZATION_MODES.BASE_FEASIBLE;
  if ('optimizationMode' in body) {
    const raw = body.optimizationMode;
    if (typeof raw !== 'string' || !ALLOWED_MODES.includes(raw)) {
      issues.push(issue(
        'optimizationMode',
        'INVALID_OPTIMIZATION_MODE',
        `optimizationMode is not recognized. Allowed values: ${ALLOWED_MODES.join(', ')}.`,
      ));
    } else {
      optimizationMode = raw;
    }
  }

  // ---- useAI -------------------------------------------------------
  let useAI = true;
  if ('useAI' in body) {
    const raw = body.useAI;
    if (typeof raw !== 'boolean') {
      issues.push(issue(
        'useAI',
        'INVALID_USE_AI',
        'useAI must be a boolean (true or false).',
      ));
    } else {
      useAI = raw;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, request: { candidateCount, optimizationMode, useAI }, issues: [] };
}

function defaultRequest() {
  return {
    candidateCount: DEFAULT_CANDIDATE_COUNT,
    optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE,
    useAI: true,
  };
}

function issue(field, code, message) {
  return { field, code, message };
}

/**
 * HTTP status for a validation result. Always 400 — the solver must
 * not run, and the client is the one that is wrong.
 */
export function statusForValidation() {
  return 400;
}

// ============================================================================
// PHASE 33 — COMMIT REQUEST CONTRACT
// ============================================================================
//
// A commit request is the NARROWEST request in the system: two
// strings. `requestId` says which generation, `solutionId` says which
// solution in it, and that is the whole vocabulary.
//
// WHY NOTHING ELSE IS ACCEPTABLE
// ------------------------------
// The obvious design is to let the client post the timetable back —
// "here is the schedule I chose, save it". That design is exactly the
// one brief §4, §22 and §29 forbid, because the client then becomes
// the author of the schedule: a caller that can send `teacherId` can
// send a different teacher, and the backend would save a timetable no
// evaluator ever approved.
//
// So a body carrying anything beyond the two ids is REFUSED, not
// ignored, and the refusal says which key was refused and why. The
// reason the same field name is refused here and in `generate` is
// that the answer is the same in both places: the backend owns the
// data.
//
// The error code for a missing field stays `MISSING_REQUEST_ID` /
// `MISSING_SOLUTION_ID` — the Phase 32 commit endpoint already
// answered with those and a client that handles them keeps working
// (brief §42: the contract changes, the vocabulary does not).

/** The complete list of keys a commit request may carry. */
export const ALLOWED_COMMIT_KEYS = Object.freeze([
  'requestId',
  'solutionId',
]);

const ALLOWED_COMMIT_SET = new Set(ALLOWED_COMMIT_KEYS);

/**
 * validateCommitRequest(body) ->
 *   { ok: true,  request: { requestId, solutionId }, issues: [] }
 *   { ok: false, issues: ValidationIssue[] }
 *
 * NEVER throws, for the same reason `validateGenerateRequest` does not:
 * a malformed body is a client error and a 400 is exactly that.
 */
export function validateCommitRequest(body) {
  const issues = [];

  if (body === undefined || body === null) {
    return {
      ok: false,
      request: { requestId: null, solutionId: null },
      issues: [
        issue('body', 'MISSING_REQUEST_ID', 'A generated requestId is required.'),
        issue('body', 'MISSING_SOLUTION_ID', 'A solutionId is required.'),
      ],
    };
  }
  if (Array.isArray(body) || typeof body !== 'object') {
    return {
      ok: false,
      request: { requestId: null, solutionId: null },
      issues: [issue('body', 'INVALID_BODY', 'Request body must be a JSON object.')],
    };
  }

  for (const key of Object.keys(body)) {
    if (ALLOWED_COMMIT_SET.has(key)) continue;
    if (FORBIDDEN_SET.has(key)) {
      issues.push(issue(
        key,
        'FORBIDDEN_FIELD',
        `"${key}" cannot be supplied to /commit. A commit names a solution; it does not `
        + `carry a schedule. The backend persists the candidate it generated, so a `
        + `posted timetable could only be ignored or trusted, and neither is correct. `
        + `Allowed fields: ${ALLOWED_COMMIT_KEYS.join(', ')}.`,
      ));
      continue;
    }
    issues.push(issue(
      key,
      'UNKNOWN_FIELD',
      `Unknown field "${key}". A commit request may only carry: ${ALLOWED_COMMIT_KEYS.join(', ')}.`,
    ));
  }

  let requestId = null;
  let solutionId = null;

  if ('requestId' in body) {
    const raw = body.requestId;
    // A non-string id is refused rather than stringified: coercing
    // `{"requestId": 42}` would answer a question the client did not
    // ask, and the mismatch would never surface.
    if (typeof raw !== 'string' || raw === '') {
      issues.push(issue(
        'requestId',
        'INVALID_REQUEST_ID',
        'requestId must be the string returned by /api/schedules/generate.',
      ));
    } else {
      requestId = raw;
    }
  } else {
    issues.push(issue('requestId', 'MISSING_REQUEST_ID', 'A generated requestId is required.'));
  }

  if ('solutionId' in body) {
    const raw = body.solutionId;
    if (typeof raw !== 'string' || raw === '') {
      issues.push(issue(
        'solutionId',
        'INVALID_SOLUTION_ID',
        'solutionId must be a string. It is not a number, an object, or a slot index.',
      ));
    } else {
      solutionId = raw;
    }
  } else {
    issues.push(issue('solutionId', 'MISSING_SOLUTION_ID', 'A solutionId is required.'));
  }

  if (issues.length > 0) {
    return { ok: false, request: { requestId, solutionId }, issues };
  }
  return { ok: true, request: { requestId, solutionId }, issues: [] };
}
