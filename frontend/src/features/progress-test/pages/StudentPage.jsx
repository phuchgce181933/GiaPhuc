import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { request, dateLabel } from "../service";
import AttemptPage from "./AttemptPage";
import "../progress-test.css";
export default function StudentPage() {
  const { slug } = useParams();
  const [exam, setExam] = useState(null);
  const [exams, setExams] = useState([]);
  const [token, setToken] = useState(() =>
    slug ? (sessionStorage.getItem(`pt-token-${slug}`) ?? "") : "",
  );
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      const out = await request(slug ? `/exams/${slug}` : "/exams", {
        publicAccess: true,
      });
      if (slug) setExam(out);
      else setExams(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    setLoading(true);
    setExam(null);
    setError("");
    setToken(slug ? (sessionStorage.getItem(`pt-token-${slug}`) ?? "") : "");
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [slug]);
  useEffect(() => {
    setVerified(false);
    setPassword("");
  }, [slug]);
  async function verify(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request(`/exams/${slug}/verify`, {
        publicAccess: true,
        method: "POST",
        data: { password },
      });
      setVerified(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function join(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await request(`/exams/${slug}/join`, {
        publicAccess: true,
        method: "POST",
        data: { name, password },
      });
      sessionStorage.setItem(`pt-token-${slug}`, result.token);
      setToken(result.token);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (token)
    return (
      <AttemptPage
        token={token}
        onInvalid={() => {
          sessionStorage.removeItem(`pt-token-${slug}`);
          setToken("");
        }}
      />
    );
  return (
    <main className="pt-app pt-student">
      <header className="pt-heading">
        <span className="pt-eyebrow">PROGRESS TEST</span>
        <h1>
          {slug ? (exam?.title ?? "Bài kiểm tra") : "Bài kiểm tra đang mở"}
        </h1>
        <p>
          Chuẩn bị sẵn sàng, kiểm tra kết nối và làm bài trên thiết bị của bạn.
        </p>
      </header>
      {error && (
        <p role="alert" className="pt-error">
          {error}
        </p>
      )}
      {loading ? (
        <p>Đang kiểm tra lịch…</p>
      ) : !slug ? (
        <>
          {!exams.length && (
            <div className="pt-empty">
              Hiện chưa có bài kiểm tra đang mở. Danh sách sẽ cập nhật khi tới
              giờ.
            </div>
          )}
          <div className="pt-catalog-grid">
            {exams.map((e) => (
              <article key={e.slug} className="pt-card">
                <span className="pt-badge pt-state-open">Đang mở</span>
                <h2>{e.title}</h2>
                <p>
                  {e.subjectName} · {e.durationMinutes} phút
                </p>
                <p className="pt-muted">Đóng lúc {dateLabel(e.endsAt)}</p>
                <Link className="pt-button pt-primary" to={`/tests/${e.slug}`}>
                  Vào kiểm tra
                </Link>
              </article>
            ))}
          </div>
        </>
      ) : (
        exam && (
          <section className="pt-card">
            <h2>{exam.subjectName}</h2>
            <p>{exam.categoryNames.join(" · ")}</p>
            <p>
              {dateLabel(exam.startsAt)} → {dateLabel(exam.endsAt)}
            </p>
            {exam.state !== "OPEN" ? (
              <div className="pt-empty">
                <strong>Đường dẫn đang khóa</strong>
                <p>
                  {exam.state === "LOCKED"
                    ? "Bài kiểm tra chưa đến giờ bắt đầu."
                    : "Bài kiểm tra đã kết thúc."}
                </p>
                <Link to="/tests">Xem bài kiểm tra đang mở</Link>
              </div>
            ) : !verified ? (
              <form onSubmit={verify}>
                <label>
                  Mật khẩu kiểm tra
                  <input
                    type="password"
                    autoComplete="off"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    maxLength={100}
                  />
                </label>
                <button disabled={busy} className="pt-primary">
                  {busy ? "Đang kiểm tra…" : "Tiếp tục"}
                </button>
              </form>
            ) : (
              <form onSubmit={join}>
                <label>
                  Họ và tên của bạn
                  <input
                    required
                    minLength={2}
                    maxLength={120}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Nhập đầy đủ họ tên"
                  />
                </label>
                <p className="pt-muted">
                  Thời gian làm bài bắt đầu khi bấm nút bên dưới, tối đa{" "}
                  {exam.durationMinutes} phút và không quá giờ đóng bài. Hoạt
                  động rời trang/chuyển tab sẽ được ghi nhận.
                </p>
                <button disabled={busy} className="pt-primary">
                  {busy ? "Đang bắt đầu…" : "Bắt đầu làm bài"}
                </button>
              </form>
            )}
          </section>
        )
      )}
    </main>
  );
}
