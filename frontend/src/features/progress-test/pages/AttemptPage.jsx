import { confirmDialog } from "../../../components/common/AppDialog";
import { useEffect, useRef, useState } from "react";
import { request, statusLabel } from "../service";
import { env } from "../../../lib/env";
import MathText from "../components/MathText";
import { eventId } from "../utils";
export default function AttemptPage({ token, onInvalid }) {
  const [attempt, setAttempt] = useState(null);
  const [answers, setAnswers] = useState({});
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState("");
  const [busy, setBusy] = useState(false);
  const attemptRef = useRef(null);
  const answerRef = useRef({});
  const queue = useRef(Promise.resolve());
  const dirty = useRef(false);
  const offset = useRef(0);
  const alive = useRef(true);
  const submitRef = useRef(false);
  const draftKey = `pt-draft-${token}`;
  async function read() {
    const out = await request("/attempt", { publicAccess: true, token });
    attemptRef.current = out;
    offset.current = new Date(out.serverTime).getTime() - Date.now();
    if (alive.current) setAttempt(out);
    return out;
  }
  function enqueue(action) {
    const next = queue.current.catch(() => {}).then(action);
    queue.current = next;
    return next;
  }
  async function persist() {
    if (!dirty.current || attemptRef.current?.status !== "IN_PROGRESS") return;
    const snapshot = { ...answerRef.current };
    setSaveState("Đang lưu…");
    try {
      let out;
      try {
        out = await request("/attempt/answers", {
          publicAccess: true,
          token,
          method: "PUT",
          data: { revision: attemptRef.current.revision, answers: snapshot },
        });
      } catch (e) {
        if (e.status !== 409) throw e;
        const current = await read();
        if (current.status !== "IN_PROGRESS") {
          dirty.current = false;
          return;
        }
        out = await request("/attempt/answers", {
          publicAccess: true,
          token,
          method: "PUT",
          data: { revision: current.revision, answers: snapshot },
        });
      }
      attemptRef.current.revision = out.revision;
      if (JSON.stringify(answerRef.current) === JSON.stringify(snapshot))
        dirty.current = false;
      if (alive.current) {
        setSaveState("Đã lưu trên máy chủ");
        setError("");
      }
    } catch (e) {
      if (alive.current) {
        setSaveState("Chưa lưu · sẽ thử lại");
        setError(e.message);
      }
      throw e;
    }
  }
  async function finish(auto = false) {
    if (submitRef.current) return;
    if (
      !auto &&
      !await confirmDialog("Nộp bài? Sau khi nộp, bạn không thể sửa đáp án.")
    )
      return;
    submitRef.current = true;
    setBusy(true);
    try {
      await enqueue(async () => {
        await persist();
        const out = await request("/attempt/submit", {
          publicAccess: true,
          token,
          method: "POST",
        });
        attemptRef.current = out;
        setAttempt(out);
        sessionStorage.removeItem(draftKey);
      });
    } catch (e) {
      setError(e.message);
      submitRef.current = false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    read()
      .then((out) => {
        let draft = null;
        try {
          draft = JSON.parse(sessionStorage.getItem(draftKey));
        } catch {
          /* ignore an unreadable local draft */
        }
        const restored =
          out.status === "IN_PROGRESS" && draft
            ? { ...out.answers, ...draft }
            : (out.answers ?? {});
        answerRef.current = restored;
        setAnswers(restored);
        dirty.current = out.status === "IN_PROGRESS" && !!draft;
      })
      .catch((e) => {
        setError(e.message);
        if (e.status === 401) onInvalid();
      });
    const autosave = setInterval(() => {
      if (dirty.current && attemptRef.current?.status === "IN_PROGRESS")
        enqueue(persist).catch(() => {});
    }, 2000);
    const heartbeat = setInterval(() => {
      enqueue(read).catch((e) => setError(e.message));
    }, 20000);
    function record(type) {
      if (attemptRef.current?.status !== "IN_PROGRESS") return;
      const event = { id: eventId(), type, detail: "" };
      fetch(`${env.API_BASE_URL}/progress-test/public/attempt/events`, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "X-Attempt-Token": token,
        },
        body: JSON.stringify(event),
      }).catch(() =>
        setError(
          "Mất kết nối. Đáp án được giữ tạm trên thiết bị; hãy kết nối lại trước khi hết giờ.",
        ),
      );
    }
    const visibility = () => record(document.hidden ? "TAB_HIDDEN" : "RETURN");
    const blur = () => record("WINDOW_BLUR");
    const focus = () => record("RETURN");
    const exit = () => record("PAGE_EXIT");
    const fullscreen = () => {
      if (!document.fullscreenElement) record("FULLSCREEN_EXIT");
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("pagehide", exit);
    document.addEventListener("fullscreenchange", fullscreen);
    const guard = (e) => {
      if (attemptRef.current?.status === "IN_PROGRESS") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      alive.current = false;
      clearInterval(autosave);
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pagehide", exit);
      window.removeEventListener("beforeunload", guard);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, [token]);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = attemptRef.current;
      if (!current) return;
      const seconds = Math.max(
        0,
        Math.ceil(
          (new Date(current.deadline).getTime() - Date.now() - offset.current) /
            1000,
        ),
      );
      setRemaining(seconds);
      if (!seconds && current.status === "IN_PROGRESS") finish(true);
    }, 1000);
    return () => clearInterval(timer);
  }, [token]);
  function change(qid, value) {
    const next = { ...answerRef.current, [qid]: value };
    answerRef.current = next;
    dirty.current = true;
    setAnswers(next);
    setSaveState("Chờ lưu…");
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {
      setError(
        "Không thể giữ bản nháp trên thiết bị. Giữ kết nối để lưu trên máy chủ.",
      );
    }
  }
  if (!attempt)
    return (
      <main className="pt-app pt-student">
        <p>{error || "Đang mở bài làm…"}</p>
      </main>
    );
  if (attempt.status !== "IN_PROGRESS")
    return (
      <main className="pt-app pt-student">
        <section className="pt-card">
          <span className="pt-badge">{statusLabel(attempt.status)}</span>
          <h1>Đã ghi nhận bài làm</h1>
          <p>{attempt.name}</p>
          <p className="pt-result-score">
            {attempt.score ?? 0} / {attempt.maxScore} điểm
          </p>
          {attempt.status === "PENDING_REVIEW" && (
            <p>
              Điểm hiện tại là điểm trắc nghiệm. Giáo viên sẽ chấm phần tự luận.
            </p>
          )}
          <a href="/tests">Về danh sách bài kiểm tra</a>
        </section>
      </main>
    );
  const answered = attempt.questions.filter(
    (q) =>
      answers[q.id] !== undefined &&
      answers[q.id] !== null &&
      answers[q.id] !== "",
  ).length;
  return (
    <main className="pt-app pt-student">
      <header className="pt-exam-bar">
        <div>
          <strong>{attempt.name}</strong>
          <span>
            {answered}/{attempt.questions.length} câu đã trả lời
          </span>
        </div>
        <div>
          <strong
            className={remaining < 60 ? "pt-error-text" : ""}
            aria-label="Thời gian còn lại"
          >
            {Math.floor(remaining / 60)}:
            {String(remaining % 60).padStart(2, "0")}
          </strong>
          <span role="status">{saveState || "Bài làm tự lưu mỗi 2 giây"}</span>
        </div>
        <button className="pt-primary" disabled={busy} onClick={() => finish()}>
          Nộp bài
        </button>
      </header>
      {error && (
        <p role="alert" className="pt-error">
          {error}
        </p>
      )}
      <p className="pt-muted">
        Giữ trang mở trong lúc làm bài. Việc chuyển tab/rời trang được ghi vào
        nhật ký.
      </p>
      <nav className="pt-question-nav" aria-label="Chuyển câu hỏi">
        {attempt.questions.map((q, index) => (
          <a
            className={
              answers[q.id] != null && answers[q.id] !== "" ? "answered" : ""
            }
            key={q.id}
            href={`#question-${q.id}`}
          >
            {index + 1}
          </a>
        ))}
      </nav>
      {attempt.questions.map((q, index) => (
        <article
          id={`question-${q.id}`}
          className="pt-card pt-student-question"
          key={q.id}
        >
          <h2>
            Câu {index + 1} <span className="pt-muted">· {q.points} điểm</span>
          </h2>
          <MathText text={q.text} />
          {q.type === "choice" ? (
            <fieldset>
              <legend className="pt-sr-only">
                Chọn đáp án câu {index + 1}
              </legend>
              {q.options.map((option, i) => (
                <label
                  key={i}
                  className={`pt-choice ${answers[q.id] === i ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name={q.id}
                    checked={answers[q.id] === i}
                    onChange={() => change(q.id, i)}
                  />
                  <strong>{String.fromCharCode(65 + i)}.</strong>
                  <MathText text={option} />
                </label>
              ))}
            </fieldset>
          ) : (
            <label>
              Câu trả lời tự luận
              <textarea
                rows={6}
                maxLength={10000}
                value={answers[q.id] ?? ""}
                onChange={(e) => change(q.id, e.target.value)}
                placeholder="Nhập bài làm (có thể dùng ký hiệu toán)…"
              />
            </label>
          )}
        </article>
      ))}
      <div className="pt-actions">
        <button className="pt-primary" disabled={busy} onClick={() => finish()}>
          {busy ? "Đang nộp…" : "Nộp bài kiểm tra"}
        </button>
      </div>
    </main>
  );
}
