/**
 * PHASE 34 -- PERSISTENCE HARDENING UI REGRESSION.
 *
 * The backend became durable in Phase 34: a generation is now written
 * to disk, carries an integrity hash, and a commit can be answered by
 * a process that never saw the generation. None of that may change
 * what the screen does.
 *
 * So these tests are almost entirely REGRESSION tests, and that is
 * the point. Brief 29 asks for the existing flow -- Generate, select,
 * Confirm, Commit, reload -- to keep working, and a change three
 * layers down is exactly the kind of change that silently breaks a
 * screen without breaking any test that only looks at the API. The
 * assertions here re-state the same words and states Phase 32 and 33
 * asserted, against the Phase 34 response shapes.
 *
 * WHAT IS NEW ON THE WIRE, AND WHAT THE UI MUST DO WITH IT
 * ---------------------------------------------------------
 *   generate   `previewPersistence` -- whether this generation can be
 *              committed from. The UI does not have to render it, but
 *              it must not crash on it or mistake `stored: false` for
 *              a failed generation.
 *   health     `preview.{durable,crossProcess,expiration}` -- what the
 *              deployment can do.
 *   commit     `preview.{lifecycle,integrity}` -- how the candidate
 *              was established. And two new refusals:
 *
 *   410 PREVIEW_EXPIRED     the generation aged out
 *   409 PREVIEW_INTEGRITY   the stored candidate was modified
 *
 * Both are FAILURES, and the one thing that must never happen is a
 * durable-persistence refusal rendered as a success. A 410 is a
 * brand-new status code to this UI: `ApiError` only special-cases 400,
 * so a 410 arrives as a generic error, and the test pins that it still
 * lands in the FAILED state with the backend's own words.
 *
 * NO NEW UI WAS ADDED
 * -------------------
 * Deliberately. The brief excludes a UI redesign, and a badge reading
 * "candidate integrity VERIFIED" would be a new claim on screen for a
 * fact a user cannot act on. The information is available to the
 * client; the screen does not have to perform with it.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SchedulePage } from '../src/features/scheduling/pages/SchedulePage.jsx';
import { CommittedPanel } from '../src/features/scheduling/components/CommittedPanel.jsx';
import { COMMIT_STATE } from '../src/features/scheduling/useCommitState.js';

import {
  SOLUTIONS, OK_RESPONSE, HEALTH, COMMITTED_RESPONSE, committedList,
} from './fixtures/phase32-response.js';

/** U+2014. Compared as a code point so an editor cannot break it. */
const EM_DASH = '—';

/**
 * Endpoint matchers.
 *
 * `url.includes('/commit')` is WRONG and cost a test its subject:
 * `/api/schedules/committed` contains that substring, so a matcher
 * built on `includes` finds the committed LIST fetch first, whose
 * `body` is `undefined` because it is a GET. These anchor on the end
 * of the path so a request can only match the endpoint it is.
 */
const COMMIT_URL = /\/schedules\/commit(\?|$)/;
const COMMITTED_URL = /\/schedules\/committed(\?|$)/;

/**
 * A commit response whose `solutionId` is a solution in `OK_RESPONSE`.
 *
 * The badge is keyed on `committed.some(c => c.solutionId === s.id)`,
 * so a commit fixture naming an id the preview does not contain is a
 * fixture that silently cannot produce a badge. The real backend
 * always names a solution it just generated, and so does this.
 */
const commitFor = (rank) => ({ ...COMMITTED_RESPONSE, solutionId: SOLUTIONS[rank].id });

beforeEach(cleanup);
afterEach(() => { vi.restoreAllMocks(); });

/** Open the confirmation dialog for one solution card. */
async function openSaveDialog(rank = 0) {
  await userEvent.click(screen.getAllByTestId('commit-button')[rank]);
  return screen.findByTestId('commit-dialog');
}

/** Confirm, and wait until the request has been sent AND settled. */
async function confirmAndSettle(calls) {
  const confirm = screen.getByTestId('commit-confirm');
  expect(confirm.disabled).toBe(false, 'the confirm button is enabled before it is clicked');
  await userEvent.click(confirm);
  await waitFor(() => {
    if (!calls.some((c) => COMMIT_URL.test(c.url))) throw new Error('no commit request was sent');
    const settled = screen.queryByTestId('commit-result')
      ?? screen.queryByTestId('commit-failed')
      ?? screen.queryByTestId('commit-dialog-error');
    if (!settled) throw new Error('the commit has not settled yet');
  });
}

// ============================================================================
// The full flow, unchanged
// ============================================================================

describe('the Phase 32/33 flow still works end to end', () => {
  test('Generate, select, Confirm, Commit, and the badge appears', async () => {
    const calls = mockFetch(OK_RESPONSE, { commit: commitFor(1) });
    render(<SchedulePage />);
    await generateNow();

    // The same steps, in the same order, as before Phase 34.
    await userEvent.click(screen.getAllByRole('button', { name: 'Phương án 2' })[0]);
    calls.length = 0;
    const dialog = await openSaveDialog(1);
    expect(dialog).toBeTruthy();
    // The dialog really is a step and not a label: nothing was sent.
    expect(calls.some((c) => COMMIT_URL.test(c.url))).toBe(false);

    await confirmAndSettle(calls);

    expect(screen.getByTestId('commit-result').textContent).toContain('sch-0123456789abcdef');
    const badges = screen.getAllByTestId('committed-badge');
    expect(badges).toHaveLength(1);
    expect(within(screen.getAllByTestId('solution-card')[1]).getByTestId('committed-badge')).toBeTruthy();

    // The request the UI sent is still two fields. Phase 34 made the
    // preview durable, which makes it MORE important that the client
    // still cannot post a schedule of its own.
    const commit = calls.find((c) => COMMIT_URL.test(c.url));
    expect(Object.keys(JSON.parse(commit.body)).sort()).toEqual(['requestId', 'solutionId']);
  });

  test('a duplicate commit is still a success, and says no duplicate was created', async () => {
    // The backend answers a replay with COMMITTED_DUPLICATE and
    // `duplicate: true`. It is the SAME schedule, so it must read as a
    // success -- and the user is told nothing was created twice.
    const calls = mockFetch(OK_RESPONSE, {
      commit: { ...commitFor(0), status: 'COMMITTED_DUPLICATE', duplicate: true, version: 4 },
    });
    render(<SchedulePage />);
    await generateNow();
    await openSaveDialog(0);
    await confirmAndSettle(calls);

    const result = screen.getByTestId('commit-result').textContent;
    expect(result).toContain('sch-0123456789abcdef');
    expect(result).toContain('không tạo bản trùng');
    expect(screen.queryByTestId('commit-failed')).toBeNull();
  });

  test('a reload reads the committed schedules back from the backend', async () => {
    const calls = mockFetch(OK_RESPONSE, {
      committed: committedList({
        scheduleId: 'sch-0123456789abcdef',
        version: 1,
        solutionId: 'ms-1a2b3c4d',
        slotCount: 802,
        contentHash: 'a3f1c0d9',
        committedAt: '2026-10-05T02:00:00.000Z',
      }),
    });
    render(<SchedulePage />);
    await waitFor(() => {
      expect(screen.getByTestId('committed-count').textContent).toContain('1');
    });
    // The list came from the server, not from anything rendered above.
    expect(calls.some((c) => COMMITTED_URL.test(c.url))).toBe(true);
    expect(screen.getByTestId('committed-row').getAttribute('data-schedule-id')).toBe('sch-0123456789abcdef');
    expect(screen.getByTestId('committed-row').textContent).toContain('802');
  });
});

// ============================================================================
// The new refusals must read as failures
// ============================================================================

describe('the Phase 34 refusals are failures, with the backend own words', () => {
  test('a 410 PREVIEW_EXPIRED is not a success', async () => {
    const calls = mockFetch(OK_RESPONSE, {
      commitError: {
        status: 410,
        body: {
          apiVersion: 'phase32-v1',
          status: 'COMMIT_REJECTED',
          ok: false,
          persisted: false,
          error: {
            code: 'PREVIEW_EXPIRED',
            message: 'This generation has passed its configured lifetime and can no longer be committed. Generate again.',
          },
          preview: { lifecycle: 'EXPIRED', integrity: 'VERIFIED', reason: 'TTL_PASSED' },
        },
      },
    });
    render(<SchedulePage />);
    await generateNow();
    await openSaveDialog(0);
    await confirmAndSettle(calls);

    // The refusal leads with "not saved", then quotes the backend.
    const failed = screen.getByTestId('commit-failed');
    expect(failed.textContent).toContain('Chưa lưu được lịch');
    expect(failed.textContent).toContain('hết thời hạn lưu');
    // The code is available, not flattened away.
    expect(screen.getByTestId('commit-dialog-error-codes').textContent).toContain('PREVIEW_EXPIRED');

    // And the thing that matters most: no success, and no badge.
    expect(screen.queryByTestId('commit-result')).toBeNull();
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });

  test('a 409 PREVIEW_INTEGRITY is not a success', async () => {
    const calls = mockFetch(OK_RESPONSE, {
      commitError: {
        status: 409,
        body: {
          apiVersion: 'phase32-v1',
          status: 'COMMIT_REJECTED',
          ok: false,
          persisted: false,
          error: {
            code: 'PREVIEW_INTEGRITY',
            message: 'This generation failed its integrity check and cannot be committed. Nothing was saved.',
          },
          preview: { lifecycle: 'INVALID', integrity: 'FAILED', reason: 'INTEGRITY_MISMATCH' },
        },
      },
    });
    render(<SchedulePage />);
    await generateNow();
    await openSaveDialog(0);
    await confirmAndSettle(calls);

    expect(screen.getByTestId('commit-failed').textContent).toContain('Chưa lưu được lịch');
    expect(screen.getByTestId('commit-dialog-error-codes').textContent).toContain('PREVIEW_INTEGRITY');
    expect(screen.queryByTestId('commit-result')).toBeNull();
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });

  test('a 200 that does not say committed is still not a success', async () => {
    // The durability work added a `preview` block to the success
    // payload. The guard must keep reading `committed` and nothing
    // else, or a richer response would let a non-commit through.
    const calls = mockFetch(OK_RESPONSE, {
      commit: { ...commitFor(0), committed: false, persisted: false },
    });
    render(<SchedulePage />);
    await generateNow();
    await openSaveDialog(0);
    await confirmAndSettle(calls);

    expect(screen.getByTestId('commit-failed').textContent).toContain('Máy chủ chưa xác nhận lịch đã được lưu');
    expect(screen.queryByTestId('commit-result')).toBeNull();
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });
});

// ============================================================================
// The new wire fields
// ============================================================================

describe('the new Phase 34 fields do not disturb the screen', () => {
  test('a generate response carrying previewPersistence renders normally', async () => {
    mockFetch({
      ...OK_RESPONSE,
      previewPersistence: { stored: true, duplicate: false, driver: 'file', reason: null },
    });
    render(<SchedulePage />);
    await generateNow();
    // Three solutions and no error. The new field is additive and the
    // page does not depend on it.
    expect(screen.getAllByTestId('solution-card')).toHaveLength(3);
    expect(screen.queryByTestId('generate-error')).toBeNull();
  });

  test('a generation whose preview could NOT be stored still shows the solutions', async () => {
    // The honest failure mode: the timetable is real and the user
    // should see it, but this one cannot be committed. Hiding the
    // solutions would throw away a 30-second solve; claiming success
    // would be a lie about the next click.
    mockFetch({
      ...OK_RESPONSE,
      previewPersistence: { stored: false, duplicate: false, driver: 'file', reason: 'EACCES' },
    });
    render(<SchedulePage />);
    await generateNow();
    expect(screen.getAllByTestId('solution-card')).toHaveLength(3);
    expect(screen.queryByTestId('generate-error')).toBeNull();
  });

  test('health reporting a durable preview store changes nothing on screen', async () => {
    mockFetch(OK_RESPONSE, {
      health: {
        ...HEALTH,
        commit: {
          ...HEALTH.commit,
          versionAllocation: 'LINK_CLAIM_CROSS_PROCESS',
          versionHighWaterMark: 3,
          corruptRecordCount: 0,
          staleTempFileCount: 0,
        },
        preview: {
          driver: 'file', durable: true, crossProcess: true, integrity: 'VERIFIED',
          lifecycles: ['GENERATED', 'AVAILABLE', 'COMMITTED', 'EXPIRED', 'INVALID', 'MISSING'],
          ttlSeconds: null, expiration: 'NONE', limit: 6, stored: 0, available: 0,
        },
      },
    });
    render(<SchedulePage />);
    await generateNow();
    expect(screen.getAllByTestId('solution-card')).toHaveLength(3);
    expect(screen.queryByTestId('generate-error')).toBeNull();
  });
});

// ============================================================================
// Two tabs
// ============================================================================

describe('a commit sent from a second tab', () => {
  test('the request is still only two ids, and the result is the server one', async () => {
    // Tab B never generated anything. It posts the ids it was given
    // and the backend resolves them from ITS store. The UI job is
    // unchanged and lives entirely in the request body: two strings,
    // and the response believed only when it says `committed`.
    const calls = mockFetch(OK_RESPONSE, {
      committed: committedList({
        scheduleId: 'sch-0123456789abcdef',
        version: 1,
        solutionId: 'ms-1a2b3c4d',
        slotCount: 802,
        contentHash: 'a3f1c0d9',
        committedAt: '2026-10-05T02:00:00.000Z',
      }),
    });
    render(<SchedulePage />);
    await generateNow();
    await openSaveDialog(0);
    await confirmAndSettle(calls);

    const body = JSON.parse(calls.find((c) => COMMIT_URL.test(c.url)).body);
    expect(Object.keys(body).sort()).toEqual(['requestId', 'solutionId']);
    // Nothing that could stand in for a candidate.
    for (const forbidden of ['candidate', 'placements', 'slots', 'teacherId', 'preview', 'previewPersistence']) {
      expect(body[forbidden]).toBeUndefined();
    }
    // And the schedule that comes back is the one the server named.
    expect(screen.getByTestId('commit-result').textContent).toContain('sch-0123456789abcdef');
  });
});

// ============================================================================
// The state machine itself
// ============================================================================

describe('the commit state machine still has exactly five states', () => {
  test('the vocabulary is unchanged', () => {
    expect(Object.values(COMMIT_STATE).sort()).toEqual(['COMMITTED', 'COMMITTING', 'CONFIRMING', 'FAILED', 'IDLE']);
  });

  test('the committed panel renders a record with a null version as a dash', () => {
    // Phase 34 reports `versionAllocation` and a high-water mark, but
    // the record own `version` is still nullable, and the panel must not
    // start printing "0" or "undefined" for a value it does not have.
    render(
      <CommittedPanel
        schedules={[{ scheduleId: 'sch-abc123', version: null, solutionId: null, slotCount: null, contentHash: null, committedAt: null }]}
        onRefresh={() => {}}
      />,
    );
    const cells = within(screen.getByTestId('committed-row')).getAllByRole('cell');
    for (const cell of cells) expect(cell.textContent).toBe(EM_DASH);
  });
});

// ============================================================================
// Harness
// ============================================================================

function mockFetch(generate, options = {}) {
  const calls = [];
  let generates = 0;
  globalThis.fetch = vi.fn(async (url, init) => {
    const path = String(url);
    calls.push({ url: path, method: init?.method ?? 'GET', body: init?.body });

    if (path.includes('/health')) return jsonResponse(200, options.health ?? HEALTH);
    if (/\/schedules\/committed(\/|$)/.test(path)) {
      return jsonResponse(200, options.committed ?? committedList());
    }
    if (path.includes('/commit')) {
      if (options.commitGate) await options.commitGate;
      if (options.commitThrows) throw options.commitThrows;
      if (options.commitError) return jsonResponse(options.commitError.status, options.commitError.body);
      return jsonResponse(200, options.commit ?? COMMITTED_RESPONSE);
    }
    if (path.includes('/generate')) {
      generates += 1;
      if (generates > 1 && options.secondGenerate) return jsonResponse(200, options.secondGenerate);
      return jsonResponse(200, generate);
    }
    return jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } });
  });
  return calls;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

async function generateNow() {
  const button = await screen.findByTestId('generate-button');
  await userEvent.click(button);
  await waitFor(() => {
    const settled = screen.queryByTestId('solution-list')
      ?? screen.queryByTestId('empty-state')
      ?? screen.queryByTestId('generate-error');
    if (!settled) throw new Error('the page has not settled yet');
  });
}


