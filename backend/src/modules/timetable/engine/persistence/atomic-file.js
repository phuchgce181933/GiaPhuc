// PHASE 34 -- ATOMIC FILE PRIMITIVE.
//
// WHY THIS IS ITS OWN MODULE
// --------------------------
// Phase 33 implemented write-temp -> fsync -> link(2) inside
// `schedule-store.js`, because there was exactly one caller. Phase 34
// adds a second store (previews) that needs the same guarantee, and
// copying the sequence would mean two places to keep correct -- which
// is precisely the failure mode the "code has one clear location" rule
// exists to prevent. So the sequence lives here, once, and both
// stores call it.
//
// It lives under `src/persistence/` rather than `src/shared/` because
// no module outside persistence has a reason to want an atomic file
// create. `src/shared/` is for code reused across features; this is
// reused across two files inside one feature, which is a different
// thing.
//
// THE SEQUENCE, AND WHAT EACH STEP BUYS
// -------------------------------------
//   1. write the WHOLE payload to a uniquely named temp file in the
//      SAME directory
//        Same directory is not tidiness -- it is what makes step 3 a
//        link (a directory-entry operation) instead of a copy across
//        a filesystem boundary, and a copy is not atomic.
//   2. fsync the file, then close
//        Without the flush, `link` can return success for a file whose
//        bytes are still only in the page cache, and a crash would
//        leave a name pointing at nothing useful.
//   3. `link(tmp, target)`
//        POSIX create-if-absent: it fails with EEXIST if `target`
//        exists, and otherwise makes `target` appear atomically and
//        completely. There is no instant at which a reader can see
//        `target` with partial contents, and no instant at which
//        `target` exists as a name for a file that was never
//        finished.
//   4. unlink(tmp)
//        Cleanup only. By here the record is already visible under
//        its real name and is already durable; a crash before this
//        leaves a stray temp file, which `sweepTemp` removes, and
//        never a partial record under a real id.
//
// A caller that loses step 3 to EEXIST must treat the existing target
// as the authority. That is not an error case -- it is exactly how
// idempotency is implemented, because two identical requests address
// the same name by construction.

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { open, link, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Every temp file this module creates starts with this. */
export const TEMP_PREFIX = '.tmp-';

/**
 * How old a temp file must be before a store is allowed to remove it.
 *
 * This exists because of a bug Phase 34's cross-process test found.
 * Phase 33 swept temp files on every store construction, on the
 * reasoning that a temp file is by definition abandoned. That is true
 * within one process and FALSE between two: process B, halfway through
 * writing 802 slots, has a temp file that looks exactly like the
 * leftovers process A wants to clean up, and A deletes it out from
 * under B's `link(2)`. The result was
 * `ENOENT: link '.tmp-...' -> '.version-000000000001'` in a worker
 * that had done nothing wrong.
 *
 * So sweeping is now restricted twice over: a file belonging to THIS
 * process is never swept (it may be an in-flight write of our own),
 * and a file younger than this threshold is never swept (it may be an
 * in-flight write of someone else's). Only a file that is both
 * demonstrably not ours and demonstrably old is garbage.
 *
 * The threshold is far larger than the operation it guards -- writing
 * and linking a record takes milliseconds -- so the margin is orders
 * of magnitude, not a tuned value. It is configurable for a
 * deployment that wants a longer or shorter window, and it is read
 * from an injected clock so a test can move it rather than sleep.
 */
export const DEFAULT_STALE_TEMP_MS = 300_000;

/** The pid is the FIRST segment, so the parse cannot be ambiguous. */
const TEMP_NAME = new RegExp(`^${TEMP_PREFIX}(\\d+)-`);

/** Serialized errors that mean "the name is already taken". */
export function isAlreadyExists(e) {
  // `EPERM` is what Windows can report for a hard link onto an
  // existing name, and it means the same thing here: the create-if-
  // absent did not create. Treating it as "taken" keeps a duplicate
  // commit idempotent on this platform rather than turning it into a
  // 500.
  return e?.code === 'EEXIST' || e?.code === 'EPERM';
}

/**
 * Remove leftover temp files from an INTERRUPTED write.
 *
 * Deliberately conservative -- see `DEFAULT_STALE_TEMP_MS`. A file is
 * removed only when BOTH hold:
 *
 *   it was not written by this process   (our own writes are live)
 *   it is older than `olderThanMs`       (someone else's may be too)
 *
 * `nowMs` is passed in rather than read from the process so the age
 * test is deterministic in a test. `olderThanMs: 0` disables the age
 * test entirely, which is what a caller wants when it has already
 * established that no other process is writing -- a single-process
 * test, for instance.
 */
export function sweepTemp(dir, options = {}) {
  const ownPid = options.ownPid ?? process.pid;
  const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_TEMP_MS;
  const nowMs = options.nowMs ?? Date.now();

  let removed = 0;
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    // Not one of ours, shape-wise. A file that merely starts with the
    // prefix is left alone: this store has no business deleting a name
    // it cannot attribute (brief 13).
    const match = TEMP_NAME.exec(name);
    if (!match) continue;
    if (Number(match[1]) === ownPid) continue;
    if (olderThanMs > 0) {
      let mtimeMs;
      try { mtimeMs = statSync(join(dir, name)).mtimeMs; } catch { continue; }
      if (nowMs - mtimeMs < olderThanMs) continue;
    }
    try { unlinkSync(join(dir, name)); removed += 1; } catch { /* best effort */ }
  }
  return removed;
}

/**
 * A temp path unique to this attempt AND to this process.
 *
 * The pid comes first so `sweepTemp` can attribute the file to a
 * writer without parsing the rest of the name.
 */
export function tempPathFor(dir, tag) {
  return join(dir, `${TEMP_PREFIX}${process.pid}-${tag}-${Math.random().toString(36).slice(2, 10)}`);
}

/**
 * Write `payload` to a temp file and flush it to the device.
 *
 * Returns the temp path. The caller MUST either `linkExclusive` it
 * into place or unlink it; the `try/finally` here only guarantees the
 * file handle is released, because unlinking a temp file that has been
 * linked is harmless but unlinking one that has NOT would silently
 * discard the write.
 */
export async function writeTemp(dir, tag, payload) {
  await mkdir(dir, { recursive: true });
  const tmpPath = tempPathFor(dir, tag);
  let handle = null;
  try {
    handle = await open(tmpPath, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } catch (e) {
    await handle?.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
  await handle.close();
  return tmpPath;
}

/**
 * `link(2)` as a create-if-absent.
 *
 * -> { linked: true }   the target did not exist and now does
 * -> { linked: false }  the target already existed; caller decides
 *
 * Deliberately not renamed and not overwritten: an append-only store
 * has no business replacing a name, and `link` is the OS's way of
 * saying so without this module inventing a policy.
 */
export async function linkExclusive(tmpPath, targetPath) {
  try {
    await link(tmpPath, targetPath);
    return { linked: true };
  } catch (e) {
    if (isAlreadyExists(e)) return { linked: false, error: e };
    throw e;
  }
}

/** Best-effort temp cleanup. Never throws. */
export async function discardTemp(tmpPath) {
  if (!tmpPath) return;
  await unlink(tmpPath).catch(() => {});
}
