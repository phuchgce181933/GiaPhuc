/**
 * Phase 32 — the generate-and-compare screen.
 *
 * The whole Phase 32 flow in one component: choose a request, watch
 * the pipeline, compare the solutions the backend returned, read one
 * timetable.
 *
 * WHAT THIS PAGE DOES NOT OWN
 * ---------------------------
 *   - the request lifecycle (hooks.js)
 *   - the commit lifecycle (useCommitState.js)
 *   - HTTP (features/scheduling/service.js)
 *   - the numbers (the backend)
 *   - the meaning of a cell (ScheduleGrid.jsx)
 *
 * It owns exactly one thing: the layout, and the wiring between the
 * hook's state and the components. Every value rendered here
 * came from a response or from a control the user touched.
 *
 * THE REQUEST CONTROLS ARE THE CONTRACT'S VOCABULARY
 * --------------------------------------------------
 * `candidateCount` and `optimizationMode` are rendered as closed
 * option sets rather than free inputs, and the allowed values are
 * read from `/api/schedules/health` when it answers. A user cannot
 * type a value the contract refuses, and the page does not hard-code
 * a second copy of the vocabulary that could drift from the backend
 * (brief §22, §23). When health is unavailable the controls fall back
 * to the documented defaults and say so.
 *
 * `useAI` defaults to `true`, matching the contract, and the banner
 * reports honestly when the deterministic path is what actually ran.
 *
 * PHASE 33 — GENERATE IS NOT SAVE
 * -------------------------------
 * The Generate button calls `gen.generate` and nothing else. No
 * commit is chained to it, no store is touched, and the committed
 * panel is rendered from the BACKEND's own record rather than from
 * anything this component did. Saving is a separate click on a
 * solution card, then a dialog, then Confirm (brief §1, §34).
 */

import { useCallback, useEffect, useState } from 'react';
import { useScheduleGeneration } from '../hooks.js';
import { useCommitState, COMMIT_STATE } from '../useCommitState.js';
import { fetchHealth } from '../service.js';
import { SolutionList } from '../components/SolutionList.jsx';
import { ScheduleGrid, dayLabel } from '../components/ScheduleGrid.jsx';
import { StatusBanner } from '../components/StatusBanner.jsx';
import { DataReport } from '../components/DataReport.jsx';
import { CommitDialog } from '../components/CommitDialog.jsx';
import { CommittedPanel } from '../components/CommittedPanel.jsx';
import { localizeSchedulingMessage } from '../messages.js';

/**
 * Fallback vocabulary, used only until `/health` answers. These are
 * the values the contract documents, so the control is never wrong —
 * it is at worst unconfirmed, and it says so once health resolves.
 */
const FALLBACK_VOCABULARY = {
  candidateCounts: [1, 3, 5, 10],
  optimizationModes: [],
};

const CANDIDATE_COUNTS = [1, 3, 5, 10];
const OPTIMIZATION_LABELS = {
  BASE_FEASIBLE: 'Ưu tiên xếp đủ và đúng quy tắc',
  ASSIGNMENT_BALANCED: 'Cân bằng số tiết giữa giáo viên',
  PREFERENCE_FIRST: 'Ưu tiên nguyện vọng giáo viên',
  GLOBAL_ASSIGNMENT_BALANCED: 'Cân bằng tải toàn trường',
};

export function SchedulePage() {
  const gen = useScheduleGeneration();
  const [health, setHealth] = useState(null);
  const [candidateCount, setCandidateCount] = useState(3);
  const [optimizationMode, setOptimizationMode] = useState('');
  const [useAI, setUseAI] = useState(true);
  const [refreshingCommitted, setRefreshingCommitted] = useState(false);

  // The commit machine is keyed on the CURRENT generation's id. A new
  // generation does not clear it: a schedule that is already on disk
  // stays on disk, and the panel below is read from the backend
  // rather than from this render (brief §34).
  const commit = useCommitState({ requestId: gen.response?.requestId ?? null });

  // One health read on mount. A failure is not surfaced as an error
  // because it changes nothing: the contract's documented defaults
  // are still the right request, and generation itself reports
  // anything that actually matters.
  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((h) => {
        if (cancelled || !h) return;
        setHealth(h);
        // Adopt the first allowed mode so the control shows the real
        // vocabulary rather than an empty list.
        const modes = h?.request?.allowedOptimizationModes ?? [];
        if (modes.length > 0) setOptimizationMode((current) => current || modes[0]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // The committed list is read from the BACKEND on mount, which is
  // what makes a page reload show the schedule that is already saved
  // instead of an empty panel (brief §24).
  const onRefreshCommitted = useCallback(async () => {
    setRefreshingCommitted(true);
    try {
      await commit.refreshCommitted();
    } finally {
      setRefreshingCommitted(false);
    }
  }, [commit]);

  useEffect(() => { onRefreshCommitted(); /* eslint-disable-next-line */ }, []);

  const modes = health?.request?.allowedOptimizationModes ?? FALLBACK_VOCABULARY.optimizationModes;
  const counts = health?.request?.allowedCandidateCounts ?? CANDIDATE_COUNTS;

  const onGenerate = useCallback(() => {
    gen.generate({ candidateCount, optimizationMode: optimizationMode || undefined, useAI });
  }, [gen, candidateCount, optimizationMode, useAI]);

  const response = gen.response;
  const solutions = response?.solutions ?? [];
  const selected = gen.selectedSolution;
  const teacherOptions = (response?.directory?.teachers ?? []).filter((teacher) => gen.branchFilter === 'ALL'
    || teacher.homeBranchId === gen.branchFilter
    || selected?.placements?.some((placement) => placement.teacherId === teacher.id && placement.branchId === gen.branchFilter));
  const branchScheduling = response?.diagnostics?.solver?.branchScheduling;
  const capacityShortages = response?.diagnostics?.solver?.capacityShortages ?? [];
  const solverUnresolvable = response?.diagnostics?.solver?.unresolvable ?? [];
  const unresolvedById = new Map(solverUnresolvable.map((row) => [row.assignmentId, row]));
  const unresolvable = branchScheduling?.pendingAssignments?.length
    ? branchScheduling.pendingAssignments.map((row) => ({ ...row, ...unresolvedById.get(row.assignmentId) })) : solverUnresolvable;
  const permissionBlocked = unresolvable.length > 0 && unresolvable.every((row) => row.reasonCode === 'NO_PERMITTED_TEACHER');

  // The dialog always shows the solution it is about, even after the
  // user picks a different card while it is open — otherwise the
  // summary would describe one schedule and the request would commit
  // another. If the user selects another card, the dialog follows.
  const dialogSolution = solutions.find((s) => s.id === commit.solutionId) ?? null;
  const dialogOpen = commit.state === COMMIT_STATE.CONFIRMING
    || commit.state === COMMIT_STATE.COMMITTING
    || commit.state === COMMIT_STATE.FAILED;

  // A commit result belongs to ONE generation. If the user generated
  // again, the new cards must not inherit the previous generation's
  // "Committed" line — the committed panel below is what carries the
  // history (brief §34).
  const currentRequestId = response?.requestId ?? null;
  const commitState = commit.scopedTo(currentRequestId);

  useEffect(() => {
    if (gen.viewMode !== 'TEACHER' || gen.branchFilter === 'ALL') return;
    if (teacherOptions.some((teacher) => teacher.id === gen.entityId)) return;
    gen.setEntity(teacherOptions[0]?.id ?? null);
  }, [gen.viewMode, gen.branchFilter, gen.entityId, selected?.id]);

  return (
    <div className="tkb-page">
      <header className="tkb-page-head">
        <h1>Tạo thời khóa biểu</h1>
        <p className="tkb-hint">
          Chọn cách xếp để tạo phương án. Tạo TKB chỉ là xem trước; lịch chỉ được lưu sau khi xác nhận.
        </p>
      </header>

      <section className="tkb-controls" data-testid="generate-controls">
        <label className="tkb-control">
          <span>Số phương án</span>
          <select
            value={candidateCount}
            onChange={(e) => setCandidateCount(Number(e.target.value))}
            data-testid="candidate-count"
          >
            {counts.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <label className="tkb-control">
          <span>Ưu tiên xếp</span>
          <select
            value={optimizationMode}
            onChange={(e) => setOptimizationMode(e.target.value)}
            disabled={modes.length === 0}
            data-testid="optimization-mode"
          >
            {modes.length === 0 ? (
              <option value="">Mặc định</option>
            ) : (
              modes.map((m) => <option key={m} value={m}>{OPTIMIZATION_LABELS[m] ?? m}</option>)
            )}
          </select>
        </label>

        <label className="tkb-control tkb-control-inline">
          <input
            type="checkbox"
            checked={useAI}
            onChange={(e) => setUseAI(e.target.checked)}
            data-testid="use-ai"
          />
          <span>Để AI đề xuất cách xếp</span>
        </label>

        <button
          type="button"
          className="tkb-generate"
          onClick={onGenerate}
          disabled={gen.loading || gen.busy}
          data-testid="generate-button"
        >
          {gen.loading ? 'Đang xếp…' : 'Tạo TKB'}
        </button>

        {health ? (
          <p className="tkb-hint" data-testid="health-note">
            Trạng thái hệ thống: Lưu lịch {health.commit?.mode === 'COMMIT_ENABLED' ? 'đang bật' : 'chưa bật'} · Di chuyển giữa phân hiệu {health.travel?.available ? 'đã cấu hình' : 'chưa cấu hình'} · Điều chuyển {health.transfer?.active ? 'đang bật' : 'chưa bật'}
          </p>
        ) : null}
      </section>

      {gen.errorMessage ? (
        <p className="tkb-error" role="alert" data-testid="generate-error">{localizeSchedulingMessage(gen.errorMessage)}</p>
      ) : null}

      {branchScheduling ? <BranchSchedulingSummary result={branchScheduling} directory={response.directory} capacityShortages={capacityShortages} /> : null}

      {response ? (
        <StatusBanner
          ai={response.ai}
          travel={response.travel}
          transfer={response.transfer}
          generation={response.generation}
        />
      ) : null}

      {response ? <DataReport diagnostics={response.diagnostics} /> : null}

      {/* EMPTY and MISSING_DATA are 200s with a real reason, and they
          are NOT the same reason. Collapsing them into one "no
          results" line would hide the difference between "the solver
          found nothing hard-feasible" and "the data is not there"
          (brief §9, §35). */}
      {response && solutions.length === 0 ? (
        <section className="tkb-empty-state" data-testid="empty-state">
          <h2>
            {branchScheduling?.pendingAssignments?.length ? 'Chưa thể hoàn tất TKB: còn nhu cầu cần điều chuyển'
              : permissionBlocked ? 'Chưa thể tạo TKB: thiếu quyền chuyển cơ sở'
              : unresolvable.length ? 'Chưa thể tạo TKB: có phân công chưa giải quyết'
              : response.status === 'MISSING_DATA'
              ? 'Thiếu dữ liệu để xếp thời khóa biểu'
              : 'Chưa tìm được thời khóa biểu thỏa tất cả quy tắc'}
          </h2>
          <p className="tkb-hint">
            {unresolvable.length ? 'Các phân công bên dưới chưa có lựa chọn giáo viên hợp lệ trong chế độ đang chọn. Chưa có TKB được tạo hoặc lưu.'
              : response.status === 'MISSING_DATA'
              ? 'Yêu cầu hợp lệ nhưng dữ liệu nguồn còn thiếu; hệ thống chưa tạo thời khóa biểu.'
              : 'Hệ thống đã thử xếp nhưng chưa tìm được phương án hợp lệ. Chưa có lịch nào được tạo hoặc lưu.'}
          </p>
          {unresolvable.length > 0 ? <UnresolvableDemand rows={unresolvable} directory={response.directory} capacityShortages={capacityShortages} /> : null}
          {Array.isArray(response.errors) && response.errors.length > 0 ? (
            <ul className="tkb-issue-list" data-testid="empty-errors">
              {response.errors.map((e, i) => (
                <li key={`${e.code}-${i}`}>
                  <code>{e.code}</code> {localizeSchedulingMessage(e.message)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <SolutionList
        solutions={solutions}
        selectedId={gen.selectedSolutionId}
        onSelect={gen.selectSolution}
        onRequestCommit={commit.requestCommit}
        commitState={commitState}
        committed={commit.committed}
      />

      {/* Rendered after the list and before the grid so the two
          "what you are looking at" and "what is saved" answers are
          adjacent. */}
      <CommittedPanel
        schedules={commit.committed}
        onRefresh={onRefreshCommitted}
        refreshing={refreshingCommitted}
      />

      {dialogOpen ? (
        <CommitDialog
          solution={dialogSolution}
          state={commit.state}
          error={commit.error}
          onConfirm={() => commit.confirmCommit(commit.solutionId)}
          onCancel={commit.clearCommitState}
        />
      ) : null}

      {selected ? (
        <section className="tkb-timetable" data-testid="timetable-section">
          <h2>Thời khóa biểu</h2>
          <TransferBalanceSummary solution={selected} directory={response?.directory} />

          <div className="tkb-entity-controls">
            <label className="tkb-control">
              <span>Xem theo</span>
              <select
                value={gen.viewMode}
                onChange={(e) => {
                  const mode = e.target.value;
                  gen.setViewMode(mode);
                  if (mode === 'TEACHER' && !teacherOptions.some((teacher) => teacher.id === gen.entityId)) {
                    gen.setEntity(teacherOptions[0]?.id ?? null);
                  }
                }}
                data-testid="view-mode"
              >
                <option value="CLASS">Lớp</option>
                <option value="TEACHER">Giáo viên</option>
              </select>
            </label>

            <label className="tkb-control">
              <span>{gen.viewMode === 'TEACHER' ? 'Giáo viên' : 'Lớp'}</span>
              <select
                value={gen.entityId ?? ''}
                onChange={(e) => gen.setEntity(e.target.value || null)}
                data-testid="entity-select"
              >
                <option value="">Chọn…</option>
                {(gen.viewMode === 'TEACHER'
                  ? teacherOptions
                  : response?.directory?.classes
                )?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}{gen.viewMode === 'TEACHER' && gen.branchFilter !== 'ALL' && e.homeBranchId && e.homeBranchId !== gen.branchFilter
                      ? ` · Điều chuyển từ ${response?.directory?.branches?.find((branch) => branch.id === e.homeBranchId)?.name ?? 'phân hiệu khác'}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="tkb-control">
              <span>{gen.viewMode === 'TEACHER' ? 'Lọc giáo viên theo phân hiệu' : 'Phân hiệu'}</span>
              <select
                value={gen.branchFilter}
                onChange={(e) => gen.setBranchFilter(e.target.value)}
                data-testid="branch-filter"
              >
                <option value="ALL">Tất cả phân hiệu</option>
                {response?.directory?.branches?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {gen.viewMode === 'TEACHER' ? (
            <p className="tkb-hint" data-testid="teacher-branch-note">
              Danh sách giáo viên gồm giáo viên tại phân hiệu đã chọn và giáo viên được điều chuyển đến đó. TKB bên dưới hiển thị tất cả phân hiệu người này đang dạy.
            </p>
          ) : null}

          <p className="tkb-hint" data-testid="placement-note">
            {placementsNote(response)}
          </p>

          <ScheduleGrid
            days={response?.calendar?.days ?? []}
            placements={selected.placements ?? []}
            mode={gen.viewMode}
            entityId={gen.entityId}
            branchFilter={gen.viewMode === 'TEACHER' ? 'ALL' : gen.branchFilter}
            directory={response?.directory}
          />
        </section>
      ) : null}
    </div>
  );
}

function UnresolvableDemand({ rows, directory, capacityShortages = [] }) {
  const classes = new Map((directory?.classes ?? []).map((row) => [row.id, row.name]));
  const subjects = new Map((directory?.subjects ?? []).map((row) => [row.id, row.name]));
  const branches = new Map((directory?.branches ?? []).map((row) => [row.id, row.name]));
  const periods = rows.reduce((sum, row) => sum + (Number.isFinite(row.requiredPeriods) ? row.requiredPeriods : 0), 0);
  const affectedSubjects = new Set(rows.filter((row) => row.reasonCode === 'SUBJECT_CAPACITY_SHORTAGE').map((row) => row.subjectId));
  const relevantShortages = capacityShortages.filter((shortage) => shortage.subjectIds?.some((id) => affectedSubjects.has(id)));
  const reasons = {
    NO_PERMITTED_TEACHER: 'Có GV đủ chuyên môn, thiếu quyền dạy tại cơ sở này',
    NO_ELIGIBLE_TEACHER: 'Chưa có GV đủ chuyên môn trong chế độ đang chọn',
    BRANCH_MISMATCH: 'Cơ sở phân công khác cơ sở của lớp',
    NO_LOCAL_TEACHER: 'Phân hiệu chưa có GV dạy môn này; cần xét điều chuyển',
    LOCAL_SCHEDULING_LIMIT: 'Chưa xếp được tại phân hiệu chính; cần xử lý bước điều chuyển',
    LOCAL_CAPACITY_REQUIRES_TRANSFER: 'Số tiết vượt số chỗ xếp của GV tại phân hiệu; cần GV điều chuyển được phép',
    SUBJECT_CAPACITY_SHORTAGE: 'Tổng nhu cầu vượt khả năng xếp lịch của nhóm giáo viên đủ chuyên môn',
  };
  return <div data-testid="unresolvable-demands">
    <p><strong>{rows.length} phân công chưa giải quyết{periods > 0 ? ` · ${periods} tiết` : ''}</strong></p>
    <p className="tkb-hint">{relevantShortages.length
      ? 'Nhóm giáo viên đủ chuyên môn không có đủ tiết trống để nhận toàn bộ nhu cầu. Cần bổ sung giáo viên đủ chuyên môn hoặc điều chỉnh lịch khả dụng trước khi tạo lại TKB.'
      : 'Cần xác nhận giáo viên đủ chuyên môn và cơ sở được phép dạy, rồi cập nhật dữ liệu phân công/quyền trước khi tạo lại TKB. Phân hiệu mong muốn là nguyện vọng, không cấp quyền chuyển cơ sở.'}</p>
    {relevantShortages.map((shortage) => {
      const subjectNames = shortage.subjectIds.map((id) => subjects.get(id) ?? id).join(', ');
      return <p className="tkb-hint" data-testid="capacity-shortage" key={shortage.subjectIds.join('|')}>
        {subjectNames}: cần {shortage.requiredPeriods} tiết, lịch khả dụng {shortage.availablePeriods} tiết, thiếu {shortage.shortagePeriods} tiết với {shortage.teacherIds.length} giáo viên đủ chuyên môn.
      </p>;
    })}
    <details>
      <summary>Xem danh sách lớp, môn và cơ sở cần xử lý</summary>
      <div className="tkb-grid-wrap"><table className="tkb-grid">
        <thead><tr><th scope="col">Lớp</th><th scope="col">Môn</th><th scope="col">Cơ sở</th><th scope="col">Số tiết</th><th scope="col">Lý do</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.assignmentId}>
          <td>{classes.get(row.classId) ?? row.classId ?? row.assignmentId}</td>
          <td>{subjects.get(row.subjectId) ?? row.subjectId ?? '—'}</td>
          <td>{branches.get(row.branchId) ?? row.branchId ?? '—'}</td>
          <td>{row.requiredPeriods ?? '—'}</td>
          <td>{reasons[row.reasonCode] ?? 'Chưa có lựa chọn giáo viên đủ chuyên môn và được phép dạy'}</td>
        </tr>)}</tbody>
      </table></div>
    </details>
  </div>;
}

function TransferBalanceSummary({ solution, directory }) {
  const teachers = new Map((directory?.teachers ?? []).map((teacher) => [teacher.id, teacher]));
  const branches = new Map((directory?.branches ?? []).map((branch) => [branch.id, branch.name]));
  const classes = new Map((directory?.classes ?? []).map((classRow) => [classRow.id, classRow.name]));
  const grouped = new Map();
  for (const placement of solution.placements ?? []) {
    const teacher = teachers.get(placement.teacherId);
    const homeBranchId = teacher?.homeBranchId;
    if (!homeBranchId || !placement.branchId || homeBranchId === placement.branchId) continue;
    const key = `${teacher.id}|${homeBranchId}|${placement.branchId}`;
    const row = grouped.get(key) ?? {
      teacherId: teacher.id,
      teacherName: teacher.name,
      homeBranchId,
      branchId: placement.branchId,
      classIds: new Set(),
      periods: 0,
    };
    row.classIds.add(placement.classId);
    row.periods += 1;
    grouped.set(key, row);
  }
  const transfers = [...grouped.values()].sort((a, b) => a.teacherName.localeCompare(b.teacherName));
  const metrics = solution.metrics ?? {};

  return (
    <section className="tkb-scoring" data-testid="transfer-balance-summary">
      <h3>Điều chuyển và cân bằng tải</h3>
      <p className="tkb-hint">
        {transfers.length
          ? `Phương án có ${transfers.length} lượt điều chuyển, tổng ${transfers.reduce((sum, row) => sum + row.periods, 0)} tiết.`
          : 'Phương án này không có giáo viên dạy ngoài phân hiệu chính.'}
        {` Chênh lệch tải giữa giáo viên: ${Number.isFinite(metrics.workloadSpread) ? `${metrics.workloadSpread} tiết` : 'chưa có số liệu'}.`}
        {` Tải cao nhất: ${Number.isFinite(metrics.maxTeacherLoad) ? `${metrics.maxTeacherLoad} tiết` : 'chưa có số liệu'}.`}
      </p>
      {transfers.length > 0 ? (
        <div className="tkb-grid-wrap">
          <table className="tkb-grid" aria-label="Danh sách giáo viên được điều chuyển">
            <thead><tr><th scope="col">Giáo viên</th><th scope="col">Phân hiệu chính</th><th scope="col">Dạy tại</th><th scope="col">Số lớp</th><th scope="col">Số tiết</th></tr></thead>
            <tbody>{transfers.map((row) => (
              <tr key={`${row.teacherId}|${row.branchId}`}>
                <td>{row.teacherName}</td>
                <td>{branches.get(row.homeBranchId) ?? row.homeBranchId}</td>
                <td>{branches.get(row.branchId) ?? row.branchId}</td>
                <td>{row.classIds.size}</td>
                <td>{row.periods}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {solution.metrics?.teacherWorkloads?.length > 0 ? (
        <details>
          <summary>Xem số tiết từng giáo viên</summary>
          <div className="tkb-grid-wrap">
            <table className="tkb-grid" aria-label="Số tiết dạy theo giáo viên">
              <thead><tr><th scope="col">Giáo viên</th><th scope="col">Số tiết</th></tr></thead>
              <tbody>{[...solution.metrics.teacherWorkloads].sort((a, b) => a.periods - b.periods).map((teacher) => (
                <tr key={teacher.teacherId}><td>{teacher.teacherName ?? teacher.teacherId}</td><td>{teacher.periods}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function BranchSchedulingSummary({ result, directory, capacityShortages = [] }) {
  const branches = new Map((directory?.branches ?? []).map((branch) => [branch.id, branch.name]));
  const subjects = new Map((directory?.subjects ?? []).map((subject) => [subject.id, subject.name]));
  const pending = result.pendingAssignments ?? [];
  const pendingPeriods = pending.reduce((sum, row) => sum + row.requiredPeriods, 0);
  return <section className="tkb-empty-state" data-testid="branch-scheduling-summary">
    <h2>Xếp tại phân hiệu chính trước, điều chuyển sau</h2>
    <p><strong>Đã xếp tại phân hiệu chính: {result.localAssignments}/{result.requiredAssignments} phân công · {result.localPeriods}/{result.requiredPeriods} tiết</strong></p>
    <p>Nhu cầu bổ sung sau bước xếp tại chỗ: {pending.length} phân công · {pendingPeriods} tiết.</p>
    <p className="tkb-hint">{result.transferStatus === 'COMPLETE' ? 'Đã xếp đủ toàn bộ nhu cầu. TKB hoàn chỉnh hiển thị bên dưới.'
      : 'Chỉ hiển thị TKB khi đã xếp đủ toàn bộ. Nhu cầu còn thiếu được xét điều chuyển sau khi xếp giáo viên tại phân hiệu chính.'}</p>
    {result.transferStatus === 'INSUFFICIENT_CAPACITY' ? (
      <div className="tkb-hint" data-testid="transfer-capacity-blocker">
        <strong>Chưa thể hoàn tất điều chuyển do thiếu tiết khả dụng.</strong>
        {capacityShortages.map((shortage) => <p key={shortage.subjectIds.join('|')}>
          {shortage.subjectIds.map((id) => subjects.get(id) ?? id).join(', ')}: cần {shortage.requiredPeriods} tiết, lịch giáo viên đủ chuyên môn có {shortage.availablePeriods} tiết, còn thiếu {shortage.shortagePeriods} tiết.
        </p>)}
        <p>Thiếu ma trận di chuyển chỉ làm thời gian đi lại chưa được kiểm tra; không phải nguyên nhân tắt điều chuyển.</p>
      </div>
    ) : null}
    <details><summary>Kết quả xếp tại từng phân hiệu</summary><div className="tkb-grid-wrap"><table className="tkb-grid">
      <thead><tr><th scope="col">Phân hiệu</th><th scope="col">Phân công tại chỗ</th><th scope="col">Tiết tại chỗ</th></tr></thead>
      <tbody>{(result.branches ?? []).map((branch) => <tr key={branch.branchId}>
        <td>{branches.get(branch.branchId) ?? branch.branchId}</td><td>{branch.localAssignments}/{branch.requiredAssignments}</td><td>{branch.localPeriods}/{branch.requiredPeriods}</td>
      </tr>)}</tbody>
    </table></div></details>
  </section>;
}

/**
 * Say what the response actually delivered.
 *
 * `placementDetail` exists because a 10-solution `all` response is
 * ~5 MB. When the backend sends a reduced level, the empty cells in
 * the grid are a direct consequence of the request, and the page
 * reports that instead of letting the user conclude the schedule has
 * holes in it.
 */
function placementsNote(response) {
  const level = response?.placementDetail?.level ?? 'all';
  const included = response?.placementDetail?.includedSolutionRanks ?? [];
  if (level === 'all') {
    return 'Mỗi phương án có đầy đủ các tiết đã xếp.';
  }
  return (
    `Dữ liệu tiết học đang ở mức “${level}”; chỉ phương án ${included.join(', ') || '—'} có lịch chi tiết. `
    + 'Các phương án còn lại chỉ có thể xem điểm. Hãy yêu cầu đầy đủ dữ liệu tiết để xem lưới TKB.'
  );
}
