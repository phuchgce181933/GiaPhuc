import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { request, dateLabel, statusLabel } from "../service";
import { usePermission } from "../../auth/hooks";
import { PERMISSIONS as P } from "../../auth/permissions";
export default function ExamPage() {
  const [catalog, setCatalog] = useState({ subjects: [], categories: [] });
  const [exams, setExams] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: "",
    subjectId: "",
    categoryIds: [],
    startsAt: "",
    endsAt: "",
    durationMinutes: 30,
    password: "",
    questionCount: 10,
  });
  const permission = usePermission();
  const startTime = Date.parse(form.startsAt);
  const endTime = Date.parse(form.endsAt);
  const openMinutes = Math.floor((endTime - startTime) / 60000);
  const timeErrors = {};
  if (form.startsAt && form.endsAt && endTime <= startTime) timeErrors.endsAt = 'Giờ kết thúc phải sau giờ bắt đầu.';
  else if (form.endsAt && endTime <= Date.now()) timeErrors.endsAt = 'Giờ kết thúc phải ở tương lai.';
  if (!Number.isInteger(form.durationMinutes) || form.durationMinutes < 1 || form.durationMinutes > 300) timeErrors.durationMinutes = 'Nhập số phút nguyên từ 1 đến 300.';
  else if (Number.isFinite(openMinutes) && openMinutes > 0 && form.durationMinutes > openMinutes) timeErrors.durationMinutes = `Lịch chỉ mở ${openMinutes} phút. Thời gian làm bài không được vượt ${openMinutes} phút.`;
  const change = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  async function load() {
    try {
      const [c, e] = await Promise.all([
        request("/catalog"),
        request("/exams"),
      ]);
      setCatalog(c);
      setExams(e);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function create(e) {
    e.preventDefault();
    if (Object.keys(timeErrors).length) { setError(Object.values(timeErrors).join(' ')); return; }
    setBusy(true);
    setError("");
    try {
      const result = await request("/exams", {
        method: "POST",
        data: {
          ...form,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: new Date(form.endsAt).toISOString(),
        },
      });
      setNotice(
        `Đã lên lịch. Đường dẫn học sinh: ${window.location.origin}/tests/${result.slug}`,
      );
      change("password", "");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pt-content">
      {error && (
        <p role="alert" className="pt-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pt-notice">
          {notice}
        </p>
      )}
      {permission.hasAll([P.PROGRESS_SCHEDULE]) && (
        <form className="pt-card" onSubmit={create}>
          <h2>Lên lịch kiểm tra</h2>
          <p className="pt-muted">
            Đề được chốt từ ngân hàng khi tạo lịch. Mỗi học sinh làm cùng bộ câu
            hỏi. Thời gian hiển thị theo thiết bị, máy chủ quyết định mở/khóa.
          </p>
          <div className="pt-form-grid">
            <label>
              Tên bài kiểm tra
              <input
                required
                maxLength={120}
                value={form.title}
                onChange={(e) => change("title", e.target.value)}
              />
            </label>
            <label>
              Môn học
              <select
                required
                value={form.subjectId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    subjectId: e.target.value,
                    categoryIds: [],
                  }))
                }
              >
                <option value="">Chọn môn…</option>
                {catalog.subjects.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bắt đầu
              <input
                type="datetime-local"
                required
                value={form.startsAt}
                onChange={(e) => change("startsAt", e.target.value)}
              />
            </label>
            <label>
              Kết thúc
              <input
                type="datetime-local"
                required
                value={form.endsAt}
                min={form.startsAt || undefined}
                aria-invalid={!!timeErrors.endsAt}
                onChange={(e) => change("endsAt", e.target.value)}
              />
              {timeErrors.endsAt && <small className="pt-error-text">{timeErrors.endsAt}</small>}
            </label>
            <label>
              Thời gian làm bài (phút)
              <input
                type="number"
                min="1"
                max={openMinutes > 0 ? Math.min(300, openMinutes) : 300}
                step="1"
                aria-invalid={!!timeErrors.durationMinutes}
                required
                value={form.durationMinutes}
                onChange={(e) =>
                  change("durationMinutes", Number(e.target.value))
                }
              />
              {timeErrors.durationMinutes && <small className="pt-error-text">{timeErrors.durationMinutes}</small>}
            </label>
            <label>
              Số câu hỏi
              <input
                type="number"
                min="1"
                max="100"
                required
                value={form.questionCount}
                onChange={(e) =>
                  change("questionCount", Number(e.target.value))
                }
              />
            </label>
            <label>
              Mật khẩu kiểm tra
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={4}
                maxLength={100}
                value={form.password}
                onChange={(e) => change("password", e.target.value)}
              />
            </label>
          </div>
          <fieldset>
            <legend>Danh mục sẽ kiểm tra</legend>
            <div className="pt-checkbox-grid">
              {catalog.categories
                .filter((c) => c.subjectId === form.subjectId)
                .map((c) => (
                  <label key={c._id}>
                    <input
                      type="checkbox"
                      checked={form.categoryIds.includes(c._id)}
                      onChange={(e) =>
                        change(
                          "categoryIds",
                          e.target.checked
                            ? [...form.categoryIds, c._id]
                            : form.categoryIds.filter((id) => id !== c._id),
                        )
                      }
                    />
                    {c.name}
                  </label>
                ))}
            </div>
            {!form.subjectId && (
              <p className="pt-muted">Chọn môn để xem danh mục.</p>
            )}
          </fieldset>
          <button
            className="pt-primary"
            disabled={busy || !form.categoryIds.length || Object.keys(timeErrors).length > 0}
          >
            {busy ? "Đang tạo…" : "Tạo lịch & đường dẫn"}
          </button>
        </form>
      )}
      <div className="pt-section-title">
        <h2>Các bài kiểm tra</h2>
        <button onClick={load}>Tải lại</button>
      </div>
      {!exams.length && <p className="pt-empty">Chưa có lịch kiểm tra.</p>}
      <div className="pt-catalog-grid">
        {exams.map((exam) => (
          <article className="pt-card" key={exam._id}>
            <span className={`pt-badge pt-state-${exam.state.toLowerCase()}`}>
              {statusLabel(exam.state)}
            </span>
            <h3>{exam.title}</h3>
            <p>
              {exam.subjectName} · {exam.categoryNames.join(", ")}
            </p>
            <p className="pt-muted">
              {dateLabel(exam.startsAt)} → {dateLabel(exam.endsAt)}
              <br />
              {exam.durationMinutes} phút làm bài
            </p>
            <div className="pt-linkbox">
              {window.location.origin}/tests/{exam.slug}
            </div>
            <div className="pt-actions">
              <a href={`/tests/${exam.slug}`} target="_blank" rel="noreferrer">
                Mở đường dẫn
              </a>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `${window.location.origin}/tests/${exam.slug}`,
                    );
                    setNotice("Đã sao chép đường dẫn.");
                  } catch {
                    setError(
                      "Không thể sao chép tự động. Hãy chọn đường dẫn phía trên.",
                    );
                  }
                }}
              >
                Sao chép
              </button>
              {permission.hasAll([P.PROGRESS_RESULT]) && (
                <Link to={`/progress-test/exams/${exam._id}/results`}>
                  Xem kết quả
                </Link>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
