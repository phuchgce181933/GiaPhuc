/**
 * App shell.
 *
 * Phase 32 ships one screen, so there is one tab and no router. The
 * previous shell had three tabs — "AI Generate", "Teachers",
 * "Situation" — and the latter two were placeholders that rendered a
 * sentence pointing back at the generate output. A tab that only says
 * "look at the other tab" is a dead end, so they are gone rather
 * than kept as stubs.
 *
 * `SchedulePage` is reached through `pages/Generate.jsx`, which is a
 * re-export of the feature's own screen, so this file references one
 * route component and the feature stays self-contained.
 *
 * PHASE 33: the subtitle used to say "preview only", which was an
 * accurate Phase 32 statement and became a FALSE one the moment a
 * commit could write. It now names what the screen actually does:
 * generate a preview, save what you confirm. The mode itself is
 * reported from `/api/schedules/health` on the page, so the shell
 * never hard-codes a capability the deployment might not have.
 */

import { useEffect, useState } from 'react';
import Generate from './pages/Generate.jsx';
import { DashboardPage, TeachersPage, TeacherPage, SubjectsPage, ClassesPage, ClassPage, BranchesPage, BranchPage, PreferencesPage } from './features/catalog/pages/CatalogPages.jsx';
const NAV = [['Tổng quan','/'],['Tạo TKB','/generate'],['Giáo viên','/teachers'],['Môn học','/subjects'],['Lớp','/classes'],['Phân hiệu','/branches'],['Nguyện vọng giáo viên','/teacher-preferences']];
export default function App() {
  const [path,setPath]=useState(location.pathname);
  useEffect(()=>{const update=()=>setPath(location.pathname);addEventListener('popstate',update);const click=(e)=>{const a=e.target.closest('a[href^="/"]');if(!a||e.metaKey||e.ctrlKey)return;e.preventDefault();history.pushState({},'',a.href);update()};addEventListener('click',click);return()=>{removeEventListener('popstate',update);removeEventListener('click',click)}},[]);
  return <div><header className="tkb-app-header"><a className="tkb-app-title" href="/">thuanhung_tkb</a><span className="tkb-app-sub">Timetable administration</span></header><div className="tkb-shell"><nav className="tkb-nav">{NAV.map(([label,to])=><a key={to} href={to} className={path===to?'active':''}>{label}</a>)}</nav><main>{route(path)}</main></div></div>;
}
function route(path){if(path==='/')return <DashboardPage/>;if(path==='/generate')return <Generate/>;if(path==='/teachers')return <TeachersPage/>;if(path.startsWith('/teachers/'))return <TeacherPage id={path.split('/')[2]}/>;if(path==='/subjects')return <SubjectsPage/>;if(path==='/classes')return <ClassesPage/>;if(path.startsWith('/classes/'))return <ClassPage id={path.split('/')[2]}/>;if(path==='/branches')return <BranchesPage/>;if(path.startsWith('/branches/'))return <BranchPage id={path.split('/')[2]}/>;if(path==='/teacher-preferences')return <PreferencesPage/>;return <DashboardPage/>;}
