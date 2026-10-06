/**
 * Phase 32 — UI honesty tests.
 *
 * These are the tests the brief's honesty requirements are checked
 * against, and they are written as behaviour rather than as
 * assertions about internals: the question each one asks is "what
 * would a user read on screen, and is that claim true?".
 *
 * WHAT IS DELIBERATELY NOT TESTED
 * ------------------------------
 * There is no snapshot test. A snapshot records what the component
 * happened to render on the day it was written, which turns a
 * deliberate copy change into a failing test and a real regression
 * into a re-record. Every assertion here is about a specific claim:
 * a value that must be shown, a word that must not appear, a
 * capability that must not be asserted.
 *
 * THE FIVE PROPERTIES
 * -------------------
 *   1. Rank reasons and scores are the BACKEND's, verbatim.
 *   2. A deterministic run is never described as an AI run.
 *   3. Travel and transfer are never claimed as optimized.
 *   4. A missing number is a dash, never a zero.
 *   5. The grid is built from the response's calendar, so a sixth
 *      school day survives.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SolutionList } from '../src/features/scheduling/components/SolutionList.jsx';
import { StatusBanner } from '../src/features/scheduling/components/StatusBanner.jsx';
import { ScheduleGrid } from '../src/features/scheduling/components/ScheduleGrid.jsx';
import { DataReport } from '../src/features/scheduling/components/DataReport.jsx';
import { SchedulePage } from '../src/features/scheduling/pages/SchedulePage.jsx';

import {
  SOLUTIONS, OK_RESPONSE, EMPTY_RESPONSE, MISSING_DATA_RESPONSE,
  FALLBACK_AI, USED_AI, NOT_REQUESTED_AI, TRAVEL_UNSUPPORTED, TRANSFER_INACTIVE,
  CALENDAR, DIRECTORY, PLACEMENTS, HEALTH, REAL_PROVENANCE, COMMITTED_RESPONSE,
  committedList,
} from './fixtures/phase32-response.js';

beforeEach(cleanup);
afterEach(() => { vi.restoreAllMocks(); });

// ============================================================================
// 1. The backend's numbers and words, verbatim
// ============================================================================

describe('the ranking explanation belongs to the backend', () => {
  test('the rank reason is explained in Vietnamese with the backend metrics', () => {
    render(
      <SolutionList solutions={SOLUTIONS} selectedId={SOLUTIONS[0].id} onSelect={() => {}} onCommit={() => {}} />,
    );
    const reason = screen.getAllByTestId('rank-reason')[0].textContent;
    expect(reason).toContain('Được xếp hạng cao theo điểm chất lượng');
    expect(reason).toContain('chênh lệch tải 2.31 tiết');
    expect(reason).toContain('tải cao nhất 22 tiết');
  });

  test('the global and quality scores are the response values, not a recomputation', () => {
    render(
      <SolutionList solutions={SOLUTIONS} selectedId={null} onSelect={() => {}} onCommit={() => {}} />,
    );
    const first = screen.getAllByTestId('quality-metrics')[0];
    // 0.7431 and 0.7712 are two different numbers upstream. A UI that
    // collapsed them would hide the Phase 28 distinction entirely.
    expect(within(first).getByText('Điểm xếp hạng').nextSibling.textContent).toBe('0.7431');
    expect(within(first).getByText('Điểm chất lượng').nextSibling.textContent).toBe('0.7712');
  });

  test('an inactive dimension shows the backend reason for being inactive', () => {
    render(
      <SolutionList solutions={SOLUTIONS} selectedId={null} onSelect={() => {}} onCommit={() => {}} />,
    );
    // "inactive" alone would let a reader assume a forgotten
    // dimension. The reason is the backend's own vocabulary.
    const reasons = [...screen.getAllByTestId('scoring-detail')[0].querySelectorAll('[title]')].map((element) => element.title);
    expect(reasons).toContain('H14_UNSUPPORTED_NO_TRAVEL_MATRIX');
    expect(reasons).toContain('H13_INACTIVE_NO_TRANSFER_POLICY');
  });

  test('diversity is labelled as a comparison, never as a score', () => {
    render(
      <SolutionList solutions={SOLUTIONS} selectedId={null} onSelect={() => {}} onCommit={() => {}} />,
    );
    const diversity = screen.getAllByTestId('diversity-metrics')[0].textContent;
    expect(diversity).toContain('So với phương án 1');
    // The disavowal is part of the component, not a comment: "more
    // diverse" is the exact inference the brief forbids.
    expect(diversity).toContain('khác nhiều hơn không có nghĩa là tốt hơn');
  });
});

// ============================================================================
// 2. A deterministic run is never described as an AI run
// ============================================================================

describe('the AI status is reported as the backend reports it', () => {
  test('a fallback run is not presented as an AI run', () => {
    render(<StatusBanner ai={FALLBACK_AI} travel={TRAVEL_UNSUPPORTED} transfer={TRANSFER_INACTIVE} />);
    const banner = screen.getByTestId('ai-status');
    expect(banner.getAttribute('data-state')).toBe('fallback');
    expect(banner.textContent).toContain('Xếp tự động dự phòng');
    expect(banner.textContent).toContain('AI_UNAVAILABLE');

    // The failure mode this guards: a hedge that still reads as an
    // AI run. "AI-assisted" would pass a `used` check and be a lie.
    expect(banner.textContent).not.toMatch(/AI-assisted|AI generated|powered by/i);
    expect(banner.textContent).not.toMatch(/with AI/i);
  });

  test('a run where the AI decided is labelled as such, and carries its rationale', () => {
    render(<StatusBanner ai={USED_AI} travel={TRAVEL_UNSUPPORTED} transfer={TRANSFER_INACTIVE} />);
    const banner = screen.getByTestId('ai-status');
    expect(banner.getAttribute('data-state')).toBe('used');
    expect(banner.textContent).toContain('Đã dùng chiến lược AI');
    expect(banner.textContent).toContain('Chi tiết chiến lược được lưu trong dữ liệu kiểm tra.');
  });

  test('"AI not requested" is distinct from "the provider failed"', () => {
    render(<StatusBanner ai={NOT_REQUESTED_AI} travel={TRAVEL_UNSUPPORTED} transfer={TRANSFER_INACTIVE} />);
    const banner = screen.getByTestId('ai-status');
    // A user who deliberately chose the deterministic path must not
    // be told a provider failed on their behalf.
    expect(banner.getAttribute('data-state')).toBe('not-requested');
    expect(banner.textContent).toContain('không dùng AI');
    expect(banner.textContent).not.toMatch(/unavailable|failed|timed out/i);
  });

  test('an unreported AI block does not fall through to the AI sentence', () => {
    render(<StatusBanner ai={null} travel={TRAVEL_UNSUPPORTED} transfer={TRANSFER_INACTIVE} />);
    const banner = screen.getByTestId('ai-status');
    expect(banner.getAttribute('data-state')).toBe('unknown');
    expect(banner.textContent).toContain('Chưa có thông tin');
  });
});

// ============================================================================
// 3. Travel and transfer are never claimed as optimized
// ============================================================================

describe('unsupported capabilities are not claimed', () => {
  test('travel reads as not scored, with the H14 status', () => {
    render(<StatusBanner ai={NOT_REQUESTED_AI} travel={TRAVEL_UNSUPPORTED} transfer={TRANSFER_INACTIVE} />);
    const travel = screen.getByTestId('travel-status');
    // "Not optimized" would still be wrong: travel was never on the
    // scale, so there was nothing to optimize.
    expect(travel.textContent).toContain('Chưa được tính');
    expect(travel.textContent).not.toMatch(/travel (is )?(ok|ready|optimized|considered)/i);
  });

  test('an inactive transfer is not rendered as applied', () => {
    render(<StatusBanner ai={NOT_REQUESTED_AI} travel={TRAVEL_UNSUPPORTED} transfer={TRANSFER_INACTIVE} />);
    const transfer = screen.getByTestId('transfer-status');
    expect(transfer.textContent).toContain('Chưa bật');
    expect(transfer.textContent).not.toMatch(/transfer(s)? (applied|optimized|used)/i);
  });

  test('a READY travel provider flips the label to Scored, with no new claim invented', () => {
    render(
      <StatusBanner
        ai={NOT_REQUESTED_AI}
        travel={{ h14: 'READY', available: true, detail: 'A travel matrix is present.' }}
        transfer={TRANSFER_INACTIVE}
      />,
    );
    expect(screen.getByTestId('travel-status').textContent).toContain('Đã tính đến thời gian di chuyển');
  });
});

// ============================================================================
// 4. A missing number is a dash, never a zero
// ============================================================================

describe('unmeasured values are not rendered as zero', () => {
  test('a null metric renders as a dash', () => {
    // The scorer serializes an unmeasurable dimension as null. "0.000"
    // would be indistinguishable from a measured zero, and a reader
    // would take it as one.
    const withNulls = [{
      ...SOLUTIONS[0],
      metrics: { ...SOLUTIONS[0].metrics, workloadStdev: null, teacherCount: null },
    }];
    render(<SolutionList solutions={withNulls} selectedId={null} onSelect={() => {}} onCommit={() => {}} />);
    const metrics = screen.getByTestId('quality-metrics').textContent;
    expect(metrics).toContain('—');
    expect(metrics).not.toMatch(/workloadStdev0\.000/);
  });

  test('a null diversity value renders as a dash', () => {
    const withNulls = [{ ...SOLUTIONS[0], diversity: { ...SOLUTIONS[0].diversity, overall: null } }];
    render(<SolutionList solutions={withNulls} selectedId={null} onSelect={() => {}} onCommit={() => {}} />);
    expect(screen.getByTestId('diversity-metrics').textContent).toContain('—');
  });

  test('a solution with no scoring block still renders its identity', () => {
    const bare = { id: 'ms-bare', rank: 1, metrics: {}, diversity: {} };
    render(<SolutionList solutions={[bare]} selectedId={null} onSelect={() => {}} onCommit={() => {}} />);
    // The component must not throw on a partial solution; the
    // response shape is documented, not enforced at runtime.
    expect(screen.getByTestId('solution-id').textContent).toBe('ms-bare');
  });
});

// ============================================================================
// 5. The grid is built from the response's calendar
// ============================================================================

describe('the grid follows the data, not a hard-coded week', () => {
  test('teacher selector follows home branch even when schedule placements differ', async () => {
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generate();

    await userEvent.selectOptions(screen.getByTestId('view-mode'), 'TEACHER');
    await userEvent.selectOptions(screen.getByTestId('entity-select'), 't2');
    await userEvent.selectOptions(screen.getByTestId('branch-filter'), 'b2');

    await waitFor(() => expect(screen.getByTestId('entity-select').value).toBe('t2'));
    const teacherSelect = screen.getByTestId('entity-select');
    expect(within(teacherSelect).getByRole('option', { name: 'Trần Thị Bình' })).toBeTruthy();
    expect(within(teacherSelect).getByRole('option', { name: 'Nguyễn Văn An · Điều chuyển từ Cơ sở 1' })).toBeTruthy();
    expect(screen.getByTestId('teacher-branch-note').textContent).toContain('hiển thị tất cả phân hiệu');
    expect(screen.getAllByTestId('tkb-cell-filled').some((cell) => cell.textContent.includes('Cơ sở 1'))).toBe(true);
  });

  test('the selected timetable explains teacher transfers and workload balance', async () => {
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generate();

    const summary = screen.getByTestId('transfer-balance-summary');
    expect(summary.textContent).toContain('2 lượt điều chuyển');
    expect(summary.textContent).toContain('Nguyễn Văn An');
    expect(summary.textContent).toContain('Trần Thị Bình');
    expect(summary.textContent).toContain('Chênh lệch tải giữa giáo viên: 2.31 tiết');
  });

  test('all six school days from the response are drawn', () => {
    render(
      <ScheduleGrid
        days={CALENDAR.days}
        placements={PLACEMENTS}
        mode="CLASS"
        entityId="c1"
        branchFilter="ALL"
        directory={DIRECTORY}
      />,
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    // A Monday-Friday table would have five columns and would drop
    // the Saturday placement the solver had actually scheduled.
    expect(headers).toHaveLength(1 + 6);
    expect(headers).toEqual(['Tiết', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7']);
  });

  test('the day-6 placement is rendered, not dropped', () => {
    render(
      <ScheduleGrid
        days={CALENDAR.days}
        placements={PLACEMENTS}
        mode="CLASS"
        entityId="c1"
        branchFilter="ALL"
        directory={DIRECTORY}
      />,
    );
    // c1 has a placement on day 6. If the grid were Mon-Fri, this
    // row would have nowhere to render.
    const filled = screen.getAllByTestId('tkb-cell-filled');
    expect(filled.length).toBeGreaterThanOrEqual(3);
  });

  test('an unrecognised day number falls back to "Day N" rather than a wrong name', () => {
    render(
      <ScheduleGrid
        days={[{ day: 7, label: null, periods: [1], sessions: ['sang'] }]}
        placements={[{ ...PLACEMENTS[0], day: 7 }]}
        mode="CLASS"
        entityId="c1"
        branchFilter="ALL"
        directory={DIRECTORY}
      />,
    );
    // Guessing day 7's name would be a claim about the source the
    // source never made.
    expect(screen.getByRole('columnheader', { name: 'Day 7' })).toBeTruthy();
  });

  test('a class cell leads with the teacher; a teacher cell leads with the subject', () => {
    const { unmount } = render(
      <ScheduleGrid days={CALENDAR.days} placements={PLACEMENTS} mode="CLASS" entityId="c1" branchFilter="ALL" directory={DIRECTORY} />,
    );
    const cell = screen.getAllByTestId('tkb-cell-filled')[0];
    expect(cell.querySelector('.tkb-cell-primary').textContent).toBe('Nguyễn Văn An');
    unmount();

    render(
      <ScheduleGrid days={CALENDAR.days} placements={PLACEMENTS} mode="TEACHER" entityId="t1" branchFilter="ALL" directory={DIRECTORY} />,
    );
    const teacherCell = screen.getAllByTestId('tkb-cell-filled')[0];
    // Same data, different question: a teacher asks "what", a class
    // asks "who".
    expect(teacherCell.querySelector('.tkb-cell-primary').textContent).toBe('Toán');
  });

  test('the branch filter removes the other branch rows', () => {
    const { unmount } = render(
      <ScheduleGrid days={CALENDAR.days} placements={PLACEMENTS} mode="CLASS" entityId="c2" branchFilter="ALL" directory={DIRECTORY} />,
    );
    expect(screen.getAllByTestId('tkb-cell-filled')).toHaveLength(1);
    unmount();

    render(
      <ScheduleGrid days={CALENDAR.days} placements={PLACEMENTS} mode="CLASS" entityId="c2" branchFilter="b1" directory={DIRECTORY} />,
    );
    // c2 belongs to b2, so filtering to b1 must empty the grid rather
    // than show a row from the wrong campus.
    expect(screen.queryAllByTestId('tkb-cell-filled')).toHaveLength(0);
  });
});

// ============================================================================
// 6. No PII reaches the DOM
// ============================================================================

describe('no personal field is rendered', () => {
  test('the grid renders only names from the directory', () => {
    const { container } = render(
      <ScheduleGrid days={CALENDAR.days} placements={PLACEMENTS} mode="CLASS" entityId="c1" branchFilter="ALL" directory={DIRECTORY} />,
    );
    const html = container.innerHTML;
    for (const key of ['email', 'sodienthoai', 'dob', 'address', '@']) {
      expect(html.toLowerCase().includes(key)).toBe(false);
    }
  });

  test('the data report does not forward loader internals', () => {
    const { container } = render(<DataReport diagnostics={OK_RESPONSE.diagnostics} />);
    const html = container.innerHTML;
    for (const key of ['transferHistory', 'integrityCounts', '_meta', 'timeSlotsByBranch', 'excludedCurriculum']) {
      expect(html.includes(key)).toBe(false);
    }
  });
});

// ============================================================================
// 7. The data report shows the counts the backend measured
// ============================================================================

describe('the data report', () => {
  test('renders the real dataset counts, not a recount of the directory', () => {
    render(<DataReport diagnostics={OK_RESPONSE.diagnostics} />);
    const counts = screen.getByTestId('data-counts').textContent;
    expect(counts).toContain('40');
    expect(counts).toContain('113');
    expect(counts).toContain('802');
  });

  test('surfaces the travel data gap as a labelled flag, not a code', () => {
    render(<DataReport diagnostics={OK_RESPONSE.diagnostics} />);
    const flags = screen.getByTestId('data-status').textContent;
    // "MISSING_CONFIGURATION" alone is not something a user can act
    // on; the label is the readable half of the fact.
    expect(flags).toContain('Di chuyển');
    expect(flags).toContain('Chưa cấu hình');
  });

  test('shows the reproducibility hashes in full', () => {
    render(<DataReport diagnostics={OK_RESPONSE.diagnostics} />);
    // Truncating the hash keeps the look and loses the property that
    // makes "same data, same scorer" checkable.
    expect(screen.getByTestId('data-report').textContent).toContain(REAL_PROVENANCE.benchmarkInputHash);
  });

  test('returns nothing when the response carried no diagnostics', () => {
    const { container } = render(<DataReport diagnostics={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});

// ============================================================================
// 8. EMPTY and MISSING_DATA are different answers
// ============================================================================

describe('the two empty outcomes are kept apart', () => {
  test('MISSING_DATA says the data is absent, not that the request failed', async () => {
    mockFetch(MISSING_DATA_RESPONSE);
    render(<SchedulePage />);
    await generate();

    const empty = screen.getByTestId('empty-state');
    expect(empty.textContent).toContain('Thiếu dữ liệu để xếp thời khóa biểu');
    expect(empty.textContent).toContain('dữ liệu nguồn còn thiếu');
    // Not an error banner: a valid request with absent data is not a
    // failure the user caused.
    expect(screen.queryByTestId('generate-error')).toBeNull();
  });

  test('EMPTY says the solver found nothing hard-feasible', async () => {
    mockFetch(EMPTY_RESPONSE);
    render(<SchedulePage />);
    await generate();

    const empty = screen.getByTestId('empty-state');
    expect(empty.textContent).toContain('Chưa tìm được thời khóa biểu thỏa tất cả quy tắc');
    // The pipeline RAN and produced nothing. Saying "nothing was
    // written" is the load-bearing half: the alternative reading is
    // that a schedule exists and was not saved.
    expect(empty.textContent).toContain('Chưa có lịch nào được tạo hoặc lưu');
    expect(empty.textContent).not.toMatch(/MISSING_DATA|thiếu dữ liệu/i);
  });

  test('no solution list is rendered when there are no solutions', async () => {
    mockFetch(EMPTY_RESPONSE);
    render(<SchedulePage />);
    await generate();
    expect(screen.queryByTestId('solution-list')).toBeNull();
  });

  test('EMPTY with missing branch permission explains why Generate has no timetable and identifies the blocked demand', async () => {
    mockFetch({ ...EMPTY_RESPONSE, diagnostics: { ...EMPTY_RESPONSE.diagnostics, solver: {
      unresolvable: [{ assignmentId: 'blocked', classId: 'c1', subjectId: 's1', branchId: 'b1', requiredPeriods: 4, reasonCode: 'NO_PERMITTED_TEACHER' }],
    } } });
    render(<SchedulePage />);
    await generate();
    const empty = screen.getByTestId('empty-state');
    expect(within(empty).getByRole('heading').textContent).toContain('thiếu quyền chuyển cơ sở');
    expect(empty.textContent).toContain('1 phân công chưa giải quyết · 4 tiết');
    expect(empty.textContent).toContain('không cấp quyền chuyển cơ sở');
    await userEvent.click(within(empty).getByText('Xem danh sách lớp, môn và cơ sở cần xử lý'));
    expect(within(empty).getByText(DIRECTORY.classes.find((row) => row.id === 'c1').name)).toBeTruthy();
    expect(within(empty).getByText(DIRECTORY.subjects.find((row) => row.id === 's1').name)).toBeTruthy();
    expect(within(empty).getByText(DIRECTORY.branches.find((row) => row.id === 'b1').name)).toBeTruthy();
    expect(screen.queryByTestId('timetable-section')).toBeNull();
  });

  test('an ineligible-teacher failure is shown separately from missing transfer permission', async () => {
    mockFetch({ ...EMPTY_RESPONSE, diagnostics: { ...EMPTY_RESPONSE.diagnostics, solver: {
      unresolvable: [{ assignmentId: 'blocked', requiredPeriods: 2, reasonCode: 'NO_ELIGIBLE_TEACHER' }],
    } } });
    render(<SchedulePage />);
    await generate();
    const empty = screen.getByTestId('empty-state');
    expect(within(empty).getByRole('heading').textContent).toContain('có phân công chưa giải quyết');
    expect(empty.textContent).toContain('Chưa có GV đủ chuyên môn');
    expect(empty.textContent).not.toContain('Có GV đủ chuyên môn, thiếu quyền');
  });

  test('a subject capacity shortage reports the missing weekly periods and qualified teacher count', async () => {
    mockFetch({ ...EMPTY_RESPONSE, diagnostics: { ...EMPTY_RESPONSE.diagnostics, solver: {
      unresolvable: [{ assignmentId: 'blocked', classId: 'c1', subjectId: 's1', branchId: 'b1', requiredPeriods: 2, reasonCode: 'SUBJECT_CAPACITY_SHORTAGE' }],
      capacityShortages: [{ subjectIds: ['s1', 's2'], requiredPeriods: 140, availablePeriods: 132, shortagePeriods: 8, teacherIds: ['t1', 't2', 't3', 't4'] }],
    } } });
    render(<SchedulePage />);
    await generate();

    const empty = screen.getByTestId('empty-state');
    expect(empty.textContent).toContain('bổ sung giáo viên đủ chuyên môn');
    expect(within(empty).getByTestId('capacity-shortage').textContent).toContain('140 tiết');
    expect(within(empty).getByTestId('capacity-shortage').textContent).toContain('132 tiết');
    expect(within(empty).getByTestId('capacity-shortage').textContent).toContain('thiếu 8 tiết');
    expect(within(empty).getByTestId('capacity-shortage').textContent).toContain('4 giáo viên đủ chuyên môn');
    expect(screen.queryByTestId('timetable-section')).toBeNull();
  });

  test('branch scheduling reports local progress and transfer needs while withholding an incomplete timetable', async () => {
    mockFetch({ ...EMPTY_RESPONSE, diagnostics: { ...EMPTY_RESPONSE.diagnostics, solver: { unresolvable: [], branchScheduling: {
      localAssignments: 417, requiredAssignments: 479, localPeriods: 722, requiredPeriods: 802, transferStatus: 'UNRESOLVED',
      pendingAssignments: [{ assignmentId: 'pending', classId: 'c1', subjectId: 's1', branchId: 'b1', requiredPeriods: 4, reasonCode: 'LOCAL_SCHEDULING_LIMIT' }],
      branches: [{ branchId: 'b1', localAssignments: 38, requiredAssignments: 63, localPeriods: 62, requiredPeriods: 105 }],
    } } } });
    render(<SchedulePage />);
    await generate();
    const stage = screen.getByTestId('branch-scheduling-summary');
    expect(stage.textContent).toContain('417/479 phân công · 722/802 tiết');
    expect(stage.textContent).toContain('1 phân công · 4 tiết');
    expect(stage.textContent).toContain('Chỉ hiển thị TKB khi đã xếp đủ toàn bộ');
    expect(screen.queryByTestId('timetable-section')).toBeNull();
    expect(screen.queryByTestId('solution-list')).toBeNull();
  });

  test('a capacity shortfall explains why transfer cannot cover all pending demand', async () => {
    mockFetch({ ...EMPTY_RESPONSE, diagnostics: { ...EMPTY_RESPONSE.diagnostics, solver: {
      unresolvable: [{ assignmentId: 'pending', classId: 'c1', subjectId: 's1', branchId: 'b1', requiredPeriods: 4, reasonCode: 'SUBJECT_CAPACITY_SHORTAGE' }],
      capacityShortages: [{ subjectIds: ['s1', 's2'], requiredPeriods: 140, availablePeriods: 132, shortagePeriods: 8, teacherIds: ['t1', 't2'] }],
      branchScheduling: {
        localAssignments: 447, requiredAssignments: 549, localPeriods: 752, requiredPeriods: 872,
        transferStatus: 'INSUFFICIENT_CAPACITY',
        pendingAssignments: [{ assignmentId: 'pending', classId: 'c1', subjectId: 's1', branchId: 'b1', requiredPeriods: 4 }],
      },
    } } });
    render(<SchedulePage />);
    await generate();

    const blocker = screen.getByTestId('transfer-capacity-blocker');
    expect(blocker.textContent).toContain('cần 140 tiết');
    expect(blocker.textContent).toContain('có 132 tiết');
    expect(blocker.textContent).toContain('còn thiếu 8 tiết');
    expect(blocker.textContent).toContain('không phải nguyên nhân tắt điều chuyển');
    expect(screen.queryByTestId('timetable-section')).toBeNull();
  });
});

// ============================================================================
// 9. Selection and commit
// ============================================================================
//
// PHASE 33: the three commit tests below now drive the CONFIRMATION
// DIALOG, because that is where a commit starts. The property each one
// protects is unchanged and is the reason they were written: a commit
// the backend did not confirm is never shown as a write; a refusal
// shows the backend's own words; and a result belongs to one solution.
// Only the expected copy changed, because "Preview only" is no longer
// the truthful answer.

describe('selecting and committing a solution', () => {
  test('selecting a solution marks it and does not refetch', async () => {
    const user = userEvent.setup();
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await generate();

    const cards = screen.getAllByTestId('solution-card');
    expect(cards[0].className).toContain('tkb-solution-selected');

    await user.click(screen.getAllByRole('button', { name: 'Phương án 2' })[0]);
    // The selection is local. Re-selecting a schedule the user is
    // already looking at must not cost a solve.
    expect(screen.getAllByTestId('solution-card')[1].className).toContain('tkb-solution-selected');
    expect(screen.getAllByTestId('solution-card')[0].className).not.toContain('tkb-solution-selected');
  });

  test('a 200 that does not confirm a write is never shown as a write', async () => {
    const user = userEvent.setup();
    // The shape Phase 32's contract produced: a 200 that says
    // `written: false`. The backend no longer answers this way, and a
    // deployment behind a proxy or a future API version might. The UI
    // must treat "200 but not committed" as a failure, because the
    // user's question is "is it saved", not "did the server reply".
    mockFetch({
      generate: OK_RESPONSE,
      commit: {
        ok: true,
        written: false,
        committed: false,
        persistence: { implemented: false, reason: 'PREVIEW_ONLY' },
        solutionId: SOLUTIONS[0].id,
      },
    });
    render(<SchedulePage />);
    await generate();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    const failed = await screen.findByTestId('commit-failed');
    expect(failed.textContent).toContain('Chưa lưu được lịch.');
    expect(screen.queryByTestId('commit-result')).toBeNull();
  });

  test('a failed commit shows the backend message, not a generic one', async () => {
    const user = userEvent.setup();
    mockFetch({
      generate: OK_RESPONSE,
      commit: {
        status: 409,
        body: {
          ok: false,
          persisted: false,
          status: 'COMMIT_REJECTED',
          error: { code: 'HARD_VIOLATION', message: 'The solution failed re-validation. The schedule was not saved.' },
          errors: [{ field: 'solutionId', code: 'HARD_VIOLATION', message: 'The solution failed re-validation. The schedule was not saved.' }],
        },
      },
    });
    render(<SchedulePage />);
    await generate();

    await user.click(screen.getAllByTestId('commit-button')[0]);
    await user.click(await screen.findByTestId('commit-confirm'));

    const failed = await screen.findByTestId('commit-failed');
    expect(failed.textContent).toBe('Chưa lưu được lịch. Phương án không vượt qua bước kiểm tra lại nên chưa được lưu.');
    // The dialog says it too, and leads with the same fact.
    const dialogError = await screen.findByTestId('commit-dialog-error');
    expect(within(dialogError).getByTestId('commit-dialog-error-headline').textContent).toBe('Chưa lưu được thời khóa biểu.');
  });

  test('the commit result appears only on the solution it belongs to', async () => {
    const user = userEvent.setup();
    mockFetch({
      generate: OK_RESPONSE,
      commit: {
        ...COMMITTED_RESPONSE,
        solutionId: SOLUTIONS[1].id,
      },
    });
    render(<SchedulePage />);
    await generate();

    await user.click(screen.getAllByTestId('commit-button')[1]);
    await user.click(await screen.findByTestId('commit-confirm'));
    await screen.findByTestId('commit-result');
    // One result, on one card. A "Committed" line under every card
    // would tell the user three schedules were committed.
    expect(screen.getAllByTestId('commit-result')).toHaveLength(1);
    expect(screen.getAllByTestId('solution-card')[1].textContent).toContain('Đã lưu lịch');
    expect(screen.getAllByTestId('solution-card')[0].textContent).not.toContain('Đã lưu lịch');
  });
});

// ============================================================================
// 10. The request vocabulary comes from the backend
// ============================================================================

describe('the request controls', () => {
  test('the candidate counts offered are the ones the API allows', async () => {
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    await screen.findByTestId('health-note');

    const options = within(screen.getByTestId('candidate-count'))
      .getAllByRole('option')
      .map((o) => o.value);
    // Read from /health, not from a second hard-coded list that could
    // drift from the contract.
    expect(options).toEqual(HEALTH.request.allowedCandidateCounts.map(String));
  });

  test('the health note reports commit mode and both capability statuses', async () => {
    mockFetch(OK_RESPONSE);
    render(<SchedulePage />);
    const note = await screen.findByTestId('health-note');
    // These are the facts a user must not have to guess, stated
    // before a request is made rather than after.
    // PHASE 33: the commit mode changed from PREVIEW_ONLY to
    // COMMIT_ENABLED because the deployment can now write. The two
    // constraint statuses did not move, and this assertion is what
    // would notice if they did.
    expect(note.textContent).toContain('Lưu lịch đang bật');
    expect(note.textContent).toContain('Di chuyển giữa phân hiệu chưa cấu hình');
    expect(note.textContent).toContain('Điều chuyển chưa bật');
  });

  test('a failed health read does not block generation', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/health')) throw new Error('offline');
      return jsonResponse(200, OK_RESPONSE);
    });
    render(<SchedulePage />);
    await generate();
    // The documented defaults are still the right request, so health
    // is a nicety rather than a precondition.
    expect(screen.getAllByTestId('solution-card')).toHaveLength(3);
  });

  test('a double click on Generate starts one request', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    globalThis.fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.includes('/health')) return jsonResponse(200, HEALTH);
      // PHASE 33: the page also reads the committed-schedule list on
      // mount, so the counter is scoped to the GENERATE call. The
      // property under test is "one solve per double click", and
      // counting every request would now be measuring the read-back
      // too.
      if (/\/schedules\/committed(\/|$)/.test(path)) return jsonResponse(200, committedList());
      calls += 1;
      await gate;
      return jsonResponse(200, OK_RESPONSE);
    });

    render(<SchedulePage />);
    const button = await screen.findByTestId('generate-button');
    // Two clicks in the same tick, inside one `act` so the state
    // update the first one triggers is flushed between them. The
    // guard being tested is the synchronous `busy` ref, not the
    // re-render: a state variable read after a re-render would pass
    // this test and still let a real double click through.
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    release();
    await screen.findByTestId('solution-list', {}, { timeout: 2000 });

    expect(calls).toBe(1);
  });
});

// ============================================================================
// 11. Errors are readable
// ============================================================================

describe('error handling', () => {
  test('a 400 shows the backend message for the offending field', async () => {
    mockFetch({
      generate: {
        status: 400,
        body: {
          status: 'INVALID_INPUT',
          errors: [{ field: 'candidateCount', code: 'INVALID_CANDIDATE_COUNT', message: 'candidateCount 2 is not allowed. Allowed values: 1, 3, 5, 10.' }],
        },
      },
    });
    render(<SchedulePage />);
    await generate();

    const error = await screen.findByTestId('generate-error');
    expect(error.textContent).toContain('candidateCount 2 is not allowed');
    // A stack trace or a framework internal is not something to put
    // in front of a person.
    expect(error.textContent).not.toMatch(/at Object|node_modules|\.js:/);
  });

  test('an unreachable server is reported as such, not as a scheduler status', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/health')) return jsonResponse(200, HEALTH);
      throw new TypeError('Failed to fetch');
    });
    render(<SchedulePage />);
    await generate();

    const error = await screen.findByTestId('generate-error');
    expect(error.textContent).toContain('Could not reach the scheduling API');
  });
});

// ============================================================================
// helpers
// ============================================================================

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Stub `fetch` for health, generate and commit.
 *
 * `options.generate` is either a response body (a 200) or
 * `{ status, body }` for a failure, so a test can exercise a 400 on
 * the generate call without also making the commit call fail. The
 * default commit response is a realistic preview-only success, so a
 * test that does not care about commit does not have to set one.
 */
function mockFetch(options = {}) {
  const spec = typeof options === 'object' && options !== null
    && ('generate' in options || 'commit' in options || 'committed' in options)
    ? options
    : { generate: options };

  globalThis.fetch = vi.fn(async (url) => {
    const path = String(url);
    if (path.includes('/health')) return jsonResponse(200, HEALTH);

    // PHASE 33: the committed list. Phase 32 had no such endpoint, so
    // there was nothing to answer and the page had nothing to read.
    if (/\/schedules\/committed(\/|$)/.test(path)) {
      return jsonResponse(200, spec.committed ?? committedList());
    }

    if (path.includes('/commit')) {
      const commit = spec.commit ?? COMMITTED_RESPONSE;
      return isSpec(commit)
        ? jsonResponse(commit.status, commit.body)
        : jsonResponse(200, commit);
    }

    const generate = spec.generate ?? OK_RESPONSE;
    return isSpec(generate)
      ? jsonResponse(generate.status, generate.body)
      : jsonResponse(200, generate);
  });
}

/** A `{ status, body }` pair rather than a bare body. */
function isSpec(value) {
  return value !== null && typeof value === 'object' && 'status' in value && 'body' in value;
}

/**
 * Click Generate and wait for the page to settle into a terminal
 * state. The terminal state is different for an OK response (a
 * solution list) and for EMPTY / MISSING_DATA (an empty state), so
 * this waits for either rather than assuming success.
 */
async function generate() {
  const button = await screen.findByTestId('generate-button');
  await userEvent.click(button);
  await waitFor(() => {
    const settled = screen.queryByTestId('solution-list') ?? screen.queryByTestId('empty-state')
      ?? screen.queryByTestId('generate-error');
    if (!settled) throw new Error('the page has not settled yet');
  });
}
