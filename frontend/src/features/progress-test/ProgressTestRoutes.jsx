import { NavLink, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { useTopbar } from "../../layouts/AdminLayout";
import CatalogPage from "./pages/CatalogPage";
import QuestionPage from "./pages/QuestionPage";
import ExamPage from "./pages/ExamPage";
import ResultPage from "./pages/ResultPage";
import { usePermission } from "../auth/hooks";
import { PERMISSIONS as P } from "../auth/permissions";
import "./progress-test.css";
export default function ProgressTestRoutes() {
  const permission = usePermission();
  const { set } = useTopbar();
  useEffect(() => {
    set({
      title: "Bài kiểm tra",
      subtitle: "Kiểm tra & đánh giá",
      breadcrumbs: [],
    });
    return () => set({ title: "", subtitle: "", breadcrumbs: [] });
  }, [set]);
  return (
    <div className="pt-app">
      <header className="pt-heading">
        <span className="pt-eyebrow">GIA PHUC · ĐÁNH GIÁ HỌC TẬP</span>
        <h1>Bài kiểm tra</h1>
        <p>Chuẩn bị câu hỏi, lên lịch kiểm tra và theo dõi kết quả.</p>
      </header>
      <nav className="pt-tabs" aria-label="Điều hướng bài kiểm tra">
        <NavLink to="/progress-test" end>
          Môn & danh mục
        </NavLink>
        {permission.hasAll([P.PROGRESS_QUESTION]) && (
          <NavLink to="/progress-test/questions">Ngân hàng câu hỏi</NavLink>
        )}
        <NavLink to="/progress-test/exams">Lịch & kết quả</NavLink>
        <a href="/tests" target="_blank" rel="noreferrer">
          Trang học sinh ↗
        </a>
      </nav>
      <Routes>
        <Route index element={<CatalogPage />} />
        <Route path="questions" element={<QuestionPage />} />
        <Route path="exams" element={<ExamPage />} />
        <Route path="exams/:id/results" element={<ResultPage />} />
      </Routes>
    </div>
  );
}
