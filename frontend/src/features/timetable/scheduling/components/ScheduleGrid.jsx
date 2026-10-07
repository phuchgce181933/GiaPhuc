const DAY_LABELS = {
  1: 'Thứ 2',
  2: 'Thứ 3',
  3: 'Thứ 4',
  4: 'Thứ 5',
  5: 'Thứ 6',
  6: 'Thứ 7'
};
const SESSION_LABELS = {
  sang: 'Sáng',
  chieu: 'Chiều',
  ca_hai: 'Cả hai'
};
export function dayLabel(day) {
  return day?.label ?? DAY_LABELS[day?.day] ?? `Day ${day?.day}`;
}
export function sessionLabel(session) {
  return SESSION_LABELS[session] ?? session;
}
function indexRows(rows, {
  entityKey,
  entityId,
  branchFilter
}) {
  const index = new Map();
  for (const row of rows ?? []) {
    if (row[entityKey] !== entityId) continue;
    if (branchFilter && branchFilter !== 'ALL' && row.branchId !== branchFilter) continue;
    const key = `${row.day}|${row.session}|${row.period}`;
    if (!index.has(key)) index.set(key, row);
  }
  return index;
}
function useResolvers(directory) {
  return {
    subject: id => directory?.subjects?.find(s => s.id === id)?.name ?? '—',
    teacher: id => directory?.teachers?.find(t => t.id === id)?.name ?? '—',
    class: id => directory?.classes?.find(c => c.id === id)?.name ?? '—',
    branch: id => directory?.branches?.find(b => b.id === id)?.name ?? '—'
  };
}
function buildLayout(days) {
  const blocks = [];
  const bySession = new Map();
  for (const day of days) {
    for (const session of day.sessions ?? []) {
      if (!bySession.has(session)) {
        const block = {
          session,
          periods: new Set()
        };
        bySession.set(session, block);
        blocks.push(block);
      }
      const block = bySession.get(session);
      const periods = day.periodsBySession?.[session] ?? (day.periods ?? []).filter(period => session === 'sang' ? period <= 4 : session === 'chieu' ? period >= 5 : true);
      for (const period of periods) block.periods.add(period);
    }
  }
  return blocks.sort((a, b) => (a.session === 'sang' ? 0 : 1) - (b.session === 'sang' ? 0 : 1)).map(({
    session,
    periods
  }) => ({
    session,
    periods: [...periods].sort((a, b) => a - b)
  })).filter(b => b.periods.length > 0);
}
export function ScheduleGrid({
  days = [],
  placements = [],
  mode = 'CLASS',
  entityId = null,
  branchFilter = 'ALL',
  directory
}) {
  const entityKey = mode === 'TEACHER' ? 'teacherId' : 'classId';
  const cells = indexRows(placements, {
    entityKey,
    entityId,
    branchFilter
  });
  const resolvers = useResolvers(directory);
  const layout = buildLayout(days);
  const entityName = mode === 'TEACHER' ? directory?.teachers?.find(t => t.id === entityId)?.name : directory?.classes?.find(c => c.id === entityId)?.name;
  if (!entityId) {
    return <p className="tkb-empty" data-testid="grid-no-entity">
        Chọn {mode === 'TEACHER' ? 'giáo viên' : 'lớp'} để xem thời khóa biểu.
      </p>;
  }
  if ((placements ?? []).length === 0) {
    return <p className="tkb-empty" data-testid="grid-no-placements">
        Phương án này không có dữ liệu tiết học nên chưa thể hiển thị thời khóa biểu.
      </p>;
  }
  return <div className="tkb-grid-wrap">
      <p className="tkb-grid-title" data-testid="grid-title">
        {mode === 'TEACHER' ? 'TKB giáo viên' : 'TKB lớp'}
        {entityName ? <> — <strong>{entityName}</strong></> : null}
      </p>
      <p className="tkb-hint">Chỉ hiển thị các môn bộ môn đang quản lý. Ô trống không phải lịch đầy đủ của lớp.</p>
      <table className="tkb-grid" data-testid="schedule-grid">
        <thead>
          <tr>
            {}
            <th scope="col" colSpan={2}>Tiết</th>
            {days.map(d => <th scope="col" key={d.day} data-day={d.day}>{dayLabel(d)}</th>)}
          </tr>
        </thead>
        <tbody>
          {layout.map(({
          session,
          periods
        }) => periods.map((period, indexInSession) => <tr key={`${session}-${period}`}>
                {indexInSession === 0 ? <th scope="rowgroup" rowSpan={periods.length} className="tkb-session">
                    {sessionLabel(session)}
                  </th> : null}
                <th scope="row" className="tkb-period">{period}</th>
                {days.map(d => {
            const row = cells.get(`${d.day}|${session}|${period}`);
            const blocked = session === 'sang' && (Number(d.day) === 1 && period === 1 || Number(d.day) === 5 && period === 4);
            if (blocked && !row) return <td key={d.day} className="tkb-cell tkb-cell-blocked">Không xếp</td>;
            if (!row) {
              return <td key={d.day} className="tkb-cell tkb-cell-empty">—</td>;
            }
            const primary = mode === 'TEACHER' ? resolvers.subject(row.subjectId) : resolvers.teacher(row.teacherId);
            const secondary = mode === 'TEACHER' ? resolvers.class(row.classId) : resolvers.subject(row.subjectId);
            return <td key={d.day} className="tkb-cell" data-testid="tkb-cell-filled">
                      <span className="tkb-cell-primary">{primary}</span>
                      <span className="tkb-cell-secondary">{secondary}</span>
                      <span className="tkb-cell-branch">{resolvers.branch(row.branchId)}</span>
                      {blocked && <span className="tkb-error">Khung giờ bị khóa</span>}
                    </td>;
          })}
              </tr>))}
        </tbody>
      </table>
    </div>;
}
