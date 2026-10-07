// PHASE 34 -- DURABLE PREVIEW STORE.
//
// THE PROBLEM IT SOLVES
// ---------------------
// Phase 33's `PreviewStore` was a `Map` inside one process. A commit
// could only ever name a solution that the SAME process had generated,
// so this sequence lost the timetable it had just produced:
//
//   tab / process A   generate  ->  candidate sits in A's heap
//   A restarts       (deploy, crash, `npm run dev`, a second Node
//                    process on the same box)
//   B                commit(solutionId)  ->  404, solution not found
//
// Committed schedules were already durable. The thing you commit FROM
// was not, which made durability a property of the schedule rather
// than of the workflow around it (brief 1, 16, 17).
//
// THE SHAPE OF THE FIX
// --------------------
// One file per generation, in the persistence directory's `previews`
// subdirectory, written with the same atomic create-if-absent the
// schedule store uses (`./atomic-file.js`). Any process that can see
// the directory can read the record, verify it and commit from it.
//
// Read-through, not write-through duplication
// ------------------------------------------
// There is no in-memory cache layered on top. A cache would be a
// second source of truth with its own invalidation problem, and the
// whole point is that the file is the truth. A preview is read once,
// at commit time, so there is nothing to cache and nothing that can go
// stale. The cost is one ~0.5 MB parse per commit, which is the right
// trade against a stale candidate being committed by mistake.
//
// WHAT A CLIENT CAN AND CANNOT DO WITH A PREVIEW
// ----------------------------------------------
// The record is written by the backend from its own solver output and
// is addressed by `requestId`. A client can name a request and a
// solution; it cannot supply, replace or amend a candidate, because
// the commit request's vocabulary is still exactly two strings and the
// record is looked up BY ID (brief 2, 21).
//
// Once the record is on disk, "cannot supply" becomes "cannot supply
// without being detected": the candidate carries a hash of its own
// canonical form, recomputed on every read. A file edited between
// generate and commit fails verification and the preview is reported
// INVALID rather than handed out (brief 3, 18).
//
// PRUNING
// -------
// A preview holds three solver candidates -- roughly half a megabyte
// of JSON on the real dataset -- so an unbounded directory is a disk
// leak. `limit` (default 6, unchanged from Phase 33) caps it, oldest
// `createdAt` first, so the generations a user is looking at survive.
//
// Pruning only ever unlinks a name that passes the same strict id
// pattern `isPreviewId` accepts. It cannot be pointed at a directory,
// at a committed schedule (which lives one level up with a `sch-`
// name), or at anything a client named: the set of files it will
// consider is a function of the pattern, not of any input (brief 13).

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  writeTemp,
  linkExclusive,
  discardTemp,
  sweepTemp,
  DEFAULT_STALE_TEMP_MS,
} from './atomic-file.js';
import {
  PREVIEW_KIND,
  PREVIEW_SCHEMA_VERSION,
  PREVIEW_LIFECYCLE,
  PREVIEW_INTEGRITY,
  buildPreviewRecord,
  deserializeCandidate,
  verifyPreviewRecord,
  isExpired,
  isPreviewId,
} from './preview-record.js';

/** Default location, relative to the schedule persistence directory. */
export const DEFAULT_PREVIEW_SUBDIR = 'previews';

/** How many generations to keep. Phase 33's in-memory bound. */
export const DEFAULT_PREVIEW_LIMIT = 6;

export class DurablePreviewStore {
  /**
   * @param {object}   options
   * @param {string}   options.dir          the SCHEDULE directory; the
   *                                        previews live in a
   *                                        subdirectory of it, so a
   *                                        single configured path
   *                                        holds the whole store
   * @param {string}   [options.subdir]
   * @param {number}   [options.limit]      generations to keep
   * @param {number}   [options.ttlSeconds] null = no expiry
   * @param {number}   [options.staleTempMs] age at which a temp file
   *   from another process becomes collectable
   * @param {() => string} [options.clock]  injectable; every expiry
   *                                        and staleness decision
   *                                        reads this and nothing
   *                                        else
   */
  constructor(options = {}) {
    this.dir = join(options.dir ?? 'data/schedules', options.subdir ?? DEFAULT_PREVIEW_SUBDIR);
    this.limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_PREVIEW_LIMIT;
    this.ttlSeconds = Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0
      ? options.ttlSeconds
      : null;
    this.staleTempMs = options.staleTempMs ?? DEFAULT_STALE_TEMP_MS;
    this.clock = options.clock ?? (() => new Date().toISOString());

    mkdirSync(this.dir, { recursive: true });
    // Same two guards as the schedule store, for the same reason: a
    // second process booting must not delete this process's in-flight
    // write.
    this.sweptTempFiles = sweepTemp(this.dir, {
      nowMs: Date.parse(this.clock()),
      olderThanMs: this.staleTempMs,
    });
  }

  /** Which kind of store this is. Reported, never inferred. */
  get driver() { return 'file'; }

  /** The only place a string becomes a path, and it is a whitelist. */
  pathFor(requestId) {
    if (!isPreviewId(requestId)) {
      // Returning null rather than throwing: this store is reached
      // from a read path that must answer "not available" for a
      // malformed id, exactly as it does for a missing one. A
      // traversal attempt and a typo are the same answer.
      return null;
    }
    return join(this.dir, `${requestId}.json`);
  }

  /**
   * The raw record as stored, or null.
   *
   * No integrity check and no expiry check: this is the bytes, for
   * `describe` and for tests that need to prove a file was damaged.
   */
  readRaw(requestId) {
    const path = this.pathFor(requestId);
    if (!path) return null;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      // A truncated or hand-edited file is not a preview. It is
      // reported as INVALID by `describe`, never as a schedule, and
      // the process does not go down over it (brief 11, 26).
      return { __unreadable: true, requestId };
    }
  }

  /**
   * The lifecycle of one preview, and the integrity of its candidates.
   *
   * This is the answer `/commit` asks BEFORE it looks for a solution
   * id, because "the generation is not available" and "the candidate
   * was tampered with" are different problems with different
   * recoveries -- generate again versus investigate the store.
   */
  describe(requestId) {
    if (!isPreviewId(requestId)) {
      return { requestId: requestId ?? null, lifecycle: PREVIEW_LIFECYCLE.INVALID, integrity: PREVIEW_INTEGRITY.FAILED, reason: 'MALFORMED_ID', solutionIds: [] };
    }
    const path = this.pathFor(requestId);
    if (!existsSync(path)) {
      return { requestId, lifecycle: PREVIEW_LIFECYCLE.MISSING, integrity: PREVIEW_INTEGRITY.NOT_TRACKED, reason: 'NOT_STORED', solutionIds: [] };
    }
    const record = this.readRaw(requestId);
    if (!record || record.__unreadable) {
      return { requestId, lifecycle: PREVIEW_LIFECYCLE.INVALID, integrity: PREVIEW_INTEGRITY.FAILED, reason: 'UNREADABLE_RECORD', solutionIds: [] };
    }
    if (record.kind !== PREVIEW_KIND) {
      return { requestId, lifecycle: PREVIEW_LIFECYCLE.INVALID, integrity: PREVIEW_INTEGRITY.FAILED, reason: 'NOT_A_PREVIEW', solutionIds: [] };
    }

    const now = this.clock();
    const base = {
      requestId,
      createdAt: record.createdAt ?? null,
      expiresAt: record.expiresAt ?? null,
      solutionIds: (Array.isArray(record.solutions) ? record.solutions : []).map((s) => s?.id ?? null),
    };

    // Expiry is checked BEFORE integrity. An expired record's contents
    // are irrelevant to the answer -- it cannot be committed either
    // way -- and reporting it as INVALID would send an operator
    // looking for tampering that did not happen.
    if (isExpired(record, now)) {
      return { ...base, lifecycle: PREVIEW_LIFECYCLE.EXPIRED, integrity: PREVIEW_INTEGRITY.NOT_TRACKED, reason: 'TTL_PASSED' };
    }

    const verified = verifyPreviewRecord(record);
    if (!verified.ok) {
      return { ...base, lifecycle: PREVIEW_LIFECYCLE.INVALID, integrity: PREVIEW_INTEGRITY.FAILED, reason: 'INTEGRITY_MISMATCH', mismatched: verified.mismatched };
    }

    return { ...base, lifecycle: PREVIEW_LIFECYCLE.AVAILABLE, integrity: PREVIEW_INTEGRITY.VERIFIED, reason: null };
  }

  /**
   * The solutions of one generation, shaped for `commit.js`.
   *
   * -> `[{ id, solution, candidate, strategy, ai }]`, the same shape
   *    the in-memory store returns, or null when the preview is not
   *    usable (missing, expired, or integrity-failed).
   *
   * Returning null for a TAMPERED record is deliberate: handing the
   * caller a candidate whose hash does not match would move the
   * decision to a place with less context. The refusal belongs here,
   * where the store can say why, and `commit` turns it into a 409.
   */
  get(requestId) {
    const description = this.describe(requestId);
    if (description.lifecycle !== PREVIEW_LIFECYCLE.AVAILABLE) return null;
    const record = this.readRaw(requestId);
    if (!record || record.__unreadable) return null;

    return (Array.isArray(record.solutions) ? record.solutions : []).map((entry) => ({
      id: entry?.id ?? null,
      solution: entry?.solution ?? null,
      // Back to real `Map`s: the evaluator and the scorer both walk
      // Maps, and a JSON array of pairs is not one.
      candidate: deserializeCandidate(entry?.candidate),
      strategy: entry?.strategy ?? null,
      ai: entry?.ai ?? null,
    }));
  }

  /**
   * Store one generation. Async because it writes to disk.
   *
   * Idempotent by `requestId`: the second write of the same id loses
   * `link(2)` to EEXIST and the FIRST record is returned unchanged. A
   * preview is a record of what a generation produced; letting a
   * second writer replace it would mean the committed schedule and the
   * preview could describe different candidates, and nothing would
   * report the disagreement.
   */
  async put(requestId, solutions) {
    const path = this.pathFor(requestId);
    if (!path) {
      return { stored: false, duplicate: false, requestId: requestId ?? null, reason: 'MALFORMED_ID' };
    }
    const record = buildPreviewRecord({
      requestId,
      solutions,
      createdAt: this.clock(),
      ttlSeconds: this.ttlSeconds,
    });
    const payload = `${JSON.stringify(record)}\n`;

    const tmpPath = await writeTemp(this.dir, requestId, payload);
    try {
      const result = await linkExclusive(tmpPath, path);
      if (!result.linked) {
        // Someone already stored this generation. Their record wins,
        // and it is returned so the caller can report the truth rather
        // than what it was about to write.
        const existing = this.readRaw(requestId);
        return {
          stored: true,
          duplicate: true,
          requestId,
          record: existing && !existing.__unreadable ? existing : record,
        };
      }
    } finally {
      await discardTemp(tmpPath);
    }

    this.prune();
    return { stored: true, duplicate: false, requestId, record };
  }

  /**
   * Drop the oldest generations past `limit`.
   *
   * Only names matching the preview id pattern are ever unlinked, and
   * a preview that is already committed is left alone: the committed
   * schedule is the durable fact, but deleting the preview that
   * produced it makes a legitimate second commit impossible, and
   * "I committed solution 2" should not stop working because three
   * more generations happened since.
   */
  prune() {
    const entries = this.entries();
    if (entries.length <= this.limit) return 0;
    const excess = entries
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.requestId.localeCompare(b.requestId))
      .slice(0, entries.length - this.limit);
    let removed = 0;
    for (const entry of excess) {
      if (this.committedRefs().has(entry.requestId)) continue;
      try { unlinkSync(join(this.dir, `${entry.requestId}.json`)); removed += 1; } catch { /* best effort */ }
    }
    return removed;
  }

  /**
   * requestIds that already produced a committed schedule.
   *
   * Read from the parent directory, one level up, because that is
   * where the schedule store keeps its records. A missing parent is
   * not an error: a deployment can have previews and no commits yet.
   */
  committedRefs() {
    const parent = join(this.dir, '..');
    const refs = new Set();
    let names = [];
    try { names = readdirSync(parent); } catch { return refs; }
    for (const name of names) {
      if (!/^sch-[0-9a-f]{16}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(readFileSync(join(parent, name), 'utf8'));
        if (record?.requestId) refs.add(record.requestId);
      } catch { /* a corrupt schedule is not a reason to prune wrongly */ }
    }
    return refs;
  }

  /** `{ requestId, createdAt, expiresAt, solutionCount }` per stored preview. */
  entries() {
    let names = [];
    try { names = readdirSync(this.dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!isPreviewId(id)) continue;
      const record = this.readRaw(id);
      if (!record || record.__unreadable) {
        out.push({ requestId: id, createdAt: null, expiresAt: null, solutionCount: 0, readable: false });
        continue;
      }
      out.push({
        requestId: id,
        createdAt: record.createdAt ?? null,
        expiresAt: record.expiresAt ?? null,
        solutionCount: Number.isInteger(record.solutionCount) ? record.solutionCount : 0,
        readable: true,
      });
    }
    return out;
  }

  /** Request ids a client could still commit from, newest first. */
  available() {
    return this.entries()
      .filter((e) => e.readable)
      .map((e) => this.describe(e.requestId))
      .filter((d) => d.lifecycle === PREVIEW_LIFECYCLE.AVAILABLE || d.lifecycle === PREVIEW_LIFECYCLE.EXPIRED)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** Diagnostic counters. Reported by `/health`, never by a commit. */
  stats() {
    const entries = this.entries();
    return {
      dir: this.dir,
      limit: this.limit,
      ttlSeconds: this.ttlSeconds,
      stored: entries.length,
      readable: entries.filter((e) => e.readable).length,
      expired: entries.filter((e) => e.readable && this.describe(e.requestId).lifecycle === PREVIEW_LIFECYCLE.EXPIRED).length,
    };
  }

  /** Never deletes a stored record. Kept for interface parity. */
  clear() {
    // A deliberate no-op. `PreviewStore.clear()` is in the Phase 32
    // test surface, and making it destructive here would give a
    // method whose name says one thing and whose effect is another.
    // Previews are shed by `prune`, under a bound, by age.
  }
}

export { PREVIEW_SCHEMA_VERSION };
export default DurablePreviewStore;
