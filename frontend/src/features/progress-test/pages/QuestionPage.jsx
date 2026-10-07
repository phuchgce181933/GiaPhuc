import { confirmDialog } from "../../../components/common/AppDialog";
import { useEffect, useState } from "react";
import { request } from "../service";
import MathEditor from "../components/MathEditor";
import MathText from "../components/MathText";
const blank = {
  subjectId: "",
  categoryId: "",
  type: "choice",
  text: "",
  options: ["", "", "", ""],
  correctOption: 0,
  explanation: "",
  points: 1,
};
export default function QuestionPage() {
  const [catalog, setCatalog] = useState({ subjects: [], categories: [] });
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [list, setList] = useState({ items: [], total: 0, page: 1 });
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showMathTools, setShowMathTools] = useState(false);
  const change = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  async function load() {
    try {
      setList(
        await request(
          `/questions?page=${page}&subjectId=${subject}&categoryId=${category}`,
        ),
      );
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    request("/catalog")
      .then(setCatalog)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [subject, category, page]);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = {
        ...form,
        ...(form.type === "essay" ? { options: [], correctOption: null } : {}),
      };
      await request(`/questions${editing ? `/${editing}` : ""}`, {
        method: editing ? "PATCH" : "POST",
        data,
      });
      setForm({
        ...blank,
        subjectId: form.subjectId,
        categoryId: form.categoryId,
      });
      setEditing(null);
      setNotice("Đã lưu câu hỏi vào ngân hàng.");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function edit(q) {
    setEditing(q._id);
    setForm({
      subjectId: q.subjectId,
      categoryId: q.categoryId,
      type: q.type,
      text: q.text,
      options: q.options ?? [],
      correctOption: q.correctOption ?? 0,
      explanation: q.explanation ?? "",
      points: q.points,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function remove(q) {
    if (
      !await confirmDialog(
        "Xóa câu hỏi khỏi ngân hàng? Các đề đã lên lịch vẫn giữ bản câu hỏi cũ.",
      )
    )
      return;
    try {
      await request(`/questions/${q._id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e.message);
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
      <form className="pt-card pt-question-editor" onSubmit={save}>
        <div className="pt-section-title"><h2>{editing ? "Sửa câu hỏi" : "Soạn câu hỏi"}</h2><button type="button" aria-pressed={showMathTools} onClick={() => setShowMathTools(value => !value)}>{showMathTools ? 'Tắt công cụ toán' : 'Bật công cụ toán'}</button></div>
        <div className="pt-form-grid">
          <label>
            Môn học
            <select
              required
              value={form.subjectId}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  subjectId: e.target.value,
                  categoryId: "",
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
            Danh mục
            <select
              required
              value={form.categoryId}
              onChange={(e) => change("categoryId", e.target.value)}
            >
              <option value="">Chọn danh mục…</option>
              {catalog.categories
                .filter((c) => c.subjectId === form.subjectId)
                .map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Loại câu hỏi
            <select
              value={form.type}
              onChange={(e) => change("type", e.target.value)}
            >
              <option value="choice">Trắc nghiệm · một đáp án</option>
              <option value="essay">Tự luận</option>
            </select>
          </label>
          <label>
            Điểm câu hỏi
            <input
              type="number"
              min="0.1"
              max="100"
              step="0.1"
              required
              value={form.points}
              onChange={(e) => change("points", Number(e.target.value))}
            />
          </label>
        </div>
        <MathEditor showTools={showMathTools}
          label="Nội dung câu hỏi"
          required
          value={form.text}
          onChange={(value) => change("text", value)}
        />
        {form.type === "choice" && (
          <fieldset>
            <legend>Lựa chọn và đáp án đúng</legend>
            <div className="pt-options">
              {form.options.map((option, i) => (
                <div key={i} className="pt-option-editor pt-option-math">
                  <input
                    type="radio"
                    name="correct"
                    checked={form.correctOption === i}
                    onChange={() => change("correctOption", i)}
                    aria-label={`Chọn ${String.fromCharCode(65 + i)} là đáp án đúng`}
                  />
                  <span>{String.fromCharCode(65 + i)}</span>
                  <MathEditor showTools={showMathTools}
                    label={`Nội dung lựa chọn ${String.fromCharCode(65 + i)}`}
                    required
                    value={option}
                    onChange={(value) =>
                      change(
                        "options",
                        form.options.map((v, j) =>
                          j === i ? value : v,
                        ),
                      )
                    }
                  />
                </div>
              ))}
            </div>
            <div className="pt-actions">
              <button
                type="button"
                disabled={form.options.length >= 8}
                onClick={() => change("options", [...form.options, ""])}
              >
                Thêm lựa chọn
              </button>
              <button
                type="button"
                disabled={form.options.length <= 2}
                onClick={() => {
                  change("options", form.options.slice(0, -1));
                  if (form.correctOption >= form.options.length - 1)
                    change("correctOption", 0);
                }}
              >
                Bớt lựa chọn
              </button>
            </div>
          </fieldset>
        )}
        <MathEditor showTools={showMathTools}
          label="Giải thích (không bắt buộc, được lưu kèm câu hỏi)"
          value={form.explanation}
          onChange={(value) => change("explanation", value)}
        />
        <div className="pt-actions">
          <button className="pt-primary" disabled={busy}>
            {busy ? "Đang lưu…" : "Lưu câu hỏi"}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setForm(blank);
              }}
            >
              Hủy sửa
            </button>
          )}
        </div>
      </form>
      <div className="pt-section-title">
        <h2>Ngân hàng câu hỏi</h2>
        <span>{list.total} câu hỏi</span>
      </div>
      <div className="pt-filters">
        <label>
          Môn
          <select
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setCategory("");
              setPage(1);
            }}
          >
            <option value="">Tất cả môn</option>
            {catalog.subjects.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Danh mục
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Tất cả danh mục</option>
            {catalog.categories
              .filter((c) => !subject || c.subjectId === subject)
              .map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {list.items.map((q) => (
        <article className="pt-card" key={q._id}>
          <div className="pt-section-title">
            <span className="pt-badge">
              {q.type === "choice" ? "Trắc nghiệm" : "Tự luận"} · {q.points}{" "}
              điểm ·{" "}
              {catalog.categories.find((c) => c._id === q.categoryId)?.name}
            </span>
            <div className="pt-actions">
              <button onClick={() => edit(q)}>Sửa</button>
              <button onClick={() => remove(q)}>Xóa</button>
            </div>
          </div>
          <MathText text={q.text} />
          {q.type === "choice" && (
            <ul>
              {q.options.map((option, i) => (
                <li key={i}>
                  {i === q.correctOption ? "✓ " : ""}
                  <MathText text={option} />
                </li>
              ))}
            </ul>
          )}
          {q.explanation && (
            <details>
              <summary>Giải thích</summary>
              <MathText text={q.explanation} />
            </details>
          )}
        </article>
      ))}
      {!list.items.length && (
        <p className="pt-empty">Chưa có câu hỏi trong bộ lọc này.</p>
      )}
      <div className="pt-actions">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Trang trước
        </button>
        <span>
          Trang {page} / {Math.max(1, Math.ceil(list.total / 20))}
        </span>
        <button
          disabled={page * 20 >= list.total}
          onClick={() => setPage((p) => p + 1)}
        >
          Trang sau
        </button>
      </div>
    </section>
  );
}
