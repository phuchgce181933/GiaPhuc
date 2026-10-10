import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';
import { Outlet, useLocation } from 'react-router-dom';
import UnsavedChangesProvider from '../components/common/UnsavedChangesProvider.jsx';

const TopbarContext = createContext({ set: () => {} });

export function useTopbar() {
  return useContext(TopbarContext);
}

export default function AdminLayout() {
  const [topbar, setTopbar] = useState({ title: '', subtitle: '', breadcrumbs: [] });
  const location = useLocation();
  const setForRoute = useCallback((value) => setTopbar({ ...value, routeKey: location.pathname }), [location.pathname]);
  const fallback = useMemo(() => {
    const root = location.pathname.split('/').filter(Boolean)[0];
    return ({dashboard:['Tổng quan','Thông tin hệ thống và thao tác nhanh'],users:['Người dùng','Quản lý tài khoản trong hệ thống'],roles:['Vai trò và quyền','Quản lý quyền truy cập'],timetable:['Thời khóa biểu','Lập và quản lý lịch dạy'],'progress-test':['Bài kiểm tra','Kiểm tra và đánh giá'],presentations:['Bài thuyết trình','Soạn nội dung và xuất bản trình chiếu'],profile:['Hồ sơ cá nhân','Thông tin tài khoản của bạn']})[root] || ['GiaPhúc','Không gian quản trị'];
  }, [location.pathname]);
  const currentTopbar = topbar.routeKey === location.pathname ? topbar : { title:fallback[0], subtitle:fallback[1], breadcrumbs:[] };
  return (
    <UnsavedChangesProvider><TopbarContext.Provider value={{ set: setForRoute }}>
      <div className="admin-shell">
        <Sidebar />
        <div className="admin-main">
          <Topbar title={currentTopbar.title} subtitle={currentTopbar.subtitle} breadcrumbs={currentTopbar.breadcrumbs} />
          <main className="admin-content"><Outlet /></main>
        </div>
        <style>{`
          .admin-shell { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
          .admin-main { display: flex; flex-direction: column; min-width: 0; }
          .admin-content { flex: 1; padding: 0; }
          @media(max-width:900px) {
            .admin-shell { grid-template-columns:minmax(0,1fr); }
            .gp-sidebar { width:100%; height:auto; position:static; border-right:0; border-bottom:1px solid var(--border); }
            .gp-sidebar__brand { padding:12px 16px; }
            .gp-sidebar__nav { display:flex; flex-direction:row; overflow-x:auto; padding:8px; }
            .gp-sidebar__link { flex:none; white-space:nowrap; }
            .gp-sidebar__footer { display:none; }
          }
        `}</style>
      </div>
    </TopbarContext.Provider></UnsavedChangesProvider>
  );
}
