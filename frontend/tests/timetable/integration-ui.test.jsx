import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, Outlet, Link } from 'react-router-dom';
import UnsavedChangesProvider from '../../src/components/common/UnsavedChangesProvider.jsx';
import { PreferencesPage } from '../../src/features/timetable/catalog/pages/CatalogPages.jsx';
import { TeachersPage } from '../../src/features/timetable/catalog/pages/CatalogCrudPages.jsx';
import { SchedulePage } from '../../src/features/timetable/scheduling/pages/SchedulePage.jsx';
import SavedSchedulePage from '../../src/features/timetable/scheduling/pages/SavedSchedulePage.jsx';
import { usePermission } from '../../src/features/auth/hooks.js';
import * as catalog from '../../src/features/timetable/catalog/service.js';

vi.mock('../../src/features/timetable/catalog/service.js',async(importOriginal)=>({...await importOriginal(),getTeachers:vi.fn(),getBranches:vi.fn(),getPreference:vi.fn(),savePreference:vi.fn(),getSubjects:vi.fn(),getClasses:vi.fn(),getBlocks:vi.fn()}));
const directory={teachers:[{id:'t1',name:'Tên tại thời điểm lưu',homeBranchId:'b1'},{id:'t2',name:'Beta',homeBranchId:'b2'}],classes:[{id:'c1',name:'Lớp 1',branchId:'b1'},{id:'c2',name:'Lớp 2',branchId:'b2'}],branches:[{id:'b1',name:'Cơ sở 1'},{id:'b2',name:'Cơ sở 2'}],subjects:[{id:'s',name:'Tin học'}]};
const calendar={days:[{day:2,periods:[2],sessions:['sang'],periodsBySession:{sang:[2]}}]};
const placements=[{assignmentId:'a1',classId:'c1',teacherId:'t1',subjectId:'s',branchId:'b1',day:2,period:2,session:'sang'},{assignmentId:'a2',classId:'c2',teacherId:'t2',subjectId:'s',branchId:'b2',day:2,period:2,session:'sang'}];
const solution={id:'ms-test',rank:1,placements,validation:{accepted:true,hardViolations:0},metrics:{totalPeriods:2,workloadSpread:0,maxTeacherLoad:1},scoring:{dimensions:{},hardViolations:0,feasibility:'FEASIBLE'}};
const generated={requestId:'req-test',status:'OK',solutions:[solution],directory,calendar,travel:{available:false},transfer:{active:true},generation:{status:'COMPLETED',stages:[]}};
function mount(element, path='/timetable') { return render(<RouterProvider router={createMemoryRouter([{path:'*',element}],{initialEntries:[path]})}/>); }
beforeEach(()=>{
  history.replaceState({},'','/');
  vi.mocked(usePermission).mockReturnValue({hasAll:()=>true,hasAny:()=>true});
  catalog.getTeachers.mockResolvedValue({teachers:directory.teachers.map(t=>({...t,isActive:true,specializations:[],workload:{},preferenceConfiguration:{},canDelete:true}))});
  catalog.getBranches.mockResolvedValue({branches:directory.branches});catalog.getSubjects.mockResolvedValue({subjects:directory.subjects});
  catalog.getPreference.mockResolvedValue({preference:{preferredSession:'both',desiredTeachingSessionsPerWeek:null,preferredOffDay:'NONE',preferredOffPart:'NONE',preferredTransferBranchIds:[]}});
  vi.stubGlobal('fetch',vi.fn(async(url)=>{const data=String(url).endsWith('/health')?{request:{allowedCandidateCounts:[1,3],allowedOptimizationModes:['BASE_FEASIBLE','GLOBAL_ASSIGNMENT_BALANCED']},commit:{implemented:true}}:String(url).endsWith('/full')?{schedule:{version:1,committedAt:'2026-10-06T13:00:00Z',slotCount:2,slots:placements,directory,calendar,travel:{available:false}}}:String(url).includes('/generate')?generated:{schedules:[]};return {ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data)};}));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.mocked(usePermission).mockReturnValue({hasAll:()=>true,hasAny:()=>true});});

test('dirty preferences block leaving and retain values when choosing stay',async()=>{
  const router=createMemoryRouter([{path:'/',element:<UnsavedChangesProvider><Link to="/elsewhere">Trang khác</Link><Outlet/></UnsavedChangesProvider>,children:[{path:'timetable/teacher-preferences',element:<PreferencesPage/>},{path:'elsewhere',element:<p>Trang mới</p>}]}],{initialEntries:['/timetable/teacher-preferences?teacher=t1']});
  render(<RouterProvider router={router}/>);const user=userEvent.setup();
  const field=await screen.findByRole('spinbutton',{name:'Số buổi dạy mong muốn / tuần'});await user.type(field,'3');await user.click(screen.getByRole('link',{name:'Trang khác'}));
  expect(await screen.findByRole('dialog',{name:'Bạn có thay đổi chưa lưu'})).toBeTruthy();await user.click(screen.getByRole('button',{name:'Ở lại'}));expect(field.value).toBe('3');
  await user.click(screen.getByRole('link',{name:'Trang khác'}));await user.click(screen.getByRole('button',{name:'Bỏ thay đổi và tiếp tục'}));expect(await screen.findByText('Trang mới')).toBeTruthy();
});
test('switching teacher with dirty preferences requires explicit discard',async()=>{
  mount(<PreferencesPage/>,'/timetable/teacher-preferences?teacher=t1');const user=userEvent.setup();const field=await screen.findByRole('spinbutton');await user.type(field,'3');
  await user.selectOptions(screen.getByRole('combobox',{name:'Giáo viên'}),'t2');expect(await screen.findByRole('dialog',{name:'Nguyện vọng chưa lưu'})).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Ở lại'}));expect(screen.getByRole('combobox',{name:'Giáo viên'}).value).toBe('t1');expect(field.value).toBe('3');
});
test('read-only role has no catalog write actions',async()=>{
  vi.mocked(usePermission).mockReturnValue({hasAll:()=>false});mount(<TeachersPage/>);
  await screen.findByRole('link',{name:'Tên tại thời điểm lưu'});expect(screen.queryByRole('button',{name:'Thêm giáo viên'})).toBeNull();expect(screen.queryByRole('button',{name:/Sửa/})).toBeNull();
});
test('generation has no AI control and class list follows the branch',async()=>{
  mount(<SchedulePage/>);const user=userEvent.setup();expect(screen.queryByTestId('use-ai')).toBeNull();await user.click(screen.getByRole('button',{name:'Tạo TKB'}));await screen.findByTestId('schedule-grid');
  const sent=JSON.parse(vi.mocked(fetch).mock.calls.find(([url])=>String(url).includes('/generate'))[1].body);
  expect(Object.keys(sent).sort()).toEqual(['candidateCount','optimizationMode']);
  await user.selectOptions(screen.getByTestId('branch-filter'),'b2');expect(screen.getByRole('combobox',{name:'Lớp'}).value).toBe('c2');expect(screen.queryByRole('option',{name:'Lớp 1'})).toBeNull();
});
test('saved schedule uses its stored names after reopening',async()=>{
  const router=createMemoryRouter([{path:'/timetable/schedules/:id',element:<SavedSchedulePage/>}],{initialEntries:['/timetable/schedules/sch-test']});render(<RouterProvider router={router}/>);
  expect(await screen.findByText('Tên tại thời điểm lưu')).toBeTruthy();expect(screen.queryByText('Đổi tên hiện tại')).toBeNull();
});
