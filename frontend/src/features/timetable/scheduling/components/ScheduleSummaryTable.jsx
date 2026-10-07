const DAYS = [1, 2, 3, 4, 5];
const SESSIONS = [{ key: 'sang', label: 'Sáng', periods: [1, 2, 3, 4] }, { key: 'chieu', label: 'Chiều', periods: [1, 2, 3] }];
export const SUMMARY_COLUMNS = [
  { key: 'index', label: 'TT' }, { key: 'teacherName', label: 'Họ tên GV' }, { key: 'subjectName', label: 'Môn dạy' }, { key: 'branchName', label: 'Phân hiệu' },
  ...DAYS.flatMap(day => SESSIONS.flatMap(session => session.periods.map(period => ({ key: `d${day}_${session.key}_${period}`, label: `Thứ ${day + 1} ${session.label} tiết ${period}` })))),
  { key: 'total', label: 'Tổng tiết' }, { key: 'transfer', label: 'Điều chuyển' }, { key: 'grandTotal', label: 'Tổng cộng' },
];
export const SUMMARY_HEADER_ROWS = [
  [{ label: 'TT', rowSpan: 3 }, { label: 'Họ tên GV', rowSpan: 3 }, { label: 'Môn dạy', rowSpan: 3 }, { label: 'Phân hiệu', rowSpan: 3 },
    ...DAYS.map(day => ({ label: `Thứ ${day + 1}`, colSpan: 7 })), { label: 'Tổng tiết', rowSpan: 3 }, { label: 'Điều chuyển', rowSpan: 3 }, { label: 'Tổng cộng', rowSpan: 3 }],
  DAYS.flatMap(() => SESSIONS.map(session => ({ label: session.label, colSpan: session.periods.length }))),
  DAYS.flatMap(() => SESSIONS.flatMap(session => session.periods.map(period => ({ label: `Tiết ${period}` })))),
];
function localPeriod(row) { return row.session === 'chieu' ? Number(row.period) - 4 : Number(row.period); }
export function filterTeacherScheduleRows(rows = [], branch = 'ALL', subject = 'ALL') {
  if (branch === 'ALL' && subject === 'ALL') return rows;
  const teacherIds = new Set(rows.filter(row => (branch === 'ALL' || row.branchId === branch) && (subject === 'ALL' || row.subjectId === subject)).map(row => row.teacherId));
  return rows.filter(row => teacherIds.has(row.teacherId));
}
export function buildTeacherSummary(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.teacherId;
    const item = grouped.get(key) ?? { teacherId: row.teacherId, teacherName: row.teacherName, branchName: row.teacherHomeBranchName ?? 'Chưa khai báo', subjects: new Set(), cells: {}, total: 0, transfer: 0 };
    item.subjects.add(row.subjectName);
    const period = localPeriod(row);
    if (DAYS.includes(Number(row.day)) && (row.session === 'sang' ? period >= 1 && period <= 4 : period >= 1 && period <= 3)) {
      const cellKey = `d${row.day}_${row.session}_${period}`;
      item.cells[cellKey] = item.cells[cellKey] ? `${item.cells[cellKey]}, ${row.className}` : row.className;
    }
    item.total += 1;
    if (row.teacherHomeBranchId && row.teacherHomeBranchId !== row.branchId) item.transfer += 1;
    grouped.set(key, item);
  }
  return [...grouped.values()].map(item => ({ ...item, ...item.cells, subjectName: [...item.subjects].join('\n'), grandTotal: item.total, transfer: item.transfer || 0 })).sort((a, b) => a.teacherName.localeCompare(b.teacherName)).map((item, index) => ({ ...item, index: index + 1 }));
}
export function ScheduleSummaryTable({ rows = [] }) {
  const summary = buildTeacherSummary(rows);
  return <div className="tkb-grid-wrap"><table className="tkb-summary-table tkb-summary-landscape"><colgroup><col className="tkb-summary-index-col" /><col className="tkb-summary-teacher-col" /><col className="tkb-summary-subject-col" /><col className="tkb-summary-branch-col" />{DAYS.flatMap(day => SESSIONS.flatMap(session => session.periods.map(period => <col key={`${day}-${session.key}-${period}`} className="tkb-summary-slot-col" />)))}<col className="tkb-summary-total-col" /><col className="tkb-summary-transfer-col" /><col className="tkb-summary-grand-col" /></colgroup><thead><tr><th rowSpan="3">TT</th><th rowSpan="3">Họ tên GV</th><th rowSpan="3">Môn dạy</th><th rowSpan="3">Phân hiệu</th>{DAYS.map(day => <th key={day} colSpan="7">Thứ {day + 1}</th>)}<th rowSpan="3">Tổng tiết</th><th rowSpan="3">Điều chuyển</th><th rowSpan="3">Tổng cộng</th></tr><tr>{DAYS.flatMap(day => SESSIONS.map(session => <th key={`${day}-${session.key}`} colSpan={session.periods.length}>{session.label}</th>))}</tr><tr>{DAYS.flatMap(day => SESSIONS.flatMap(session => session.periods.map(period => <th key={`${day}-${session.key}-${period}`} className="tkb-summary-period">Tiết {period}</th>)))}</tr></thead><tbody>{summary.map((row, index) => <tr key={`${row.teacherId}-${row.subjectName}-${row.branchName}`}><td>{index + 1}</td><td>{row.teacherName}</td><td>{row.subjectName}</td><td>{row.branchName}</td>{DAYS.flatMap(day => SESSIONS.flatMap(session => session.periods.map(period => <td key={`${day}-${session.key}-${period}`} className="tkb-summary-slot">{row[`d${day}_${session.key}_${period}`] || '—'}</td>)))}<td>{row.total}</td><td>{row.transfer}</td><td>{row.grandTotal}</td></tr>)}</tbody></table></div>;
}
