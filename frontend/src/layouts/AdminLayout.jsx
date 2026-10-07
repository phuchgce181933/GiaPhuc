import { createContext, useContext, useState } from 'react';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';
import { Outlet } from 'react-router-dom';
import UnsavedChangesProvider from '../components/common/UnsavedChangesProvider.jsx';

const TopbarContext = createContext({ set: () => {} });

export function useTopbar() {
  return useContext(TopbarContext);
}

export default function AdminLayout() {
  const [topbar, setTopbar] = useState({ title: '', subtitle: '', breadcrumbs: [] });
  return (
    <UnsavedChangesProvider><TopbarContext.Provider value={{ set: setTopbar }}>
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
