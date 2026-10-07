import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor, act } from './helpers/render.jsx';
import userEvent from '@testing-library/user-event';
import { SchedulePage } from '../../src/features/timetable/scheduling/pages/SchedulePage.jsx';
import { CommitDialog } from '../../src/features/timetable/scheduling/components/CommitDialog.jsx';
import { CommittedPanel } from '../../src/features/timetable/scheduling/components/CommittedPanel.jsx';
import { COMMIT_STATE } from '../../src/features/timetable/scheduling/useCommitState.js';
import { SOLUTIONS, OK_RESPONSE, HEALTH, COMMITTED_RESPONSE, REJECTED_RESPONSE, committedList } from './fixtures/phase32-response.js';
beforeEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
});
describe('21. the selected solution is a visible, stable state', () => {
  test('the first solution is selected on arrival and the choice is marked', async () => {
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    const cards = screen.getAllByTestId('solution-card');
    expect(cards[0].className).toContain('tkb-solution-selected');
    const selectButton = within(cards[0]).getByRole('button', {
      name: 'Phương án 1'
    });
    expect(selectButton.getAttribute('aria-pressed')).toBe('true');
  });
  test('choosing another solution moves the selection and nothing else', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByRole('button', {
      name: 'Phương án 3'
    })[0]);
    const cards = screen.getAllByTestId('solution-card');
    expect(cards[2].className).toContain('tkb-solution-selected');
    expect(cards.filter(c => c.className.includes('tkb-solution-selected'))).toHaveLength(1);
  });
});
describe('22. nothing is written before the user confirms', () => {
  test('the save button opens a dialog and sends no request', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    calls.length = 0;
    await user.click(screen.getAllByTestId('commit-button')[1]);
    expect(screen.getByTestId('commit-dialog')).toBeTruthy();
    const paths = calls.map(c => c.url);
    expect(paths.some(p => p.includes('/commit'))).toBe(false);
  });
  test('the dialog states the schedule facts the brief names, from the response', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    const summary = await screen.findByTestId('commit-summary');
    for (const label of ['Hạng phương án', 'Điểm xếp hạng', 'Điểm chất lượng', 'Chênh lệch tải giáo viên', 'Tải cao nhất (tiết)', 'Số tiết', 'Vi phạm quy tắc']) {
      expect(within(summary).getByText(label)).toBeTruthy();
    }
    const first = SOLUTIONS[0];
    expect(within(summary).getByText('Điểm xếp hạng').nextSibling.textContent).toBe(first.globalScore.toFixed(4));
    expect(within(summary).getByText('Vi phạm quy tắc').nextSibling.textContent).toBe('0');
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
    expect(calls.some(c => c.url.includes('/commit'))).toBe(false);
  });
  test('the dialog renders nothing when there is no solution to confirm', () => {
    const {
      container
    } = render(<CommitDialog solution={null} state={COMMIT_STATE.CONFIRMING} onConfirm={() => {}} onCancel={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
describe('23. "committing" is its own state, not a flavour of success', () => {
  test('confirming shows an in-flight state and disables the dialog', async () => {
    const user = userEvent.setup();
    let release;
    const gate = new Promise(r => {
      release = r;
    });
    mockFetch(OK_RESPONSE, {
      commitGate: gate
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    expect(await screen.findByTestId('commit-pending')).toBeTruthy();
    expect(screen.getByTestId('commit-confirm').disabled).toBe(true);
    expect(screen.queryByTestId('commit-result')).toBeNull();
    await act(async () => {
      release();
    });
    await screen.findByTestId('commit-result');
  });
  test('a second confirm while one is in flight sends no second request', async () => {
    const user = userEvent.setup();
    let release;
    const gate = new Promise(r => {
      release = r;
    });
    const calls = mockFetch(OK_RESPONSE, {
      commitGate: gate
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-pending');
    calls.length = 0;
    const confirm = screen.getByTestId('commit-confirm');
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', {
        bubbles: true
      }));
      confirm.dispatchEvent(new MouseEvent('click', {
        bubbles: true
      }));
    });
    expect(calls.filter(c => c.url.includes('/commit'))).toHaveLength(0);
    await act(async () => {
      release();
    });
    await screen.findByTestId('commit-result');
  });
});
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
    expect(row.textContent).toContain(COMMITTED_RESPONSE.contentHash.slice(0, 16));
    expect(within(screen.getByTestId('committed-count')).getByText(/Đã lưu 1 thời khóa biểu/)).toBeTruthy();
  });
  test('a duplicate commit is reported as the same schedule, with no new record', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, {
      commit: {
        ...COMMITTED_RESPONSE,
        duplicate: true,
        status: 'COMMITTED_DUPLICATE',
        version: 1
      }
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    const result = await screen.findByTestId('commit-result');
    expect(result.textContent).toContain('lịch đã tồn tại');
    expect(result.textContent).toContain('không tạo bản trùng');
    expect(screen.getAllByTestId('committed-row')).toHaveLength(1);
  });
});
describe('25. a refusal is never dressed up as a success', () => {
  test('COMMIT_REJECTED says the schedule was not saved', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, {
      commitError: {
        status: 409,
        body: REJECTED_RESPONSE
      }
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    const failed = await screen.findByTestId('commit-failed');
    expect(failed.textContent).toContain('Chưa lưu được lịch.');
    expect(failed.textContent).toContain('không vượt qua bước kiểm tra lại');
    expect(screen.queryByTestId('commit-result')).toBeNull();
    expect(screen.queryAllByTestId('committed-row')).toHaveLength(0);
  });
  test('a network failure is reported as a failure, not as an empty result', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, {
      commitThrows: new TypeError('Failed to fetch')
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    const failed = await screen.findByTestId('commit-failed');
    expect(failed.textContent).toContain('Chưa lưu được lịch.');
    expect(screen.queryByTestId('commit-result')).toBeNull();
  });
  test('the dialog stays open after a refusal so the reason is readable', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE, {
      commitError: {
        status: 409,
        body: REJECTED_RESPONSE
      }
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    const dialogError = await screen.findByTestId('commit-dialog-error');
    expect(within(dialogError).getByTestId('commit-dialog-error-headline').textContent).toBe('Chưa lưu được thời khóa biểu.');
    expect(within(dialogError).getByTestId('commit-dialog-error-codes').textContent).toContain('HARD_VIOLATION');
  });
});
describe('26. generating is still only a preview', () => {
  test('generate alone writes nothing and the panel says so', async () => {
    const calls = mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    calls.length = 0;
    expect(calls.some(c => c.url.includes('/commit'))).toBe(false);
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
      commit: {
        ...COMMITTED_RESPONSE,
        committed: false,
        written: false,
        status: 'COMMITTED'
      }
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
    const {
      scheduleId,
      ...noId
    } = COMMITTED_RESPONSE;
    mockFetch(OK_RESPONSE, {
      commit: noId
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });
});
describe('28. the selection survives the whole flow', () => {
  test('selecting Solution 2, confirming, and reading the result keeps Solution 2 selected', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByRole('button', {
      name: 'Phương án 2'
    })[0]);
    await user.click(screen.getAllByTestId('commit-button')[1]);
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
    mockFetch(OK_RESPONSE, {
      commit: {
        ...COMMITTED_RESPONSE,
        solutionId: SOLUTIONS[1].id
      }
    });
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
      committed: committedList({
        ...COMMITTED_RESPONSE,
        version: 3,
        solutionId: 'ms-older0000'
      })
    });
    render(<SchedulePage />);
    const row = await screen.findByTestId('committed-row');
    expect(row.getAttribute('data-schedule-id')).toBe(COMMITTED_RESPONSE.scheduleId);
    expect(row.textContent).toContain('ms-older0000');
    expect(screen.queryAllByTestId('committed-badge')).toHaveLength(0);
  });
});
describe('30. generating again does not erase or overwrite a commit', () => {
  test('a new generation keeps the committed schedule on screen', async () => {
    const user = userEvent.setup();
    const committed = committedList({
      ...COMMITTED_RESPONSE,
      solutionId: SOLUTIONS[0].id
    });
    mockFetch(OK_RESPONSE, {
      committed
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-result');
    expect(screen.getAllByTestId('committed-row')).toHaveLength(1);
    await generateNow();
    expect(screen.getAllByTestId('committed-row')).toHaveLength(1);
    expect(screen.getByTestId('committed-row').getAttribute('data-schedule-id')).toBe(COMMITTED_RESPONSE.scheduleId);
    expect(screen.getAllByTestId('solution-card').length).toBe(SOLUTIONS.length);
  });
  test('a new generation starts from a clean commit state for the NEW solutions', async () => {
    const user = userEvent.setup();
    const second = {
      ...OK_RESPONSE,
      requestId: 'req-000002',
      solutions: OK_RESPONSE.solutions.map((s, i) => ({
        ...s,
        id: `ms-9${i}000000`
      }))
    };
    mockFetch(OK_RESPONSE, {
      secondGenerate: second
    });
    render(<SchedulePage />);
    await generateNow();
    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-result');
    expect(screen.queryAllByTestId('commit-result')).toHaveLength(1);
    await generateNow();
    expect(screen.queryAllByTestId('commit-result')).toHaveLength(0);
    expect(screen.queryByTestId('commit-dialog')).toBeNull();
    expect(screen.getAllByTestId('solution-id')[0].textContent).toBe('ms-90000000');
  });
});
describe('the committed panel on its own', () => {
  test('an empty list states that nothing is saved', () => {
    render(<CommittedPanel schedules={[]} onRefresh={() => {}} />);
    expect(screen.getByTestId('committed-count').textContent).toContain('Chưa có thời khóa biểu nào được lưu');
  });
  test('a schedule with no measurable fields renders dashes, not zeroes', () => {
    render(<CommittedPanel schedules={[{
      scheduleId: 'sch-abc123',
      version: null,
      solutionId: null,
      slotCount: null,
      contentHash: null,
      committedAt: null
    }]} onRefresh={() => {}} />);
    const cells = within(screen.getByTestId('committed-row')).getAllByRole('cell').slice(0, -1);
    for (const cell of cells) expect(cell.textContent).toBe('—');
    expect(cells[0].textContent).toBe('—');
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
      if (generates > 1 && options.secondGenerate) {
        return jsonResponse(200, options.secondGenerate);
      }
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
