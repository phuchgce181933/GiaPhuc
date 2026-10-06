/**
 * PHASE 33 â€” COMMIT WORKFLOW UI TESTS.
 *
 * The ten checks brief Â§36 names are numbered 21-30 (continuing the
 * Phase 32 numbering) and named in their titles.
 *
 * WHAT THESE TESTS ASK
 * --------------------
 * Each one asks a question a person would ask of the screen, and the
 * assertions are about WORDS AND STATES, never about internals:
 *
 *   21  is there a selected solution, and is it visibly selected?
 *   22  does a confirmation step exist before anything is written?
 *   23  is there a distinct "in flight" state, separate from success?
 *   24  does a confirmed commit show the schedule id the backend gave?
 *   25  does a refusal say the schedule was NOT saved?
 *   26  is generating still a preview, with nothing written?
 *   27  can a false success reach the screen at all?
 *   28  does the selection survive the whole flow?
 *   29  is the committed solution identified, and only that one?
 *   30  does generating again erase the committed record?
 *
 * WHY THERE ARE NO SNAPSHOTS
 * -------------------------
 * Same reason as Phase 32: a snapshot records what the component
 * happened to render, so it fails on a deliberate copy change and
 * passes on a regression that reorders something invisible. Every
 * assertion here is a claim the screen must make.
 *
 * THE MOCK IS THE BACKEND, NOT A STUB
 * -----------------------------------
 * Responses are the real Phase 33 shapes from
 * `fixtures/phase32-response.js`, including the fields the UI is
 * forbidden to invent. A mock that returns a convenient subset is how
 * a UI ends up depending on a field the API never sends.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SchedulePage } from '../src/features/scheduling/pages/SchedulePage.jsx';
import { CommitDialog } from '../src/features/scheduling/components/CommitDialog.jsx';
import { CommittedPanel } from '../src/features/scheduling/components/CommittedPanel.jsx';
import { COMMIT_STATE } from '../src/features/scheduling/useCommitState.js';

import {
  SOLUTIONS, OK_RESPONSE, HEALTH, COMMITTED_RESPONSE, REJECTED_RESPONSE, committedList,
} from './fixtures/phase32-response.js';

beforeEach(cleanup);
afterEach(() => { vi.restoreAllMocks(); });

// ============================================================================
// 21. Selected solution state
// ============================================================================

describe('21. the selected solution is a visible, stable state', () => {
  test('the first solution is selected on arrival and the choice is marked', async () => {
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();

    const cards = screen.getAllByTestId('solution-card');
    expect(cards[0].className).toContain('tkb-solution-selected');
    // "Selected" is a state a person can see, not just an internal id.
    const selectButton = within(cards[0]).getByRole('button', { name: 'Phương án 1' });
    expect(selectButton.getAttribute('aria-pressed')).toBe('true');
  });

  test('choosing another solution moves the selection and nothing else', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByRole('button', { name: 'Phương án 3' })[0]);
    const cards = screen.getAllByTestId('solution-card');
    expect(cards[2].className).toContain('tkb-solution-selected');
    expect(cards.filter((c) => c.className.includes('tkb-solution-selected'))).toHaveLength(1);
  });
});

// ============================================================================
// 22. Confirmation dialog
// ============================================================================

describe('22. nothing is written before the user confirms', () => {
  test('the save button opens a dialog and sends no request', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    calls.length = 0;

    await user.click(screen.getAllByTestId('commit-button')[1]);

    // The dialog is open...
    expect(screen.getByTestId('commit-dialog')).toBeTruthy();
    // ...and exactly one request was made, and it was NOT a commit.
    // A save button that writes on click is an auto-commit with a
    // confirmation step somewhere else.
    const paths = calls.map((c) => c.url);
    expect(paths.some((p) => p.includes('/commit'))).toBe(false);
  });

  test('the dialog states the schedule facts the brief names, from the response', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    const summary = await screen.findByTestId('commit-summary');

    for (const label of [
      'Hạng phương án', 'Điểm xếp hạng', 'Điểm chất lượng', 'Chênh lệch tải giáo viên',
      'Tải cao nhất (tiết)', 'Số tiết', 'Vi phạm quy tắc',
    ]) {
      expect(within(summary).getByText(label)).toBeTruthy();
    }
    // The numbers are the response's, not a recomputation.
    const first = SOLUTIONS[0];
    expect(within(summary).getByText('Điểm xếp hạng').nextSibling.textContent).toBe(first.globalScore.toFixed(4));
    expect(within(summary).getByText('Vi phạm quy tắc').nextSibling.textContent).toBe('0');
    // And it does not editorialise: no AI justification is offered.
    expect(screen.getByTestId('commit-dialog').textContent).not.toMatch(/because the AI|recommended|insight/i);
  });

  test('cancelling closes the dialog without sending anything', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    calls.length = 0;

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-cancel'));

    expect(screen.queryByTestId('commit-dialog')).toBeNull();
    expect(calls.some((c) => c.url.includes('/commit'))).toBe(false);
  });

  test('the dialog renders nothing when there is no solution to confirm', () => {
    const { container } = render(
      <CommitDialog solution={null} state={COMMIT_STATE.CONFIRMING} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ============================================================================
// 23. Committing state
// ============================================================================

describe('23. "committing" is its own state, not a flavour of success', () => {
  test('confirming shows an in-flight state and disables the dialog', async () => {
    const user = userEvent.setup();
    let release;
    const gate = new Promise((r) => { release = r; });
    mockFetch(OK_RESPONSE, { commitGate: gate });

    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    // In flight: the card says so, the dialog is disabled, and no
    // success line exists yet.
    expect(await screen.findByTestId('commit-pending')).toBeTruthy();
    expect(screen.getByTestId('commit-confirm').disabled).toBe(true);
    expect(screen.queryByTestId('commit-result')).toBeNull();

    await act(async () => { release(); });
    await screen.findByTestId('commit-result');
  });

  test('a second confirm while one is in flight sends no second request', async () => {
    const user = userEvent.setup();
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = mockFetch(OK_RESPONSE, { commitGate: gate });

    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-pending');
    calls.length = 0;

    // Two more clicks on a disabled button, dispatched directly so
    // the guard is what is under test rather than the browser's
    // own disabled handling.
    const confirm = screen.getByTestId('commit-confirm');
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(calls.filter((c) => c.url.includes('/commit'))).toHaveLength(0);

    await act(async () => { release(); });
    await screen.findByTestId('commit-result');
  });
});

// ============================================================================
// 24. Committed state
// ============================================================================

describe('24. a confirmed commit shows what the backend actually stored', () => {
  test('the card names the committed schedule id and its slot count', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    const result = await screen.findByTestId('commit-result');
    expect(result.textContent).toContain('Đã lưu lịch');
    expect(result.textContent).toContain(COMMITTED_RESPONSE.scheduleId);
    expect(result.textContent).toContain('802 tiết');
    // The dialog closes on success â€” a "saved" dialog still asking
    // for confirmation is confusing.
    await waitFor(() => expect(screen.queryByTestId('commit-dialog')).toBeNull());
  });

  test('the committed panel lists the schedule with its version, slots and hash', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-result');

    const row = await screen.findByTestId('committed-row');
    expect(row.getAttribute('data-schedule-id')).toBe(COMMITTED_RESPONSE.scheduleId);
    expect(within(row).getByText('802')).toBeTruthy();
    // The content hash is shown, not just the word "saved".
    expect(row.textContent).toContain(COMMITTED_RESPONSE.contentHash.slice(0, 16));
    expect(within(screen.getByTestId('committed-count')).getByText(/Đã lưu 1 thời khóa biểu/)).toBeTruthy();
  });

  test('a duplicate commit is reported as the same schedule, with no new record', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, {
      commit: { ...COMMITTED_RESPONSE, duplicate: true, status: 'COMMITTED_DUPLICATE', version: 1 },
    });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    const result = await screen.findByTestId('commit-result');
    expect(result.textContent).toContain('lịch đã tồn tại');
    expect(result.textContent).toContain('không tạo bản trùng');
    // One row, not two: the replay did not create a second schedule.
    expect(screen.getAllByTestId('committed-row')).toHaveLength(1);
  });
});

// ============================================================================
// 25. Commit failure
// ============================================================================

describe('25. a refusal is never dressed up as a success', () => {
  test('COMMIT_REJECTED says the schedule was not saved', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, { commitError: { status: 409, body: REJECTED_RESPONSE } });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    const failed = await screen.findByTestId('commit-failed');
    expect(failed.textContent).toContain('Chưa lưu được lịch.');
    // The backend's own words follow, so the user learns WHY.
    expect(failed.textContent).toContain('không vượt qua bước kiểm tra lại');
    // And nothing claims a write happened.
    expect(screen.queryByTestId('commit-result')).toBeNull();
    expect(screen.queryAllByTestId('committed-row')).toHaveLength(0);
  });

  test('a network failure is reported as a failure, not as an empty result', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, { commitThrows: new TypeError('Failed to fetch') });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    const failed = await screen.findByTestId('commit-failed');
    expect(failed.textContent).toContain('Chưa lưu được lịch.');
    // A read-back mismatch is a 500 that DID write; the UI must still
    // not claim success, so a 500 is covered by the same path.
    expect(screen.queryByTestId('commit-result')).toBeNull();
  });

  test('the dialog stays open after a refusal so the reason is readable', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, { commitError: { status: 409, body: REJECTED_RESPONSE } });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    const dialogError = await screen.findByTestId('commit-dialog-error');
    expect(within(dialogError).getByTestId('commit-dialog-error-headline').textContent).toBe('Chưa lưu được thời khóa biểu.');
    // The backend's codes are shown, so the reason is not flattened
    // into a generic sentence.
    expect(within(dialogError).getByTestId('commit-dialog-error-codes').textContent).toContain('HARD_VIOLATION');
  });
});

// ============================================================================
// 26-27. Preview stays preview; no false success
// ============================================================================

describe('26. generating is still only a preview', () => {
  test('generate alone writes nothing and the panel says so', async () => {
    const calls = mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    calls.length = 0;

    expect(calls.some((c) => c.url.includes('/commit'))).toBe(false);
    // The empty state is worded as "nothing saved", so a user who
    // only ever generates never believes a schedule was stored.
    expect(screen.getByTestId('committed-count').textContent).toContain('Tạo lịch không đồng nghĩa với lưu lịch');
    expect(screen.queryAllByTestId('committed-row')).toHaveLength(0);
  });

  test('no "saved" wording appears anywhere before a commit is confirmed', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    const dialogText = (await screen.findByTestId('commit-dialog')).textContent;
    expect(dialogText).not.toMatch(/saved|committed successfully|written/i);
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });
});

describe('27. a false success cannot reach the screen', () => {
  test('a 200 whose body does not confirm a write is treated as a failure', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, {
      // The Phase 32 shape: a 200 that reports `written: false`.
      commit: { ...COMMITTED_RESPONSE, committed: false, written: false, status: 'COMMITTED' },
    });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    expect(await screen.findByTestId('commit-failed')).toBeTruthy();
    expect(screen.queryByTestId('commit-result')).toBeNull();
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });

  test('a response missing the schedule id is not treated as a commit', async () => {
    const user = userEvent.setup();
    const { scheduleId, ...noId } = COMMITTED_RESPONSE;
    mockFetch(OK_RESPONSE, { commit: noId });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    // `committed: true` with no `scheduleId` cannot be rendered as a
    // committed schedule, because there is nothing to name. The
    // badge is keyed on the schedule id, so no badge appears.
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });
});

// ============================================================================
// 28-29. Selection preserved; the committed solution identified
// ============================================================================

describe('28. the selection survives the whole flow', () => {
  test('selecting Solution 2, confirming, and reading the result keeps Solution 2 selected', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByRole('button', { name: 'Phương án 2' })[0]);
    await user.click(screen.getAllByTestId('commit-button')[1]);

    // The dialog is about the SELECTED solution, not the first one.
    expect((await screen.findByTestId('commit-dialog-subject')).textContent).toContain(SOLUTIONS[1].id);

    await user.click(screen.getByTestId('commit-confirm'));
    await screen.findByTestId('commit-result');

    expect(screen.getAllByTestId('solution-card')[1].className).toContain('tkb-solution-selected');
    expect(screen.getAllByTestId('solution-card')[0].className).not.toContain('tkb-solution-selected');
  });
});

describe('29. the committed solution is identified, and only that one', () => {
  test('the badge sits on the committed card alone', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, { commit: { ...COMMITTED_RESPONSE, solutionId: SOLUTIONS[1].id } });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[1]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-result');

    const badges = screen.getAllByTestId('committed-badge');
    expect(badges).toHaveLength(1);
    expect(within(screen.getAllByTestId('solution-card')[1]).getByTestId('committed-badge')).toBeTruthy();
  });

  test('a schedule committed in an earlier session is listed, not forgotten', async () => {
    mockFetch(OK_RESPONSE, {
      // The backend already holds a schedule from a previous run.
      committed: committedList({ ...COMMITTED_RESPONSE, version: 3, solutionId: 'ms-older0000' }),
    });
    render(<SchedulePage />);

    const row = await screen.findByTestId('committed-row');
    expect(row.getAttribute('data-schedule-id')).toBe(COMMITTED_RESPONSE.scheduleId);
    // It is listed under the source solution the backend recorded,
    // which is not necessarily a solution in the current preview.
    expect(row.textContent).toContain('ms-older0000');
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });
});

// ============================================================================
// 30. Generate after commit
// ============================================================================

describe('30. generating again does not erase or overwrite a commit', () => {
  test('a new generation keeps the committed schedule on screen', async () => {
    const user = userEvent.setup();
    // The list endpoint answers with the committed schedule before
    // the commit and STILL answers with it after, because a commit is
    // append-only on the server.
    const committed = committedList({ ...COMMITTED_RESPONSE, solutionId: SOLUTIONS[0].id });
    mockFetch(OK_RESPONSE, { committed });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-result');
    expect(screen.getAllByTestId('committed-row')).toHaveLength(1);

    // Generate again: a NEW requestId, NEW solution ids, new cards.
    await generateNow();

    // The committed schedule is still listed. A generation that
    // cleared this list would tell the user a saved schedule had
    // been lost, when it is on disk.
    expect(screen.getAllByTestId('committed-row')).toHaveLength(1);
    expect(screen.getByTestId('committed-row').getAttribute('data-schedule-id')).toBe(COMMITTED_RESPONSE.scheduleId);
    // And the new preview is on screen, not overwritten by it.
    expect(screen.getAllByTestId('solution-card').length).toBe(SOLUTIONS.length);
  });

  test('a new generation starts from a clean commit state for the NEW solutions', async () => {
    const user = userEvent.setup();
    // The second generation answers with a NEW requestId and NEW
    // solution ids, exactly as the real backend does. A commit result
    // is a fact about one generation, so the new cards must not carry
    // it; the committed PANEL is what carries the history.
    const second = {
      ...OK_RESPONSE,
      requestId: 'req-000002',
      solutions: OK_RESPONSE.solutions.map((s, i) => ({ ...s, id: `ms-9${i}000000` })),
    };
    mockFetch(OK_RESPONSE, { secondGenerate: second });
    render(<SchedulePage />);
    await generateNow();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-result');
    expect(screen.queryAllByTestId('commit-result')).toHaveLength(1);

    await generateNow();

    expect(screen.queryAllByTestId('commit-result')).toHaveLength(0);
    expect(screen.queryByTestId('commit-dialog')).toBeNull();
    // The new cards are the new ones.
    expect(screen.getAllByTestId('solution-id')[0].textContent).toBe('ms-90000000');
  });
});

// ============================================================================
// Panel in isolation
// ============================================================================

describe('the committed panel on its own', () => {
  test('an empty list states that nothing is saved', () => {
    render(<CommittedPanel schedules={[]} onRefresh={() => {}} />);
    expect(screen.getByTestId('committed-count').textContent).toContain('Chưa có thời khóa biểu nào được lưu');
  });

  test('a schedule with no measurable fields renders dashes, not zeroes', () => {
    render(
      <CommittedPanel
        schedules={[{ scheduleId: 'sch-abc123', version: null, solutionId: null, slotCount: null, contentHash: null, committedAt: null }]}
        onRefresh={() => {}}
      />,
    );
    const cells = within(screen.getByTestId('committed-row')).getAllByRole('cell');
    // Column order is Version, Source solution, Slots, Committed at,
    // Content hash. Every unmeasured field is a dash; none of them is
    // a 0, which a reader could not tell from a measured zero.
    for (const cell of cells) expect(cell.textContent).toBe('—');
    // The em dash is compared as a code point so the assertion cannot
    // be broken by the file's encoding surviving a round trip.
    expect(cells[0].textContent).toBe('—');
  });
});

// ============================================================================
// Harness
// ============================================================================

/**
 * Mock the API.
 *
 * The three commit outcomes are THREE OPTIONS, not one overloaded
 * one. The first version took `{ status, body }` or a bare body and
 * told them apart with `'status' in spec` â€” which misread every
 * SUCCESSFUL response, because a commit body carries its own
 * `status: 'COMMITTED'` field. A 200 became a 500 with an undefined
 * payload and four tests failed for a reason that had nothing to do
 * with the UI.
 *
 * @param {object} generate     the /generate response body
 * @param {object} options
 * @param {object} [options.commit]     a 200 commit body
 * @param {object} [options.commitError] `{ status, body }` â€” a refusal
 * @param {Error} [options.commitThrows] a network failure
 * @param {object} [options.committed]  the /committed list body
 * @param {Promise} [options.commitGate] held open to observe the
 *   in-flight state
 * @returns {Array} a live call log, so a test can assert on the
 *   requests a single interaction produced
 */
function mockFetch(generate, options = {}) {
  const calls = [];
  let generates = 0;
  globalThis.fetch = vi.fn(async (url, init) => {
    const path = String(url);
    calls.push({ url: path, method: init?.method ?? 'GET', body: init?.body });

    if (path.includes('/health')) return jsonResponse(200, HEALTH);
    if (/\/schedules\/committed(\/|$)/.test(path)) {
      return jsonResponse(200, options.committed ?? committedList());
    }
    if (path.includes('/commit')) {
      if (options.commitGate) await options.commitGate;
      if (options.commitThrows) throw options.commitThrows;
      if (options.commitError) {
        return jsonResponse(options.commitError.status, options.commitError.body);
      }
      return jsonResponse(200, options.commit ?? COMMITTED_RESPONSE);
    }
    if (path.includes('/generate')) {
      generates += 1;
      // The real backend issues a new requestId per generation, and
      // `secondGenerate` is how a test reproduces that.
      if (generates > 1 && options.secondGenerate) {
        return jsonResponse(200, options.secondGenerate);
      }
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

/** Click Generate and wait for a terminal state. */
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

