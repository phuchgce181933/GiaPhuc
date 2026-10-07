import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from './helpers/render.jsx';
import userEvent from '@testing-library/user-event';
import { SchedulePage } from '../../src/features/timetable/scheduling/pages/SchedulePage.jsx';
import { CommittedPanel } from '../../src/features/timetable/scheduling/components/CommittedPanel.jsx';
import { COMMIT_STATE } from '../../src/features/timetable/scheduling/useCommitState.js';
import { SOLUTIONS, OK_RESPONSE, HEALTH, COMMITTED_RESPONSE, committedList } from './fixtures/phase32-response.js';
const EM_DASH = '—';
const COMMIT_URL = /\/schedules\/commit(\?|$)/;
const COMMITTED_URL = /\/schedules\/committed(\?|$)/;
const commitFor = rank => ({
  ...COMMITTED_RESPONSE,
  solutionId: SOLUTIONS[rank].id
});
beforeEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
});
async function openSaveDialog(rank = 0) {
  await userEvent.click(screen.getAllByTestId('commit-button')[rank]);
  return screen.findByTestId('commit-dialog');
}
async function confirmAndSettle(calls) {
  const confirm = screen.getByTestId('commit-confirm');
  expect(confirm.disabled).toBe(false, 'the confirm button is enabled before it is clicked');
  await userEvent.click(confirm);
  await waitFor(() => {
    if (!calls.some(c => COMMIT_URL.test(c.url))) throw new Error('no commit request was sent');
    const settled = screen.queryByTestId('commit-result') ?? screen.queryByTestId('commit-failed') ?? screen.queryByTestId('commit-dialog-error');
    if (!settled) throw new Error('the commit has not settled yet');
  });
}
describe('the Phase 32/33 flow still works end to end', () => {
  test('Generate, select, Confirm, Commit, and the badge appears', async () => {
    const calls = mockFetch(OK_RESPONSE, {
      commit: commitFor(1)
    });
    render(<SchedulePage />);
    await generateNow();
    await userEvent.click(screen.getAllByRole('button', {
      name: 'Phương án 2'
    })[0]);
    calls.length = 0;
    const dialog = await openSaveDialog(1);
    expect(dialog).toBeTruthy();
    expect(calls.some(c => COMMIT_URL.test(c.url))).toBe(false);
    await confirmAndSettle(calls);
    expect(screen.getByTestId('commit-result').textContent).toContain('sch-0123456789abcdef');
    const badges = screen.getAllByTestId('committed-badge');
    expect(badges).toHaveLength(1);
    expect(within(screen.getAllByTestId('solution-card')[1]).getByTestId('committed-badge')).toBeTruthy();
    const commit = calls.find(c => COMMIT_URL.test(c.url));
    expect(Object.keys(JSON.parse(commit.body)).sort()).toEqual(['requestId', 'solutionId']);
  });
  test('a duplicate commit is still a success, and says no duplicate was created', async () => {
    const calls = mockFetch(OK_RESPONSE, {
      commit: {
        ...commitFor(0),
        status: 'COMMITTED_DUPLICATE',
        duplicate: true,
        version: 4
      }
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
        committedAt: '2026-10-05T02:00:00.000Z'
      })
    });
    render(<SchedulePage />);
    await waitFor(() => {
      expect(screen.getByTestId('committed-count').textContent).toContain('1');
    });
    expect(calls.some(c => COMMITTED_URL.test(c.url))).toBe(true);
    expect(screen.getByTestId('committed-row').getAttribute('data-schedule-id')).toBe('sch-0123456789abcdef');
    expect(screen.getByTestId('committed-row').textContent).toContain('802');
  });
});
describe('the Phase 34 refusals are failures, with the backend own words', () => {
  test('a 410 PREVIEW_EXPIRED is not a success', async () => {
    const calls = mockFetch(OK_RESPONSE, {
      commitError: {
        status: 410,
        body: {
          apiVersion: "timetable-v1",
          status: 'COMMIT_REJECTED',
          ok: false,
          persisted: false,
          error: {
            code: 'PREVIEW_EXPIRED',
            message: 'This generation has passed its configured lifetime and can no longer be committed. Generate again.'
          },
          preview: {
            lifecycle: 'EXPIRED',
            integrity: 'VERIFIED',
            reason: 'TTL_PASSED'
          }
        }
      }
    });
    render(<SchedulePage />);
    await generateNow();
    await openSaveDialog(0);
    await confirmAndSettle(calls);
    const failed = screen.getByTestId('commit-failed');
    expect(failed.textContent).toContain('Chưa lưu được lịch');
    expect(failed.textContent).toContain('hết thời hạn lưu');
    expect(screen.getByTestId('commit-dialog-error-codes').textContent).toContain('PREVIEW_EXPIRED');
    expect(screen.queryByTestId('commit-result')).toBeNull();
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });
  test('a 409 PREVIEW_INTEGRITY is not a success', async () => {
    const calls = mockFetch(OK_RESPONSE, {
      commitError: {
        status: 409,
        body: {
          apiVersion: "timetable-v1",
          status: 'COMMIT_REJECTED',
          ok: false,
          persisted: false,
          error: {
            code: 'PREVIEW_INTEGRITY',
            message: 'This generation failed its integrity check and cannot be committed. Nothing was saved.'
          },
          preview: {
            lifecycle: 'INVALID',
            integrity: 'FAILED',
            reason: 'INTEGRITY_MISMATCH'
          }
        }
      }
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
    const calls = mockFetch(OK_RESPONSE, {
      commit: {
        ...commitFor(0),
        committed: false,
        persisted: false
      }
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
describe('the new Phase 34 fields do not disturb the screen', () => {
  test('a generate response carrying previewPersistence renders normally', async () => {
    mockFetch({
      ...OK_RESPONSE,
      previewPersistence: {
        stored: true,
        duplicate: false,
        driver: 'file',
        reason: null
      }
    });
    render(<SchedulePage />);
    await generateNow();
    expect(screen.getAllByTestId('solution-card')).toHaveLength(3);
    expect(screen.queryByTestId('generate-error')).toBeNull();
  });
  test('a generation whose preview could NOT be stored still shows the solutions', async () => {
    mockFetch({
      ...OK_RESPONSE,
      previewPersistence: {
        stored: false,
        duplicate: false,
        driver: 'file',
        reason: 'EACCES'
      }
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
          staleTempFileCount: 0
        },
        preview: {
          driver: 'file',
          durable: true,
          crossProcess: true,
          integrity: 'VERIFIED',
          lifecycles: ['GENERATED', 'AVAILABLE', 'COMMITTED', 'EXPIRED', 'INVALID', 'MISSING'],
          ttlSeconds: null,
          expiration: 'NONE',
          limit: 6,
          stored: 0,
          available: 0
        }
      }
    });
    render(<SchedulePage />);
    await generateNow();
    expect(screen.getAllByTestId('solution-card')).toHaveLength(3);
    expect(screen.queryByTestId('generate-error')).toBeNull();
  });
});
describe('a commit sent from a second tab', () => {
  test('the request is still only two ids, and the result is the server one', async () => {
    const calls = mockFetch(OK_RESPONSE, {
      committed: committedList({
        scheduleId: 'sch-0123456789abcdef',
        version: 1,
        solutionId: 'ms-1a2b3c4d',
        slotCount: 802,
        contentHash: 'a3f1c0d9',
        committedAt: '2026-10-05T02:00:00.000Z'
      })
    });
    render(<SchedulePage />);
    await generateNow();
    await openSaveDialog(0);
    await confirmAndSettle(calls);
    const body = JSON.parse(calls.find(c => COMMIT_URL.test(c.url)).body);
    expect(Object.keys(body).sort()).toEqual(['requestId', 'solutionId']);
    for (const forbidden of ['candidate', 'placements', 'slots', 'teacherId', 'preview', 'previewPersistence']) {
      expect(body[forbidden]).toBeUndefined();
    }
    expect(screen.getByTestId('commit-result').textContent).toContain('sch-0123456789abcdef');
  });
});
describe('the commit state machine still has exactly five states', () => {
  test('the vocabulary is unchanged', () => {
    expect(Object.values(COMMIT_STATE).sort()).toEqual(['COMMITTED', 'COMMITTING', 'CONFIRMING', 'FAILED', 'IDLE']);
  });
  test('the committed panel renders a record with a null version as a dash', () => {
    render(<CommittedPanel schedules={[{
      scheduleId: 'sch-abc123',
      version: null,
      solutionId: null,
      slotCount: null,
      contentHash: null,
      committedAt: null
    }]} onRefresh={() => {}} />);
    const cells = within(screen.getByTestId('committed-row')).getAllByRole('cell').slice(0, -1);
    for (const cell of cells) expect(cell.textContent).toBe(EM_DASH);
  });
});
function mockFetch(generate, options = {}) {
  const calls = [];
  let generates = 0;
  globalThis.fetch = vi.fn(async (url, init) => {
    const path = String(url);
    calls.push({
      url: path,
      method: init?.method ?? 'GET',
      body: init?.body
    });
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
    return jsonResponse(404, {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Unknown API endpoint.'
      }
    });
  });
  return calls;
}
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}
async function generateNow() {
  const button = await screen.findByTestId('generate-button');
  await userEvent.click(button);
  await waitFor(() => {
    const settled = screen.queryByTestId('solution-list') ?? screen.queryByTestId('empty-state') ?? screen.queryByTestId('generate-error');
    if (!settled) throw new Error('the page has not settled yet');
  });
}
