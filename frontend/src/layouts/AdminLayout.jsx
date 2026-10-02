import { createContext, useContext, useState } from 'react';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';
import { Outlet } from 'react-router-dom';

const TopbarContext = createContext({ set: () => {} });

export function useTopbar() {
  return useContext(TopbarContext);
}

export default function AdminLayout() {
  const [topbar, setTopbar] = useState({ title: '', subtitle: '', breadcrumbs: [] });
  return (
    <TopbarContext.Provider value={{ set: setTopbar }}>
      <div className="admin-shell">
        <Sidebar />
        <div className="admin-main">
          <Topbar title={topbar.title} subtitle={topbar.subtitle} breadcrumbs={topbar.breadcrumbs} />
          <main className="admin-content"><Outlet /></main>
        </div>
        <style>{`
          .admin-shell { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
          .admin-main { display: flex; flex-direction: column; min-width: 0; }
          .admin-content { flex: 1; padding: 0; }
        `}</style>
      </div>
    </TopbarContext.Provider>
  );
}