/**
 * Phase 32 — the schedule grid.
 *
 * One component renders both views, because a class timetable and a
 * teacher timetable are the SAME grid read through a different filter:
 * columns are days, and a cell is whatever the selected entity is
 * doing in that (day, session, period) cell. Splitting them would
 * duplicate the grid logic and let the two views drift apart.
 *
 * THE GRID IS BUILT FROM BACKEND METADATA, NEVER HARDCODED
 * -------------------------------------------------------
 * Days come from `response.calendar.days`, along with the periods and
 * sessions each day actually uses. A hard-coded Monday-Friday /
 * sang-chieu table would be actively wrong on this dataset: the real
 * branches declare SIX school days, and a fixed table would hide every
 * Saturday placement the solver had scheduled (brief §13).
 *
 * `label` on a day is `null` — the source data has no day names and the
 * API deliberately does not invent them. This component therefore
 * renders a PRESENTATION name from the day NUMBER when it recognises
 * one and falls back to `Day N` when it does not. The fallback is the
 * point: a day the data uses but this table has never heard of still
 * gets rendered, because the list of days came from the data.
 *
 * ROWS ARE PERIODS, NOT DAY BLOCKS
 * -------------------------------
 * A timetable is periods down the side and days across the top. One
 * row per (session, period), unioned across every day, with a cell
 * left empty where a particular day has no such period. Building one
 * block of rows per day instead — a day-major loop — produces a table
 * where the period numbers repeat six times down the page and the
 * header, which is one column narrower than the body, no longer lines
 * up with the cells underneath it. Both are visible defects rather
 * than cosmetic ones: a reader cannot tell which row is "period 3".
 *
 * The union keeps the property that matters: a period that exists in
 * one branch but not another is still drawn, and the branch that does
 * not use it gets an empty cell rather than a permanent extra column.
 */

/**
 * Vietnamese school-week day names, keyed by day NUMBER (this dataset
 * runs 1-6, where 6 is Saturday).
 *
 * Presentation only, and keyed by number rather than by position so a
 * dataset that starts at a different day, or omits one, still labels
 * correctly. An unrecognised number falls through to `Day N` rather
 * than showing a blank or — worse — the wrong day's name.
 */
const DAY_LABELS = {
  1: 'Thứ 2',
  2: 'Thứ 3',
  3: 'Thứ 4',
  4: 'Thứ 5',
  5: 'Thứ 6',
  6: 'Thứ 7',
};

const SESSION_LABELS = {
  sang: 'Sáng',
  chieu: 'Chiều',
  ca_hai: 'Cả hai',
};

export function dayLabel(day) {
  return day?.label ?? DAY_LABELS[day?.day] ?? `Day ${day?.day}`;
}

export function sessionLabel(session) {
  return SESSION_LABELS[session] ?? session;
}

/**
 * Build the cell index: `(day, session, period)` -> placement row.
 *
 * Rows for other entities, and rows in the filtered-out branch, are
 * dropped HERE rather than in the JSX, so the render path has no
 * conditions in it at all.
 *
 * `(day, session, period)` is the conflict identity the domain itself
 * uses (`domain/time.js` — `classConflictKey` / `teacherConflictKey`).
 * A hard-feasible solution cannot place two subjects in one cell, so
 * first-write-wins cannot lose a row; it is a duplicate, and a
 * duplicate is a bug worth hiding from the view rather than a case to
 * render.
 */
function indexRows(rows, { entityKey, entityId, branchFilter }) {
  const index = new Map();
  for (const row of rows ?? []) {
    if (row[entityKey] !== entityId) continue;
    if (branchFilter && branchFilter !== 'ALL' && row.branchId !== branchFilter) continue;
    const key = `${row.day}|${row.session}|${row.period}`;
    if (!index.has(key)) index.set(key, row);
  }
  return index;
}

/** id -> display name lookups, built once per render. */
function useResolvers(directory) {
  return {
    subject: (id) => directory?.subjects?.find((s) => s.id === id)?.name ?? '—',
    teacher: (id) => directory?.teachers?.find((t) => t.id === id)?.name ?? '—',
    branch: (id) => directory?.branches?.find((b) => b.id === id)?.name ?? '—',
  };
}

/**
 * The row model: session blocks in the order the data first uses them,
 * each holding the union of the periods its days declare, ascending.
 *
 * Derived from the DATA, so a session only a seventh branch uses still
 * gets its own block, and a period only one branch uses is drawn
 * without implying it exists everywhere.
 */
function buildLayout(days) {
  const blocks = [];
  const bySession = new Map();

  for (const day of days) {
    for (const session of day.sessions ?? []) {
      if (!bySession.has(session)) {
        const block = { session, periods: new Set() };
        bySession.set(session, block);
        blocks.push(block);
      }
      const block = bySession.get(session);
      for (const period of day.periods ?? []) block.periods.add(period);
    }
  }

  return blocks
    .map(({ session, periods }) => ({ session, periods: [...periods].sort((a, b) => a - b) }))
    .filter((b) => b.periods.length > 0);
}

/**
 * ScheduleGrid
 *
 * @param {object}   props
 * @param {object[]} props.days        from `response.calendar.days`
 * @param {object[]} props.placements  the selected solution's rows
 * @param {'CLASS'|'TEACHER'} props.mode
 * @param {string|null} props.entityId
 * @param {string}    props.branchFilter  'ALL' or a branch id
 * @param {object}    props.directory     id -> name reference data
 */
export function ScheduleGrid({
  days = [],
  placements = [],
  mode = 'CLASS',
  entityId = null,
  branchFilter = 'ALL',
  directory,
}) {
  const entityKey = mode === 'TEACHER' ? 'teacherId' : 'classId';
  const cells = indexRows(placements, { entityKey, entityId, branchFilter });
  const resolvers = useResolvers(directory);
  const layout = buildLayout(days);

  const entityName = mode === 'TEACHER'
    ? directory?.teachers?.find((t) => t.id === entityId)?.name
    : directory?.classes?.find((c) => c.id === entityId)?.name;

  if (!entityId) {
    return (
      <p className="tkb-empty" data-testid="grid-no-entity">
        Select a {mode === 'TEACHER' ? 'teacher' : 'class'} to see its timetable.
      </p>
    );
  }

  // A response at a reduced `placements` level genuinely has no rows
  // to draw, and saying so beats rendering an empty grid that reads
  // as a schedule with holes in it.
  if ((placements ?? []).length === 0) {
    return (
      <p className="tkb-empty" data-testid="grid-no-placements">
        This solution carries no slot table in this response, so there is no timetable to draw.
      </p>
    );
  }

  return (
    <div className="tkb-grid-wrap">
      <p className="tkb-grid-title" data-testid="grid-title">
        {mode === 'TEACHER' ? 'Teacher timetable' : 'Class timetable'}
        {entityName ? <> — <strong>{entityName}</strong></> : null}
      </p>
      <table className="tkb-grid" data-testid="schedule-grid">
        <thead>
          <tr>
            {/* Two columns are spanned, not one: the body has a
                session column and a period column, and a header that
                spans only the second is one column short, so every
                day heading sits over the wrong cell. */}
            <th scope="col" colSpan={2}>Period</th>
            {days.map((d) => (
              <th scope="col" key={d.day} data-day={d.day}>{dayLabel(d)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {layout.map(({ session, periods }) =>
            periods.map((period, indexInSession) => (
              <tr key={`${session}-${period}`}>
                {indexInSession === 0 ? (
                  <th scope="rowgroup" rowSpan={periods.length} className="tkb-session">
                    {sessionLabel(session)}
                  </th>
                ) : null}
                <th scope="row" className="tkb-period">{period}</th>
                {days.map((d) => {
                  const row = cells.get(`${d.day}|${session}|${period}`);
                  if (!row) {
                    return <td key={d.day} className="tkb-cell tkb-cell-empty">—</td>;
                  }
                  // A teacher cell leads with WHAT they teach; a class
                  // cell leads with WHO teaches it. Same data,
                  // different question.
                  const primary = mode === 'TEACHER'
                    ? resolvers.subject(row.subjectId)
                    : resolvers.teacher(row.teacherId);
                  const secondary = mode === 'TEACHER'
                    ? resolvers.teacher(row.teacherId)
                    : resolvers.subject(row.subjectId);
                  return (
                    <td key={d.day} className="tkb-cell" data-testid="tkb-cell-filled">
                      <span className="tkb-cell-primary">{primary}</span>
                      <span className="tkb-cell-secondary">{secondary}</span>
                      <span className="tkb-cell-branch">{resolvers.branch(row.branchId)}</span>
                    </td>
                  );
                })}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}