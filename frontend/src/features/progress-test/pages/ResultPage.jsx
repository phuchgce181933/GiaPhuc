import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { request, dateLabel, statusLabel } from "../service";
import MathText from "../components/MathText";
import { usePermission } from "../../auth/hooks";
import { PERMISSIONS as P } from "../../auth/permissions";
const EVENT_LABELS = {
  TAB_HIDDEN: "Ẩn trang / chuyển tab",
  WINDOW_BLUR: "Mất tiêu điểm cửa sổ",
  PAGE_EXIT: "Rời / tải lại trang",
  RETURN: "Quay lại bài",
  FULLSCREEN_EXIT: "Thoát toàn màn hình",
};
export default function ResultPage() {
  const { id } = useParams();
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [grades, setGrades] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const permission = usePermission();
  async function load() {
    try {
      setItems(await request(`/exams/${id}/results`));
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, [id]);
  async function detail(attempt) {
    try {
      const result = await request(`/exams/${id}/results/${attempt._id}`);
      setSelected(result[0]);
      setGrades(result[0]?.grades ?? {});
    } catch (e) {
      setError(e.message);
    }
  }
  async function grade(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await request(`/attempts/${selected._id}/grade`, {
        method: "PATCH",
        data: { grades },
      });
      await load();
      await detail(selected);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!permission.hasAll([P.PROGRESS_RESULT]))
    return <p className="pt-error">Bạn chưa có quyền xem kết quả.</p>;
  return (
    <section className="pt-content">
      <Link to="/progress-test/exams">← Lịch kiểm tra</Link>
      {error && (
        <p role="alert" className="pt-error">
          {error}
        </p>
      )}
      <div className="pt-section-title">
        <h2>Kết quả & nhật ký bài làm</h2>
        <button onClick={load}>Tải lại</button>
      </div>
      <p className="pt-muted">
        Tên do học sinh tự khai báo. Sự kiện mất tiêu điểm là dấu hiệu cần xem
        xét, không tự động kết luận gian lận.
      </p>
      <div className="pt-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Học sinh</th>
              <th>Bắt đầu</th>
              <th>Trạng thái</th>
              <th>Điểm</th>
              <th>Sự kiện rời bài</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a._id}>
                <td>{a.name}</td>
                <td>{dateLabel(a.startedAt)}</td>
                <td>{statusLabel(a.status)}</td>
                <td>
                  {a.score ?? "—"} / {a.maxScore}
                </td>
                <td>{a.eventCount ?? 0}</td>
                <td>
                  <button onClick={() => detail(a)}>Chi tiết bài làm</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && (
        <p className="pt-empty">Chưa có học sinh bắt đầu kiểm tra.</p>
      )}
      {selected && (
        <div className="pt-card">
          <div className="pt-section-title">
            <h2>Bài làm: {selected.name}</h2>
            <button onClick={() => setSelected(null)}>Đóng</button>
          </div>
          <p>
            {statusLabel(selected.status)} · Điểm {selected.score ?? "—"} /{" "}
            {selected.maxScore}
          </p>
          <form onSubmit={grade}>
            {selected.questions.map((q, index) => (
              <section className="pt-answer-detail" key={q.id}>
                <h3>
                  Câu {index + 1} · {q.points} điểm
                </h3>
                <MathText text={q.text} />
                {q.type === "choice" ? (
                  <>
                    <p>
                      Đã chọn:{" "}
                      <MathText
                        text={
                          q.options[selected.answers?.[q.id]] ?? "Chưa trả lời"
                        }
                      />
                    </p>
                    <p className="pt-notice">
                      Đáp án đúng:{" "}
                      <MathText text={q.options[q.correctOption]} />
                    </p>
                  </>
                ) : (
                  <>
                    <p className="pt-saved-essay">
                      {selected.answers?.[q.id] || "Chưa trả lời"}
                    </p>
                    {permission.hasAll([P.PROGRESS_GRADE]) &&
                      selected.status !== "IN_PROGRESS" && (
                        <label>
                          Điểm tự luận / {q.points}
                          <input
                            type="number"
                            min="0"
                            max={q.points}
                            step="0.1"
                            value={grades[q.id] ?? ""}
                            onChange={(e) =>
                              setGrades((g) => {
                                const next = { ...g };
                                if (e.target.value === "") delete next[q.id];
                                else next[q.id] = Number(e.target.value);
                                return next;
                              })
                            }
                          />
                        </label>
                      )}
                  </>
                )}
                {q.explanation && (
                  <details>
                    <summary>Giải thích đã lưu</summary>
                    <MathText text={q.explanation} />
                  </details>
                )}
              </section>
            ))}
            {permission.hasAll([P.PROGRESS_GRADE]) &&
              selected.status !== "IN_PROGRESS" &&
              selected.questions.some((q) => q.type === "essay") && (
                <button className="pt-primary" disabled={busy}>
                  Lưu điểm tự luận
                </button>
              )}
          </form>
          <h3>Nhật ký hoạt động</h3>
          <ul className="pt-event-list">
            {selected.events.map((event) => (
              <li key={event.id}>
                {dateLabel(event.receivedAt)} ·{" "}
                {EVENT_LABELS[event.type] ?? event.type}
              </li>
            ))}
          </ul>
          {!selected.events.length && (
            <p className="pt-muted">Chưa ghi nhận sự kiện.</p>
          )}
          <details>
            <summary>
              Lịch sử lưu đáp án ({selected.answerHistory.length} lượt)
            </summary>
            {selected.answerHistory.map((h, index) => (
              <div className="pt-history" key={index}>
                <strong>{dateLabel(h.receivedAt)}</strong>
                {selected.questions.map((q, i) => (
                  <p key={q.id}>
                    Câu {i + 1}:{" "}
                    {q.type === "choice"
                      ? (q.options[h.answers?.[q.id]] ?? "Chưa trả lời")
                      : (h.answers?.[q.id] ?? "Chưa trả lời")}
                  </p>
                ))}
              </div>
            ))}
          </details>
        </div>
      )}
    </section>
  );
}
