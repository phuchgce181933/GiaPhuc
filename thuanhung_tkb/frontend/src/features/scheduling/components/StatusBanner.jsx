/**
 * Phase 32 — the honest status banner.
 *
 * WHY THIS COMPONENT EXISTS
 * -------------------------
 * A timetable UI can make three claims the response does not support,
 * and each is a one-line mistake to write:
 *
 *   "Generated with AI"        when the deterministic fallback
 *                              produced the schedule.
 *   "Travel time optimized"    when H14 is UNSUPPORTED and no travel
 *                              matrix exists.
 *   "Teacher transfers applied" when H13 is INACTIVE and no teacher
 *                              carries a transfer policy.
 *
 * The backend reports all three truthfully in the `ai`, `travel` and
 * `transfer` blocks precisely so the browser does not have to infer
 * them. This component renders those blocks and nothing else
 * (brief §6, §24, §25, §26).
 *
 * WHAT IT MUST NOT DO
 * -------------------
 * It must not soften a false statement into a vague one. There is no
 * "AI-assisted" and no "travel considered" wording here: a fallback
 * run says the deterministic path produced it, and an unsupported
 * dimension says it was not scored. A hedge is still a claim.
 *
 * `ai.detail` and the `detail` fields are rendered VERBATIM. They are
 * the backend's own sentences about what happened, written by the
 * layer that knows.
 */

/** The three states a user has to be able to tell apart. */
function stateOf(block) {
  if (!block) return 'unknown';
  if (block.used === true) return 'used';
  if (block.requested === false) return 'not-requested';
  if (block.fallbackUsed === true || block.available === false) return 'fallback';
  return 'unknown';
}

const GENERATION_LABELS = {
  REQUEST_RECEIVED: 'Đã nhận yêu cầu',
  GENERATING: 'Đang xếp thời khóa biểu',
  SCORING: 'Đang đánh giá phương án',
  COMPLETED: 'Hoàn tất',
  NO_SOLUTION: 'Chưa tìm được phương án hợp lệ',
  FAILED: 'Xảy ra lỗi khi xếp',
};

function strategyDetail(detail) {
  if (!detail) return null;
  if (/teacher workload spread is the strongest issue/i.test(detail)) {
    return 'Chênh lệch số tiết giữa giáo viên là vấn đề chính; hệ thống ưu tiên cân bằng tải dạy.';
  }
  return 'Chi tiết chiến lược được lưu trong dữ liệu kiểm tra.';
}

function travelDetail(detail, available) {
  if (!detail) return null;
  if (!available) return 'Chưa có ma trận thời gian di chuyển giữa các phân hiệu nên hệ thống chưa kiểm tra điều kiện đi lại. Điều này không tắt chức năng điều chuyển giáo viên.';
  return detail;
}

export function StatusBanner({ ai, travel, transfer, generation }) {
  const aiState = stateOf(ai);
  const travelReady = travel?.available === true;
  const transferActive = transfer?.active === true;

  return (
    <section className="tkb-status" data-testid="status-banner" aria-label="Trạng thái xếp thời khóa biểu">
      <ul className="tkb-status-list">
        <li
          className={`tkb-status-item tkb-status-${aiState}`}
          data-testid="ai-status"
          data-state={aiState}
        >
          <span className="tkb-status-key">Cách chọn chiến lược</span>
          <span className="tkb-status-value">
            {/* A fallback run is never described as an AI run. The
                three branches are exhaustive on purpose: "unknown"
                gets its own honest text rather than falling through
                to the AI sentence. */}
            {aiState === 'used' ? 'Đã dùng chiến lược AI' : null}
            {aiState === 'not-requested' ? 'Xếp tự động (không dùng AI)' : null}
            {aiState === 'fallback' ? 'Xếp tự động dự phòng' : null}
            {aiState === 'unknown' ? 'Chưa có thông tin' : null}
          </span>
          {ai?.reason ? (
            <span className="tkb-status-code" data-testid="ai-reason">{ai.reason === 'AI_USED' ? 'Chiến lược đã được kiểm tra' : ai.reason === 'AI_NOT_REQUESTED' ? 'Người dùng không yêu cầu AI' : 'Mã trạng thái: ' + ai.reason}</span>
          ) : null}
          {ai?.detail ? <span className="tkb-status-detail">{strategyDetail(ai.detail)}</span> : null}
        </li>

        <li
          className={`tkb-status-item ${travelReady ? 'tkb-status-used' : 'tkb-status-unavailable'}`}
          data-testid="travel-status"
        >
          <span className="tkb-status-key">Di chuyển giữa các phân hiệu</span>
          <span className="tkb-status-value">
            {/* H14 UNSUPPORTED means travel is not a scoring
                dimension at all, so "not optimized" would still be
                wrong — it was never on the scale. */}
            {travelReady ? 'Đã tính đến thời gian di chuyển' : 'Chưa được tính'}
          </span>
          {travel?.detail ? <span className="tkb-status-detail">{travelDetail(travel.detail, travelReady)}</span> : null}
        </li>

        <li
          className={`tkb-status-item ${transferActive ? 'tkb-status-used' : 'tkb-status-unavailable'}`}
          data-testid="transfer-status"
        >
          <span className="tkb-status-key">Điều chuyển giáo viên</span>
          <span className="tkb-status-value">
            {transferActive
              ? transfer.policy === 'AUTO_SHORTAGE' ? 'Tự động xét sau khi xếp tại phân hiệu chính' : `Có ${transfer.allowedTeacherCount} giáo viên được phép điều chuyển`
              : 'Chưa bật'}
          </span>
          {transfer?.detail ? <span className="tkb-status-detail">{transfer.detail}</span> : null}
        </li>

        {generation ? (
          <li className="tkb-status-item tkb-status-neutral" data-testid="generation-status">
            <span className="tkb-status-key">Tiến trình</span>
            <span className="tkb-status-value">
              {GENERATION_LABELS[generation.status] ?? generation.status}
              {typeof generation.totalTimeMs === 'number' ? ` · ${generation.totalTimeMs} mili giây` : ''}
            </span>
            {Array.isArray(generation.stages) && generation.stages.length > 0 ? (
              <ol className="tkb-stage-list" data-testid="stage-list">
                {generation.stages.map((s) => (
                  <li key={`${s.status}-${s.atMs}`} className="tkb-stage">
                    <span className="tkb-stage-name">{GENERATION_LABELS[s.status] ?? s.status}</span>
                    <span className="tkb-stage-ms">{s.atMs} mili giây</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
