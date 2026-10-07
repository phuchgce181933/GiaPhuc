import { ALLOWED_CANDIDATE_COUNTS, OPTIMIZATION_MODES } from '../domain/strategies.js';
export const API_VERSION = 'timetable-v1';
export const DEFAULT_CANDIDATE_COUNT = 3;
export const ALLOWED_REQUEST_KEYS = Object.freeze(['candidateCount', 'optimizationMode']);
export const FORBIDDEN_REQUEST_KEYS = Object.freeze(['teacherId', 'teacherIds', 'teacher', 'classId', 'classIds', 'class', 'subjectId', 'subjects', 'branchId', 'branchIds', 'branch', 'assignmentId', 'assignments', 'slots', 'placements', 'schedule', 'solution', 'solutions', 'day', 'days', 'session', 'sessions', 'period', 'periods', 'seed', 'strategy', 'strategies', 'weights', 'scoringWeights', 'constraints', 'constraintOverrides', 'hardConstraints', 'travelStatus', 'travelTime', 'transferStatus', 'transfer', 'optimizationModeRaw', 'timeBudgetMs', 'maxSearchIterations', 'input', 'model', 'dataset', 'skipValidation', 'force']);
const FORBIDDEN_SET = new Set(FORBIDDEN_REQUEST_KEYS);
const ALLOWED_SET = new Set(ALLOWED_REQUEST_KEYS);
const ALLOWED_MODES = Object.freeze(Object.values(OPTIMIZATION_MODES));
export function validateGenerateRequest(body) {
  const issues = [];
  if (body === undefined || body === null) {
    return {
      ok: true,
      request: defaultRequest(),
      issues: []
    };
  }
  if (Array.isArray(body)) {
    issues.push(issue('body', 'INVALID_BODY', 'Request body must be a JSON object.'));
    return {
      ok: false,
      issues
    };
  }
  if (typeof body !== 'object') {
    issues.push(issue('body', 'INVALID_BODY', 'Request body must be a JSON object.'));
    return {
      ok: false,
      issues
    };
  }
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_SET.has(key)) {
      issues.push(issue(key, 'FORBIDDEN_FIELD', `"${key}" cannot be supplied by a client. The backend owns the data, the ` + 'constraints, and the solver settings; a request may only carry ' + `${ALLOWED_REQUEST_KEYS.join(', ')}.`));
      continue;
    }
    if (!ALLOWED_SET.has(key)) {
      issues.push(issue(key, 'UNKNOWN_FIELD', `Unknown field "${key}". Allowed fields: ${ALLOWED_REQUEST_KEYS.join(', ')}.`));
    }
  }
  let candidateCount = DEFAULT_CANDIDATE_COUNT;
  if ('candidateCount' in body) {
    const raw = body.candidateCount;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      issues.push(issue('candidateCount', 'INVALID_CANDIDATE_COUNT', `candidateCount must be an integer. Allowed values: ${ALLOWED_CANDIDATE_COUNTS.join(', ')}.`));
    } else if (!ALLOWED_CANDIDATE_COUNTS.includes(raw)) {
      issues.push(issue('candidateCount', 'INVALID_CANDIDATE_COUNT', `candidateCount ${raw} is not allowed. Allowed values: ${ALLOWED_CANDIDATE_COUNTS.join(', ')}.`));
    } else {
      candidateCount = raw;
    }
  }
  let optimizationMode = OPTIMIZATION_MODES.BASE_FEASIBLE;
  if ('optimizationMode' in body) {
    const raw = body.optimizationMode;
    if (typeof raw !== 'string' || !ALLOWED_MODES.includes(raw)) {
      issues.push(issue('optimizationMode', 'INVALID_OPTIMIZATION_MODE', `optimizationMode is not recognized. Allowed values: ${ALLOWED_MODES.join(', ')}.`));
    } else {
      optimizationMode = raw;
    }
  }
  if (issues.length > 0) return {
    ok: false,
    issues
  };
  return {
    ok: true,
    request: {
      candidateCount,
      optimizationMode
    },
    issues: []
  };
}
function defaultRequest() {
  return {
    candidateCount: DEFAULT_CANDIDATE_COUNT,
    optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE
  };
}
function issue(field, code, message) {
  return {
    field,
    code,
    message
  };
}
export function statusForValidation() {
  return 400;
}
export const ALLOWED_COMMIT_KEYS = Object.freeze(['requestId', 'solutionId']);
const ALLOWED_COMMIT_SET = new Set(ALLOWED_COMMIT_KEYS);
export function validateCommitRequest(body) {
  const issues = [];
  if (body === undefined || body === null) {
    return {
      ok: false,
      request: {
        requestId: null,
        solutionId: null
      },
      issues: [issue('body', 'MISSING_REQUEST_ID', 'A generated requestId is required.'), issue('body', 'MISSING_SOLUTION_ID', 'A solutionId is required.')]
    };
  }
  if (Array.isArray(body) || typeof body !== 'object') {
    return {
      ok: false,
      request: {
        requestId: null,
        solutionId: null
      },
      issues: [issue('body', 'INVALID_BODY', 'Request body must be a JSON object.')]
    };
  }
  for (const key of Object.keys(body)) {
    if (ALLOWED_COMMIT_SET.has(key)) continue;
    if (FORBIDDEN_SET.has(key)) {
      issues.push(issue(key, 'FORBIDDEN_FIELD', `"${key}" cannot be supplied to /commit. A commit names a solution; it does not ` + `carry a schedule. The backend persists the candidate it generated, so a ` + `posted timetable could only be ignored or trusted, and neither is correct. ` + `Allowed fields: ${ALLOWED_COMMIT_KEYS.join(', ')}.`));
      continue;
    }
    issues.push(issue(key, 'UNKNOWN_FIELD', `Unknown field "${key}". A commit request may only carry: ${ALLOWED_COMMIT_KEYS.join(', ')}.`));
  }
  let requestId = null;
  let solutionId = null;
  if ('requestId' in body) {
    const raw = body.requestId;
    if (typeof raw !== 'string' || raw === '') {
      issues.push(issue('requestId', 'INVALID_REQUEST_ID', 'requestId must be the string returned by /api/schedules/generate.'));
    } else {
      requestId = raw;
    }
  } else {
    issues.push(issue('requestId', 'MISSING_REQUEST_ID', 'A generated requestId is required.'));
  }
  if ('solutionId' in body) {
    const raw = body.solutionId;
    if (typeof raw !== 'string' || raw === '') {
      issues.push(issue('solutionId', 'INVALID_SOLUTION_ID', 'solutionId must be a string. It is not a number, an object, or a slot index.'));
    } else {
      solutionId = raw;
    }
  } else {
    issues.push(issue('solutionId', 'MISSING_SOLUTION_ID', 'A solutionId is required.'));
  }
  if (issues.length > 0) {
    return {
      ok: false,
      request: {
        requestId,
        solutionId
      },
      issues
    };
  }
  return {
    ok: true,
    request: {
      requestId,
      solutionId
    },
    issues: []
  };
}
