export { TeachersPage, SubjectsPage, ClassesPage } from './CatalogCrudPages.jsx';
import { useEffect, useState } from 'react';
import { getTeachers, getTeacher, getSubjects, getClasses, getClass, getBranches, getBranch, getPreference, savePreference, getDashboard } from '../service.js';

function useData(load, key = 'initial') { const [state,set]=useState({loading:true,data:null,error:null}); useEffect(()=>{let alive=true;set({loading:true,data:null,error:null});load().then(data=>alive&&set({loading:false,data,error:null})).catch(e=>alive&&set({loading:false,data:null,error:e.message}));return()=>{alive=false}},[key]);return state }
const Link=({to,children})=><a href={to}>{children}</a>;
function State({state,children}){if(state.loading)return <p className="tkb-empty">Đang tải dữ liệu…</p>;if(state.error)return <p className="tkb-error" role="alert">{state.error}</p>;return children}
const Badge=({active})=><span className="tkb-badge">{active?'Active':'Inactive'}</span>;

export function TeacherPage({id}){const s=useData(()=>getTeacher(id),id);return <Page title="Chi tiết giáo viên"><State state={s}>{s.data&&<><p><Link to={`/teacher-preferences?teacher=${id}`}>Chỉnh nguyện vọng</Link></p><Info rows={[["Tên",s.data.teacher.name],["Email",s.data.teacher.email||'—'],["Điện thoại",s.data.teacher.phone||'—'],["Phân hiệu",s.data.teacher.homeBranchName||'—'],["Trạng thái",s.data.teacher.isActive?'Active':'Inactive'],["Workload",s.data.teacher.workload.teaching??s.data.teacher.workload.standard??'—'],["Ca ưu tiên",labelSession(s.data.teacher.preference.preferredSession)]]}/><h2>Chuyên môn</h2><Table heads={['Môn học','ID']} rows={s.data.teacher.specializations.map(x=><tr key={x.id}><td>{x.name}</td><td className="tkb-mono">{x.id}</td></tr>)}/></>}</State></Page>}
export function ClassPage({id}){const s=useData(()=>getClass(id),id);return <Page title="Curriculum lớp"><State state={s}>{s.data&&<><Info rows={[["Lớp",s.data.class.name],["Khối",s.data.class.block?.name??'—'],["Trạng thái",s.data.class.isActive?'Active':'Inactive']]}/><Table heads={['Môn','Số tiết / tuần','Năm học']} rows={s.data.class.curriculum.map(x=><tr key={x.id}><td>{x.subject?.name??'—'}</td><td>{x.periodsPerWeek}</td><td>{x.academicYear??'—'}</td></tr>)}/></>}</State></Page>}
export function BranchesPage(){const s=useData(getBranches);return <Page title="Phân hiệu"><State state={s}><Table heads={['Mã','Tên','Trạng thái','Số lớp','Giáo viên home']} rows={(s.data?.branches??[]).map(x=><tr key={x.id}><td>{x.code}</td><td><Link to={`/branches/${x.id}`}>{x.name}</Link></td><td><Badge active={x.isActive}/></td><td>{x.classCount}</td><td>{x.homeTeacherCount}</td></tr>)}/></State></Page>}
export function BranchPage({id}){const s=useData(()=>getBranch(id),id);return <Page title="Chi tiết phân hiệu"><State state={s}>{s.data&&<><h2>{s.data.branch.name}</h2><h3>Lớp</h3><p>{s.data.branch.classes.map(x=>x.name).join(', ')||'—'}</p><h3>Giáo viên home</h3><p>{s.data.branch.teachers.map(x=><span key={x.id}><Link to={`/teachers/${x.id}`}>{x.name}</Link>{' · '}</span>)||'—'}</p></>}</State></Page>}

const EMPTY_PREF={preferredSession:'both',desiredTeachingSessionsPerWeek:'',preferredOffDay:'NONE',preferredOffPart:'NONE',preferredTransferBranchIds:[]};
export function PreferencesPage() {
	const teachers = useData(getTeachers);
	const branches = useData(getBranches);
	const initial = new URLSearchParams(location.search).get('teacher') || '';
	const [id, setId] = useState(initial);
	const [branchFilter, setBranchFilter] = useState('all');
	const p = useData(() => id ? getPreference(id) : Promise.resolve({ preference: EMPTY_PREF }), id);
	const allTeachers = teachers.data?.teachers ?? [];
	const filteredTeachers = allTeachers.filter((teacher) => branchFilter === 'all' || teacher.homeBranchId === branchFilter);
	const currentTeacher = allTeachers.find((teacher) => teacher.id === id);
	const transferBranches = (branches.data?.branches ?? []).filter((branch) => branch.id !== currentTeacher?.homeBranchId);
	const homeBranchName = (branches.data?.branches ?? []).find((branch) => branch.id === currentTeacher?.homeBranchId)?.name
		?? currentTeacher?.homeBranchName ?? 'Chưa có trong hồ sơ';
	const [form, setForm] = useState(EMPTY_PREF);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState('');

	useEffect(() => {
		if (p.data) {
			setForm(normalizePreference(p.data.preference));
			setDirty(false);
		}
	}, [p.data]);

	useEffect(() => {
		const leave = (event) => {
			if (dirty) {
				event.preventDefault();
				event.returnValue = '';
			}
		};
		addEventListener('beforeunload', leave);
		return () => removeEventListener('beforeunload', leave);
	}, [dirty]);

	const change = (field, value) => {
		setForm((current) => ({ ...current, [field]: value }));
		setDirty(true);
		setNotice('');
	};

	function selectBranch(branchId) {
		setBranchFilter(branchId);
		if (id && branchId !== 'all' && currentTeacher?.homeBranchId !== branchId) {
			history.replaceState({}, '', '/teacher-preferences');
			setId('');
			setNotice('');
		}
	}

	async function save() {
		const sessions = Number(form.desiredTeachingSessionsPerWeek);
		const hasSessions = form.desiredTeachingSessionsPerWeek !== '' && form.desiredTeachingSessionsPerWeek != null;
		if (hasSessions && (!Number.isInteger(sessions) || sessions < 0 || sessions > 15)) {
			setNotice('Số buổi mong muốn phải là số nguyên từ 0 đến 15.');
			return;
		}
		setSaving(true);
		try {
			const validBranchIds = new Set(transferBranches.map((branch) => branch.id));
			const preference = {
				...normalizePreference(form),
				desiredTeachingSessionsPerWeek: hasSessions ? sessions : null,
				preferredTransferBranchIds: form.preferredTransferBranchIds.filter((branchId) => validBranchIds.has(branchId)),
			};
			const result = await savePreference(id, preference);
			setForm(normalizePreference(result.preference));
			setDirty(false);
			setNotice('Đã lưu. Lần tạo TKB tiếp theo sẽ đọc các nguyện vọng mới.');
		} catch (error) {
			setNotice(error.message);
		} finally {
			setSaving(false);
		}
	}

	return <Page title="Nguyện vọng giáo viên">
		<label className="tkb-control">
			<span>Lọc phân hiệu</span>
			<select aria-label="Lọc phân hiệu" value={branchFilter} onChange={(event) => selectBranch(event.target.value)}>
				<option value="all">Mọi phân hiệu</option>
				{(branches.data?.branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
			</select>
		</label>
		<label className="tkb-control">
			<span>Giáo viên</span>
			<select value={id} onChange={(event) => {
				const next = event.target.value;
				history.replaceState({}, '', `/teacher-preferences${next ? `?teacher=${next}` : ''}`);
				setId(next);
				setNotice('');
			}}>
				<option value="">Chọn giáo viên…</option>
				{filteredTeachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
			</select>
		</label>
		{id && <State state={p}>
			<p className="tkb-hint" data-testid="fixed-home-branch">Phân hiệu chính: {homeBranchName}. Giáo viên được xếp dạy tại đây trước; phân hiệu chính lấy từ hồ sơ.</p>
			<section className="tkb-controls">
				<label className="tkb-control">
					<span>Ưu tiên ca dạy</span>
					<select value={form.preferredSession ?? 'both'} onChange={(event) => change('preferredSession', event.target.value)}>
						<option value="morning">Sáng</option><option value="afternoon">Chiều</option><option value="both">Cả hai</option>
					</select>
				</label>
				<label className="tkb-control">
					<span>Số buổi dạy mong muốn / tuần</span>
					<input type="number" min="0" max="15" step="1" value={form.desiredTeachingSessionsPerWeek ?? ''}
						onChange={(event) => change('desiredTeachingSessionsPerWeek', event.target.value)} />
				</label>
				<label className="tkb-control">
					<span>Ngày mong muốn nghỉ</span>
					<select value={form.preferredOffDay ?? 'NONE'} onChange={(event) => change('preferredOffDay', event.target.value)}>
						{['NONE','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'].map((day, index) =>
							<option key={day} value={day}>{['Không','Thứ 2','Thứ 3','Thứ 4','Thứ 5','Thứ 6'][index]}</option>)}
					</select>
				</label>
				<label className="tkb-control">
					<span>Ca mong muốn nghỉ</span>
					<select value={form.preferredOffPart ?? 'NONE'} onChange={(event) => change('preferredOffPart', event.target.value)}>
						<option value="NONE">Không</option><option value="MORNING">Sáng</option>
						<option value="AFTERNOON">Chiều</option><option value="FULL_DAY">Cả ngày</option>
					</select>
				</label>
				<fieldset className="tkb-transfer">
					<legend>Nguyện vọng được điều chuyển đến</legend>
					{transferBranches.map((branch) => <label key={branch.id}>
						<input type="checkbox" checked={(form.preferredTransferBranchIds ?? []).includes(branch.id)}
							onChange={(event) => change('preferredTransferBranchIds', event.target.checked
								? [...(form.preferredTransferBranchIds ?? []), branch.id]
								: (form.preferredTransferBranchIds ?? []).filter((id) => id !== branch.id))} />
						{branch.name}
					</label>)}
				</fieldset>
				<p className="tkb-hint">Chỉ chọn phân hiệu khác mà giáo viên mong muốn được điều chuyển đến. Nguyện vọng được xét khi cần điều chuyển sau bước xếp tại phân hiệu chính.</p>
				<p className="tkb-hint">1 buổi = giáo viên có ít nhất 1 tiết trong một ca của một ngày. 4 tiết sáng cùng ngày = 1 buổi; 1 tiết sáng + 1 tiết chiều cùng ngày = 2 buổi.</p>
				<button className="tkb-generate" disabled={saving || !dirty || !branches.data || !currentTeacher?.homeBranchId} onClick={save}>
					{saving ? 'Đang lưu…' : 'Lưu nguyện vọng'}
				</button>
				<button disabled={!dirty} onClick={() => { setForm(normalizePreference(p.data.preference)); setDirty(false); }}>Hủy</button>
			</section>
			{notice && <p className={notice.startsWith('Đã') ? 'tkb-notice' : 'tkb-error'} role="status">{notice}</p>}
			<p className="tkb-hint">Các nguyện vọng trong form là ưu tiên mềm. Nghỉ sáng không cấm dạy chiều; nghỉ chiều không cấm dạy sáng. Quy tắc nghỉ cố định và giới hạn capacity là ràng buộc riêng.</p>
		</State>}
	</Page>;
}

function normalizePreference(preference={}){const sessions=['morning','afternoon','both'];const days=['NONE','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'];const parts=['NONE','MORNING','AFTERNOON','FULL_DAY'];return{...EMPTY_PREF,...preference,preferredSession:sessions.includes(preference.preferredSession)?preference.preferredSession:EMPTY_PREF.preferredSession,desiredTeachingSessionsPerWeek:preference.desiredTeachingSessionsPerWeek??'',preferredOffDay:days.includes(preference.preferredOffDay)?preference.preferredOffDay:EMPTY_PREF.preferredOffDay,preferredOffPart:parts.includes(preference.preferredOffPart)?preference.preferredOffPart:EMPTY_PREF.preferredOffPart,preferredTransferBranchIds:Array.isArray(preference.preferredTransferBranchIds)?preference.preferredTransferBranchIds:[]}}
export function DashboardPage(){const s=useData(getDashboard);return <Page title="Tổng quan"><State state={s}>{s.data&&<div className="tkb-stats">{Object.entries(s.data.counts).map(([k,v])=><div key={k}><strong>{v}</strong><span>{({branches:'Phân hiệu',classes:'Lớp',activeTeachers:'Giáo viên active',activeSubjects:'Môn active',assignments:'Assignment',requiredPeriods:'Tiết cần xếp'})[k]}</span></div>)}</div>}</State></Page>}
function Page({title,children}){return <div className="tkb-page"><header className="tkb-page-head"><h1>{title}</h1></header>{children}</div>};function Table({heads,rows}){return <div className="tkb-grid-wrap"><table className="tkb-grid"><thead><tr>{heads.map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{rows.length?rows:<tr><td colSpan={heads.length}>Không có dữ liệu.</td></tr>}</tbody></table></div>};function Info({rows}){return <dl className="tkb-metrics">{rows.map(([k,v])=><div className="tkb-metric" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>};function labelSession(v){return ({morning:'Sáng',afternoon:'Chiều',both:'Cả hai'})[v]??'—'}
