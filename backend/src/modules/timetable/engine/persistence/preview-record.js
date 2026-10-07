// PHASE 34 -- PREVIEW RECORD: the persisted shape of one generation.
//
// WHY A PREVIEW NEEDS TO SURVIVE THE PROCESS
// ------------------------------------------
// In Phase 33 the preview lived in a `Map` inside one Node process.
// The failure that motivated this module is short:
//
//   process A:  generate  ->  the candidate sits in A's heap
//   process A:  dies      ->  the candidate is gone
//   process B:  commit(solutionId)  ->  404, solution not found
//
// Committed schedules were already durable; the thing you commit FROM
// was not. So the preview is now a file, written by the same
// atomic create-if-absent primitive the schedule store already uses,
// and a second process can read it (brief 1, 16, 17).
//
// WHAT IS STORED, AND WHY IT IS NOT "EVERYTHING"
// ----------------------------------------------
// The commit path needs, per solution, exactly five things:
//
//   candidate          the solver object, to re-validate and to build
//                      rows from -- the whole point of the record
//   strategy / ai      the generation's own decisions, so the audit
//                      block is read rather than reconstructed
//   rank               which place it took in the pool
//   globalScore,       the score the USER SAW. Storing the solution's
//   qualityScore,      display object would mean storing 802
//   rankReason         placement rows a second time, duplicating the
//                      candidate for no gain.
//
// So the record keeps the candidate in full and a WHITELISTED score
// projection instead of the display object. The whitelist is the same
// discipline `mappers.js` applies on the other side of the wire: a
// field that is not named here cannot reach the committed audit block
// by being added to a mapper (brief 2).
//
// THE INTEGRITY HASH IS THE POINT OF THE FILE
// -------------------------------------------
// Once a file is on disk it is mutable by anything with filesystem
// access, and a commit that trusts the file trusts whoever last wrote
// it. So the candidate is canonically serialized and hashed AT WRITE
// TIME, and the hash is re-checked on every read. A candidate that
// changed after it was stored fails the check and the whole preview is
// reported INVALID rather than handed out (brief 3, 18).
//
// "Canonical" has to mean something precise, because the same object
// can serialize two ways. The rules, and why each one is here:
//
//   * object keys are emitted in sorted order
//       A `Map` iteration order or an object literal order is not a
//       property of the schedule, and a hash that moved when a field
//       was reordered would report tampering where there is none.
//
//   * `undefined` fields are omitted, and non-finite numbers become
//       `null`
//       Those are exactly the two transformations `JSON.stringify`
//       performs, so hashing the in-memory object and re-hashing the
//       object that came back from `JSON.parse` agree. Without this
//       the hash would fail on its own round trip -- a check that
//       reports every write as tampering is a check nobody trusts.
//
//   * `Map` becomes a SORTED array of `[key, value]` pairs
//       The solver hands back `Map`s; JSON has no Map. Sorting makes
//       the array a set rather than a sequence, matching the intent.
//
// EXPIRATION IS OPT-IN AND OFF BY DEFAULT
// --------------------------------------
// `expiresAt` is written only when a TTL is configured, and the
// default is "no TTL". The reason is that a policy nobody chose is
// worse than no policy: previews that silently vanish turn an
// open browser tab into a 410 with no explanation. An operator who
// wants one sets `PREVIEW_TTL_SECONDS`, and the record then carries
// the expiry that was applied, so the behaviour is inspectable after
// the fact rather than inferred (brief 4).
//
// The TTL is computed from the store's injected CLOCK, never from a
// bare `Date.now()` at the point of use, so a test can move time
// deliberately instead of sleeping.

import { createHash } from 'node:crypto';

/** Bump when the preview record's shape changes. */
export const PREVIEW_SCHEMA_VERSION = 1;

/** Written into every record so a reader can tell what it is holding. */
export const PREVIEW_KIND = 'PREVIEW';

/**
 * The preview lifecycle (brief 18).
 *
 *   GENERATED  the solver finished; nothing is stored yet
 *   AVAILABLE  stored, integrity verified, not yet committed
 *   COMMITTED  a committed schedule exists for it (derived, not stored)
 *   EXPIRED    a TTL was configured and has passed
 *   INVALID    the integrity hash did not match, the id was malformed,
 *              or the file is not readable JSON
 *   MISSING    no record for this request id
 *
 * `COMMITTED` is DERIVED rather than stored, because a preview is not
 * modified when its solution is committed: writing that fact into the
 * record would mean a second writer mutating a file whose integrity is
 * protected by a hash, which is the one thing a hash cannot survive.
 * The answer is therefore computed by asking the schedule store, and
 * it can never disagree with it (brief 18, 20).
 */
export const PREVIEW_LIFECYCLE = Object.freeze({
  GENERATED: 'GENERATED',
  AVAILABLE: 'AVAILABLE',
  COMMITTED: 'COMMITTED',
  EXPIRED: 'EXPIRED',
  INVALID: 'INVALID',
  MISSING: 'MISSING',
});

/**
 * How the candidate's integrity was established.
 *
 *   VERIFIED     the stored hash was recomputed and matched
 *   FAILED       it was recomputed and did NOT match
 *   NOT_TRACKED  this store does not hash candidates (the in-memory
 *                Phase 33 store). Reported rather than implied, so a
 *                response can never claim a check that did not run.
 */
export const PREVIEW_INTEGRITY = Object.freeze({
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  NOT_TRACKED: 'NOT_TRACKED',
});

/** The only fields of a display solution the commit path consumes. */
export const SOLUTION_META_FIELDS = Object.freeze([
  'rank',
  'globalScore',
  'qualityScore',
  'scoring',
]);

/** Preview ids are used as file names, so the accepted shape is narrow. */
const PREVIEW_ID = /^req-[0-9a-z]{1,16}(?:-[0-9a-f]{4,32})?$/;

/**
 * Is this a string the preview store is willing to turn into a path?
 *
 * This is a WHITELIST, applied before any string reaches `join`, and
 * it is deliberately narrower than "does not contain a slash". A
 * client-supplied identifier that fails it never becomes a path at
 * all, so there is no filename left to sanitize afterwards and no
 * `../` to normalize away (brief 14).
 */
export function isPreviewId(value) {
  return typeof value === 'string' && PREVIEW_ID.test(value);
}

// ============================================================================
// Canonical serialization + integrity
// ============================================================================

/**
 * Canonical JSON for a candidate, in the form it is STORED in.
 *
 * The important word is "stored": this hashes the serialized shape, not
 * the live solver object. Hashing the live object would produce a
 * different string -- `Map`s encode as `map[...]`, plain objects as
 * `{...}` -- and the two would never agree when the record came back
 * off disk, so a check written that way would report every write as
 * tampering. One encoding, used by the writer and the verifier, is
 * the only version of this that can be correct.
 *
 * The rules, and why each one is here:
 *
 *   * object keys are emitted in sorted order
 *       A `Map` iteration order or an object literal order is not a
 *       property of the schedule, and a hash that moved when a field
 *       was reordered would report tampering where there is none.
 *
 *   * `undefined` fields are omitted, and non-finite numbers become
 *       `null`
 *       Those are exactly the two transformations `JSON.stringify`
 *       performs, so hashing the in-memory object and re-hashing the
 *       object that came back from `JSON.parse` agree. Without this
 *       the hash would fail on its own round trip -- a check that
 *       reports every write as tampering is a check nobody trusts.
 *
 *   * a `Map` becomes a SORTED array of `[key, value]` pairs
 *       The solver hands back `Map`s; JSON has no Map. Sorting makes
 *       the array a set rather than a sequence, which is what the
 *       schedule actually is.
 */
export function canonicalCandidateJson(candidate) {
  return canonical(serializeCandidate(candidate));
}

/** SHA-256 of the canonical form. 64 lowercase hex characters. */
export function candidateIntegrityHash(candidate) {
  return createHash('sha256').update(canonicalCandidateJson(candidate)).digest('hex');
}

function canonical(value) {
  if (value === null || value === undefined) return 'null';

  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(value.toString());
  if (t === 'function' || t === 'symbol') return 'null';

  if (value instanceof Map) {
    // Sorted so the encoding is a SET of pairs, not a sequence.
    const parts = [...value.entries()]
      .map(([k, v]) => `[${canonical(k)},${canonical(v)}]`)
      .sort();
    return `map[${parts.join(',')}]`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  // Plain object. `undefined` members are skipped, exactly as
  // `JSON.stringify` skips them, so a round trip through disk is a
  // fixed point.
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    parts.push(`${JSON.stringify(key)}:${canonical(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Timing-safe-ish comparison of two hex digests. Length check first. */
export function integrityMatches(stored, actual) {
  if (typeof stored !== 'string' || typeof actual !== 'string') return false;
  if (stored.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < stored.length; i += 1) diff |= stored.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

// ============================================================================
// Candidate (de)serialization
// ============================================================================

/**
 * Solver candidate -> plain JSON.
 *
 * `Map` becomes an array of pairs because that is all JSON can carry.
 * Nothing is dropped: the record has to re-validate to the same
 * verdict it was generated with, and a dropped slot would show up as
 * a violation the user never caused.
 */
export function serializeCandidate(candidate) {
  return {
    assignments: mapToPairs(candidate?.assignments).map(([id, slots]) => [
      id,
      (Array.isArray(slots) ? slots : []).map((s) => ({ ...s })),
    ]),
    placements: mapToPairs(candidate?.placements).map(([id, p]) => [
      id,
      { ...(p ?? {}) },
    ]),
  };
}

/** The inverse. The commit path needs real `Map`s for the evaluator. */
export function deserializeCandidate(payload) {
  const assignments = new Map();
  const placements = new Map();
  for (const [id, slots] of toPairs(payload?.assignments)) {
    assignments.set(id, Array.isArray(slots) ? slots.map((s) => ({ ...s })) : []);
  }
  for (const [id, placement] of toPairs(payload?.placements)) {
    placements.set(id, { ...(placement ?? {}) });
  }
  return { assignments, placements };
}

function mapToPairs(value) {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value.filter((e) => Array.isArray(e) && e.length === 2);
  return [];
}

function toPairs(value) {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value.filter((e) => Array.isArray(e) && e.length === 2);
  return [];
}

// ============================================================================
// The record
// ============================================================================

/**
 * projectSolutionMeta(solution) -> the whitelisted score projection.
 *
 * Only the fields `commit.js` reads. In particular the 802
 * `placements` rows are NOT copied: they are the candidate's job, and
 * duplicating them would double the record for no reader.
 */
export function projectSolutionMeta(solution) {
  const out = {};
  for (const field of SOLUTION_META_FIELDS) {
    if (solution?.[field] !== undefined) out[field] = solution[field];
  }
  return out;
}

/**
 * buildPreviewRecord({ requestId, solutions, createdAt, ttlSeconds })
 *
 * `solutions` are the entries `generateSchedules` hands the store:
 * `{ id, solution, candidate, strategy, ai }`. The candidate is hashed
 * HERE, at the moment the record is built, and the hash is written
 * beside it -- so the hash describes what the solver produced, not
 * what happens to be on disk later.
 */
export function buildPreviewRecord({ requestId, solutions, createdAt, ttlSeconds = null }) {
  const list = Array.isArray(solutions) ? solutions : [];
  const entries = list.map((entry) => {
    const candidate = serializeCandidate(entry.candidate);
    return {
      id: entry.id ?? null,
      candidate,
      // Hashed HERE, at the moment the record is built, and by the
      // same function the verifier uses -- so the hash describes what
      // the solver produced, in the exact encoding that will come
      // back off disk, rather than two encodings that have to be
      // reconciled later.
      integrityHash: candidateIntegrityHash(entry.candidate),
      solution: projectSolutionMeta(entry.solution ?? {}),
      strategy: entry.strategy ?? null,
      ai: entry.ai ?? null,
    };
  });

  const createdMs = Date.parse(createdAt);
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : null;

  return {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    kind: PREVIEW_KIND,
    requestId,
    createdAt,
    // `null` means "no expiry was configured", which is a different
    // statement from "expires in 0 seconds".
    expiresAt: ttl !== null && Number.isFinite(createdMs)
      ? new Date(createdMs + ttl * 1000).toISOString()
      : null,
    solutionCount: entries.length,
    solutions: entries,
  };
}

/**
 * verifyPreviewRecord(record) ->
 *   { ok, integrity, mismatched: [solutionId] }
 *
 * Re-derives each candidate's hash from the record's own bytes, using
 * the same `canonical` the writer used. A record with no solutions is
 * `ok` with `VERIFIED`: there is nothing that could have been
 * tampered with, and reporting `NOT_TRACKED` for an empty generation
 * would be a confusing answer to an uninteresting question.
 */
export function verifyPreviewRecord(record) {
  const entries = Array.isArray(record?.solutions) ? record.solutions : [];
  const mismatched = [];
  for (const entry of entries) {
    // Hash the STORED candidate, verbatim. Re-serializing it first
    // would be a second implementation of the same thing, and a bug
    // there would either mask a real edit or invent a false one.
    const actual = createHash('sha256').update(canonical(entry?.candidate ?? null)).digest('hex');
    if (!integrityMatches(entry?.integrityHash, actual)) mismatched.push(entry?.id ?? null);
  }
  return {
    ok: mismatched.length === 0,
    integrity: mismatched.length === 0 ? PREVIEW_INTEGRITY.VERIFIED : PREVIEW_INTEGRITY.FAILED,
    mismatched,
  };
}

/**
 * isExpired(record, nowIso) -> boolean
 *
 * The clock is a parameter, never read from the process inside this
 * module. A policy that reached for ambient time would be untestable
 * in the one way that matters -- proving an expiry actually fires.
 */
export function isExpired(record, nowIso) {
  const expiresAt = record?.expiresAt;
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) return false;
  return nowMs >= expiresMs;
}
