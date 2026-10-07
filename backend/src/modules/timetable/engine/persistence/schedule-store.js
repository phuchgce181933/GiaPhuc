// PHASE 33/34 -- SCHEDULE STORE: atomic, idempotent, append-only.

//

// WHY A FILE STORE AND NOT MONGODB

// --------------------------------

// Phase 33 read the architecture before choosing, and Phase 34

// re-confirmed it: this repository has NO database. `package.json`

// depends on `express` and `bson` (a serializer, not a driver),

// `config.mongoUri` is parsed and never used, and no module under

// `src/` opens a client. Adding MongoDB would mean a second

// persistence layer, a driver dependency, a running server and a

// connection story -- none of which exist today, and none of which

// the brief asked for. Phase 34 hardens the store that exists; a

// migration is its own phase (brief 27).

//

// So the store is a directory of JSON documents, one file per

// committed schedule, and the design keeps the driver replaceable: the

// API layer calls `create` / `read` / `list` and never touches

// `node:fs`, so swapping in MongoDB is a change to THIS FILE and

// nothing else. No `ScheduleV2` / `ScheduleFinal` / `ScheduleNew`

// type was introduced.

//

// WHY ONE FILE PER SCHEDULE

// -------------------------

// A single growing index document would need a read-modify-write to

// append, and a read-modify-write is exactly where partial writes

// live. One file per schedule means an append is a CREATE, and

// `link(2)` gives create-if-absent atomically. There is no window in

// which a schedule exists in the index but not on disk, or vice

// versa, because there is no separate index.

//

// HOW ATOMICITY IS ACHIEVED

// -------------------------

// See `./atomic-file.js`, which owns the sequence and is shared with

// the preview store:

//

//   1. serialize the whole record (all 802 slots) to a temp file in

//      the SAME directory -- same filesystem, which is what makes

//      step 3 atomic rather than a copy

//   2. write it, `fsync` it, close it -- the bytes are on the device

//      before anything is visible under the real name

//   3. `link(tmp, final)` -- POSIX: fails with EEXIST if `final`

//      exists, and otherwise appears atomically

//   4. `unlink(tmp)` -- cleanup only; the record is already durable

//

// Step 3 is the all-or-nothing point. A reader sees either no file or

// a complete file; it can never see a half-written schedule, and a

// crash at any step leaves at worst a stray temp file (swept on the

// next store construction) -- never a partial record under a real id.

// There is no code path in which some slots are stored and the

// request still returns success (brief 10, 13).

//

// IDEMPOTENCY IS STRUCTURAL, NOT A LOOKUP

// ---------------------------------------

// `scheduleId` is DERIVED from the pair (requestId, solutionId) by

// hashing it. Two identical commit requests therefore address the same

// file by construction: the second `link` gets EEXIST, the store

// returns the existing record, and the response says

// `duplicate: true` with the same `scheduleId`. A double-click cannot

// create a second schedule because there is no second name for it, and

// the client does not supply the key -- so a client cannot cause a

// duplicate by choosing a different one (brief 7, 23).

//

// VERSION ALLOCATION (brief 5, 6, 24, 25)

// -----------------------------------------

// Phase 33 numbered versions from an in-process counter seeded by a

// directory scan. Correct for one Node process; two processes writing

// the same directory could both hand out `version: 4`.

//

// The fix uses the primitive that is already the store's foundation

// rather than adding a lock. A version is claimed by hard-linking the

// finished temp file to a NAME DERIVED FROM THE VERSION:

//

//   link(tmp, ".version-000000000004")  -> claimed by exactly one writer

//   link(tmp, "sch-8afa59b87c3282bb")   -> the published record

//

// Both are hard links to the same inode, so the claim costs one

// directory entry and no extra bytes. `link(2)` fails with EEXIST for

// everyone else, and EEXIST is the OS, not a lock protocol this

// module invented and could get wrong. A writer that loses the race

// takes the next number.

//

// What this guarantees, stated precisely (brief 25):

//

//   GUARANTEED   no two stored records ever share a version

//   GUARANTEED   the allocation is correct across processes, because

//                the exclusivity is `link(2)` on a shared directory

//   NOT CLAIMED  that version order equals commit-completion order.

//                A writer can claim 4, lose the disk for a while, and

//                publish after a writer that claimed 5. Numbers stay

//                unique and the ORDER is the allocation order, which

//                is what an ordering is for -- it is not a clock.

//

// A version is released (its claim unlinked) only in the case where

// the record name turned out to be taken: the number was allocated

// and then not used, so leaving it claimed would burn it forever for

// a duplicate request. Releasing it cannot create a collision between

// two RECORDS, because the claim is exclusive at the moment it is

// taken; the only consequence is that the sequence can close a gap,

// which is why the numbers are called an ordering and not a count.

//

// GAPS ARE EXPECTED AND HARMLESS

// A replay that finds the record already present exits on the fast

// path BEFORE claiming anything, so it consumes no number. A replay

// that loses the create-if-absent race does, which is what the

// "may claim a number it does not use" note means. Either way the

// number is never assigned to two schedules.

//

// CORRUPTION IS CONTAINED, NOT ABSENT

// ------------------------------------

// A file can be truncated, hand-edited, or written by something else

// entirely. The store's obligation is to stay usable: `read` refuses

// to invent a schedule, `list` skips what it cannot parse, and

// `health` reports the count so the condition is visible instead of

// silent. One bad record never makes the directory unreadable

// (brief 11, 26).

//

// DIRECTORY SAFETY (brief 14)

// ----------------------------

// `pathFor` is the ONLY place a string becomes a path and it is a

// whitelist: `sch-` plus exactly 16 lowercase hex characters. A

// client-supplied `../../.env` fails the pattern, so no path is built

// from it at all -- there is nothing to normalize afterwards, and no

// traversal to defend against downstream.



import {

  existsSync,

  mkdirSync,

  readdirSync,

  readFileSync,

  unlinkSync,

} from 'node:fs';

import { createHash } from 'node:crypto';

import { join } from 'node:path';



import {

  writeTemp,

  linkExclusive,

  discardTemp,

  sweepTemp,

  isAlreadyExists,

  DEFAULT_STALE_TEMP_MS,

} from './atomic-file.js';

import { RECORD_SCHEMA_VERSION } from './schedule-record.js';



/** Default location, relative to the backend package root. */

export const DEFAULT_PERSISTENCE_DIR = 'data/schedules';



/** The only filename shape this store will ever build. */

const SCHEDULE_ID = /^sch-[0-9a-f]{16}$/;



/**

 * A claim file name. Zero-padded so a lexical sort of the directory

 * is also a numeric sort, which is a property worth having when the

 * high-water mark is read back by a human with `ls`.

 */

function versionClaimName(version) {

  return `.version-${String(version).padStart(12, '0')}`;

}



const VERSION_CLAIM = /^\.version-(\d{1,15})$/;



/** An error the store raises deliberately, and `commit` maps to a code. */

export class ScheduleStoreError extends Error {

  constructor(code, message) {

    super(message);

    this.name = 'ScheduleStoreError';

    this.code = code;

  }

}



/**

 * The deterministic id for a (requestId, solutionId) pair.

 *

 * NUL-separated so `("a", "bc")` and `("ab", "c")` cannot collide,

 * which a plain join would allow.

 *

 * THE SEPARATOR IS PART OF THE CONTRACT. It is a literal NUL, not a

 * space, and Phase 34 kept it byte for byte: changing it would

 * re-derive every `scheduleId`, so a record committed under Phase 33

 * would no longer be found by the same (requestId, solutionId) pair,

 * and the "one record per pair" guarantee would quietly become "one

 * record per pair, except across a deploy". A NUL is also the only

 * separator here that is unambiguous, because it cannot occur in

 * either id.

 */

export function scheduleIdFor(requestId, solutionId) {

  const h = createHash('sha256')

    .update(String(requestId))

    .update(' ')

    .update(String(solutionId))

    .digest('hex');

  return `sch-${h.slice(0, 16)}`;

}



export class ScheduleStore {

  /**

   * @param {object}   options

   * @param {string}   options.dir           directory for the records

   * @param {() => string} [options.clock]   injectable for tests

   * @param {number}   [options.staleTempMs] age at which a temp file

   *   from ANOTHER process becomes collectable. See

   *   `DEFAULT_STALE_TEMP_MS` for why there is an age at all.

   */

  constructor(options = {}) {

    this.dir = options.dir ?? DEFAULT_PERSISTENCE_DIR;

    this.clock = options.clock ?? (() => new Date().toISOString());

    this.staleTempMs = options.staleTempMs ?? DEFAULT_STALE_TEMP_MS;

    this.ensureDir();

    this.sweptTempFiles = this.sweepTemp();

    this.nextVersion = this.highestVersion() + 1;

    /** @type {Map<string, Promise<any>>} in-process commit mutex */

    this.locks = new Map();

  }



  ensureDir() {

    mkdirSync(this.dir, { recursive: true });

  }



  /**

   * Remove leftover temp files from an interrupted write.

   *

   * A temp file is by definition not a record: it has no id a client

   * could have been given, because the id only becomes real at the

   * `link` step. Sweeping them on construction keeps the directory

   * readable without any risk of deleting a committed schedule.

   *

   * Two files are never swept, and the reasons are the whole reason

   * this is not a one-liner:

   *

   *   a temp file belonging to THIS process   it may be an in-flight

   *                                           write of our own

   *   a temp file younger than `staleTempMs`  it may be an in-flight

   *                                           write of another

   *                                           process sharing the dir

   *

   * Phase 33 swept unconditionally, which deleted a concurrent

   * writer's temp file and made its `link(2)` fail with ENOENT. The

   * bug was only reachable with two OS processes, so no single-process

   * test could have found it (brief 10, 13).

   *

   * VERSION CLAIM FILES ARE NOT SWEPT, and never will be. A claim is

   * the standing proof that a number was handed out; deleting one

   * would let a later writer reuse a number a slower writer is still

   * holding, which is the collision this design exists to prevent.

   * They are directory entries to an inode that is already on disk, so

   * keeping them costs no bytes.

   */

  sweepTemp() {

    this.sweptTempFiles = sweepTemp(this.dir, {

      nowMs: Date.parse(this.clock()),

      olderThanMs: this.staleTempMs,

    });

    return this.sweptTempFiles;

  }



  /**

   * The ONLY place a schedule id becomes a path.

   *

   * Returns null for anything outside `sch-<16 hex>`. Callers treat

   * null as "not available", which is the right answer for both a

   * traversal attempt and a typo: neither is a schedule id this

   * deployment issued, and a refusal is not an error the caller

   * should have to handle differently (brief 14).

   */

  pathFor(scheduleId) {

    if (typeof scheduleId !== 'string' || !SCHEDULE_ID.test(scheduleId)) return null;

    return join(this.dir, `${scheduleId}.json`);

  }



  /**

   * The highest version ever claimed, from BOTH sources.

   *

   * The claim files are authoritative going forward and need no JSON

   * parse, so the common case is a regex over a directory listing. The

   * record scan is the fallback for schedules written before claims

   * existed -- a store upgraded in place must not hand out a version a

   * Phase 33 record already used, or the two would collide on exactly

   * the property this change is about.

   */

  highestVersion() {

    let max = 0;

    let names = [];

    try { names = readdirSync(this.dir); } catch { return 0; }

    for (const name of names) {

      const claim = VERSION_CLAIM.exec(name);

      if (claim) {

        const v = Number(claim[1]);

        if (Number.isInteger(v) && v > max) max = v;

      }

    }

    for (const record of this.list()) {

      if (Number.isInteger(record?.version) && record.version > max) max = record.version;

    }

    return max;

  }



  /**

   * Committed schedule metadata, newest first.

   *

   * This returns the RECORD HEADER only, never the 802 slots. The

   * header is a whitelist projection: `JSON.parse`d records are

   * re-projected field by field so a future field on a record cannot

   * reach a client by being added to the writer.

   *

   * A record that cannot be parsed is SKIPPED, not thrown on. One bad

   * file must not make the directory unreadable, and skipping keeps

   * the good records usable while `health()` reports the loss

   * (brief 11, 15, 26).

   */

  list() {

    let names = [];

    try { names = readdirSync(this.dir); } catch { return []; }

    const out = [];

    for (const name of names) {

      if (!name.endsWith('.json') || name.startsWith('.')) continue;

      const id = name.slice(0, -5);

      if (!SCHEDULE_ID.test(id)) continue;

      const record = this.read(id);

      if (!record) continue;

      out.push({

        scheduleId: id,

        version: record.version ?? null,

        status: record.status ?? null,

        requestId: record.requestId ?? null,

        solutionId: record.solutionId ?? null,

        committedAt: record.committedAt ?? null,

        slotCount: record.slotCount ?? null,

        contentHash: record.contentHash ?? null,

        validated: record.validated === true,

        audit: record.audit ?? null,

      });

    }

    out.sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || String(a.scheduleId).localeCompare(String(b.scheduleId)));

    return out;

  }



  /**

   * What the deployment can currently do, and what is wrong with it.

   *

   * Reported by `/health` and never by a commit: a commit that failed

   * because the directory is degraded is reported as such, and the

   * operator finds out from health rather than from a user's error

   * message.

   */

  health() {

    let names = [];

    try { names = readdirSync(this.dir); } catch { names = []; }

    const records = names.filter((n) => /^sch-[0-9a-f]{16}\.json$/.test(n));

    const readable = records.filter((n) => this.read(n.slice(0, -5)) !== null);

    const tempFiles = names.filter((n) => n.startsWith('.tmp-'));

    return {

      implemented: true,

      driver: 'file',

      atomic: true,

      location: String(this.dir),

      // Uniqueness comes from `link(2)` on a shared directory, so it

      // holds across processes rather than only within one.

      versionAllocation: 'LINK_CLAIM_CROSS_PROCESS',

      versionHighWaterMark: this.highestVersion(),

      recordCount: readable.length,

      corruptRecordCount: records.length - readable.length,

      // A temp file is never a schedule. Its presence means a write

      // was interrupted; it is swept on the next construction.

      staleTempFileCount: tempFiles.length,

      lastSweptTempFiles: this.sweptTempFiles ?? 0,

      idempotency: 'requestId+solutionId',

    };

  }



  /** The newest committed schedule header, or null. */

  latest() {

    return this.list()[0] ?? null;

  }



  /** Read one record in full, or null when it is missing or corrupt. */

  read(scheduleId) {

    const path = this.pathFor(scheduleId);

    if (!path) return null;

    let text;

    try {

      text = readFileSync(path, 'utf8');

    } catch {

      // A missing file and an unreadable one are both "not

      // available"; neither may be reported as a schedule.

      return null;

    }

    try {

      const parsed = JSON.parse(text);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

      return parsed;

    } catch {

      return null;

    }

  }



  /**

   * Atomically create a record.

   *

   *   create(scheduleId, (version) => record)

   *

   *   -> { created: true,  record }

   *    { created: false, record }   the identical record already

   *                                 existed (idempotent replay)

   *

   * `buildRecord` is a FACTORY, not a record, and that is the whole

   * of the Phase 34 version fix. The version has to be INSIDE the

   * bytes, and it is not known until the claim succeeds -- so a

   * caller that passed a finished record would have had to pick the

   * number itself, which is the bug being removed. The store picks

   * the number, claims it, and hands the builder the result.

   *

   * The caller is responsible for having validated the candidate

   * BEFORE calling this. The store does not know what a feasible

   * schedule is and must not be asked to decide.

   */

  async create(scheduleId, buildRecord) {

    const finalPath = this.pathFor(scheduleId);

    if (!finalPath) {

      throw new ScheduleStoreError('MALFORMED_SCHEDULE_ID', `Refusing to build a path for ${String(scheduleId)}.`);

    }

    if (typeof buildRecord !== 'function') {

      throw new ScheduleStoreError('MALFORMED_RECORD', 'create() requires a record factory, not a record.');

    }



    // Fast path for the retry case. This is an OPTIMIZATION: a replay

    // should not claim a version, and the overwhelming majority of

    // replays arrive with no concurrency at all. The authority is

    // still the `link` below, which resolves anything this check

    // missed.

    if (existsSync(finalPath)) {

      const existing = this.read(scheduleId);

      if (existing) return { created: false, record: existing };

      // The name exists and cannot be read. That is a corrupt store,

      // not a duplicate, and it is reported as such rather than

      // papered over by writing a second record under a name that

      // already answers to a different one.

      throw new ScheduleStoreError('RECORD_CORRUPT', `schedule ${scheduleId} exists but could not be read`);

    }



    // Bounded because each retry consumes a claim name permanently;

    // an unbounded loop against a directory full of claims would spin.

    const MAX_ATTEMPTS = 1000;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {

      const version = this.nextVersionCandidate();

      const record = buildRecord(version);

      if (!record || record.scheduleId !== scheduleId) {

        throw new ScheduleStoreError('MALFORMED_RECORD', `The record factory produced a record for a different schedule id.`);

      }

      const payload = `${JSON.stringify(record, null, 2)}\n`;



      const tmpPath = await writeTemp(this.dir, scheduleId, payload);



      // ---- the version claim ------------------------------------

      const claimPath = join(this.dir, versionClaimName(version));

      const claim = await linkExclusive(tmpPath, claimPath);

      if (!claim.linked) {

        // Another writer holds this number. Skip it and take the

        // next, and do not leave our temp file behind.

        await discardTemp(tmpPath);

        this.nextVersion = version + 1;

        continue;

      }



      // ---- the record name --------------------------------------

      const published = await linkExclusive(tmpPath, finalPath);

      if (!published.linked) {

        // The record name was taken between the fast path and here:

        // a genuine concurrent duplicate. The version we just claimed

        // is not going to be used, so release it rather than burn a

        // number on a request that produced no record.

        await unlinkSync(claimPath);

        await discardTemp(tmpPath);

        const existing = this.read(scheduleId);

        if (existing) return { created: false, record: existing };

        throw new ScheduleStoreError('RECORD_CORRUPT', `schedule ${scheduleId} exists but could not be read`);

      }



      await discardTemp(tmpPath);

      this.nextVersion = version + 1;

      // Both names now point at the same inode. The claim is kept: it

      // is the standing proof that this number was handed out.

      return { created: true, record };

    }



    throw new ScheduleStoreError('VERSION_EXHAUSTED', `Could not claim a version after ${MAX_ATTEMPTS} attempts.`);

  }



  /**

   * The version to try next, from the in-memory hint.

   *

   * The hint is an OPTIMIZATION. Correctness comes from the claim:

   * if the hint is stale because another process took the number, the

   * claim fails and `create` moves on. A hint that is too high costs

   * nothing but a gap; a hint that is too low costs one failed claim.

   */

  nextVersionCandidate() {

    return this.nextVersion;

  }



  /** Diagnostic only. A caller cannot reserve a number through this. */

  peekNextVersion() {

    return this.nextVersion;

  }



  /**

   * Serialize work per schedule id.

   *

   * Two concurrent commits of the same solution must not both build a

   * record for it. The mutex is an efficiency measure now, not a

   * correctness one -- the `link(2)` claim is what actually prevents

   * two schedules -- but it keeps the common case cheap and stops the

   * second writer from doing a full 802-row rebuild before discovering

   * there is nothing to do. Commits of DIFFERENT solutions never wait

   * on each other.

   */

  async withLock(key, fn) {

    const prior = this.locks.get(key) ?? Promise.resolve();

    let release;

    const gate = new Promise((r) => { release = r; });

    // `chain` -- not `gate` -- is what the next caller waits on, so a

    // second caller resumes only after this one calls `release()`.

    const chain = prior.then(() => gate);

    this.locks.set(key, chain);

    try {

      await prior;

      return await fn();

    } finally {

      release();

      // Drop the entry once this call is the tail, so the map does not

      // grow with the number of commits in a long-lived process.

      if (this.locks.get(key) === chain) this.locks.delete(key);

    }

  }



  /**

   * The whole record, including `schemaVersion` and `slots`.

   * Assembled by the commit service; the store only persists it.

   *

   * `version` is first in the field order so a human reading the file

   * sees the number that matters first, and so a future cheap

   * head-read of the version cannot miss it.

   */

  static buildRecord({ scheduleId, requestId, solutionId, version, rows, contentHash, audit, clockValue, validated }) {

    return {

      schemaVersion: RECORD_SCHEMA_VERSION,

      version,

      scheduleId,

      status: 'COMMITTED',

      requestId: requestId ?? null,

      solutionId: solutionId ?? null,

      validated: validated !== false,

      committedAt: clockValue,

      slotCount: rows.length,

      contentHash,

      audit,

      slots: rows,

    };

  }

}



export { isAlreadyExists, RECORD_SCHEMA_VERSION };

export default ScheduleStore;

