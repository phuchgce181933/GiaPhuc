import { confirmDialog, promptDialog } from "../../../components/common/AppDialog";
import { useEffect, useState } from "react";
import { request } from "../service";
import { usePermission } from "../../auth/hooks";
import { PERMISSIONS as P } from "../../auth/permissions";
export default function CatalogPage() {
  const [catalog, setCatalog] = useState({ subjects: [], categories: [] });
  const [name, setName] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const canEdit = usePermission().hasAll([P.PROGRESS_CATALOG]);
  async function load() {
    try {
      setCatalog(await request("/catalog"));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function mutate(path, method, data) {
    setBusy(true);
    setError("");
    try {
      await request(path, { method, data });
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function remove(path) {
    if (await confirmDialog("Xóa danh mục này? Danh mục có câu hỏi sẽ được bảo vệ."))
      await mutate(path, "DELETE");
  }
  async function rename(type, record) {
    const next = await promptDialog("Tên mới", record.name);
    if (next?.trim())
      await mutate(`/${type}/${record._id}`, "PATCH", {
        name: next,
        ...(type === "categories" ? { subjectId: record.subjectId } : {}),
      });
  }
  return (
    <section className="pt-content">
      {error && (
        <p className="pt-error" role="alert">
          {error}
        </p>
      )}
      <div className="pt-section-title">
        <h2>Môn học & danh mục</h2>
        <span>
          {catalog.subjects.length} môn · {catalog.categories.length} danh mục
        </span>
      </div>
      {canEdit && (
        <div className="pt-two-columns">
          <form
            className="pt-card"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await mutate("/subjects", "POST", { name })) setName("");
            }}
          >
            <h3>Thêm môn học</h3>
            <label>
              Tên môn
              <input
                required
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder="Tiếng Anh, Toán…"
              />
            </label>
            <button disabled={busy} className="pt-primary">
              Thêm môn
            </button>
          </form>
          <form
            className="pt-card"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate("/categories", "POST", {
                  subjectId,
                  name: categoryName,
                })
              )
                setCategoryName("");
            }}
          >
            <h3>Thêm danh mục trong môn</h3>
            <label>
              Môn học
              <select
                required
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
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
              Tên danh mục
              <input
                required
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                maxLength={120}
                placeholder="Unit 1, Unit 2, Đại số…"
              />
            </label>
            <button className="pt-primary" disabled={busy}>
              Thêm danh mục
            </button>
          </form>
        </div>
      )}
      {loading ? (
        <p>Đang tải môn học…</p>
      ) : !catalog.subjects.length ? (
        <div className="pt-empty">
          Thêm môn đầu tiên để bắt đầu tạo ngân hàng câu hỏi.
        </div>
      ) : (
        <div className="pt-catalog-grid">
          {catalog.subjects.map((s) => (
            <article key={s._id} className="pt-card">
              <div className="pt-section-title">
                <h3>{s.name}</h3>
                {canEdit && (
                  <div className="pt-actions">
                    <button
                      onClick={() => rename("subjects", s)}
                      disabled={busy}
                    >
                      Đổi tên
                    </button>
                    <button
                      onClick={() => remove(`/subjects/${s._id}`)}
                      disabled={busy}
                    >
                      Xóa
                    </button>
                  </div>
                )}
              </div>
              <ul className="pt-category-list">
                {catalog.categories
                  .filter((c) => c.subjectId === s._id)
                  .map((c) => (
                    <li key={c._id}>
                      <span>{c.name}</span>
                      {canEdit && (
                        <div className="pt-actions">
                          <button
                            disabled={busy}
                            onClick={() => rename("categories", c)}
                          >
                            Sửa
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => remove(`/categories/${c._id}`)}
                          >
                            Xóa
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
              </ul>
              {!catalog.categories.some((c) => c.subjectId === s._id) && (
                <p className="pt-muted">Chưa có danh mục.</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
