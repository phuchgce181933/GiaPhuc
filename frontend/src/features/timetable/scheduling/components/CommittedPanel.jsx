export function CommittedPanel({
  schedules = [],
  onRefresh,
  refreshing = false,
  onOpen,
  onDelete
}) {
  const date = value => new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok'
  }).format(new Date(value));
  return <section className="tkb-committed" data-testid="committed-panel">
    <div className="tkb-committed-head"><div><h2>Thời khóa biểu đã lưu</h2>
      <p className="tkb-hint" data-testid="committed-count">{schedules.length ? `Đã lưu ${schedules.length} thời khóa biểu.` : refreshing ? 'Đang tải lịch đã lưu…' : 'Chưa có thời khóa biểu nào được lưu. Tạo lịch không đồng nghĩa với lưu lịch.'}</p></div>
      <button onClick={onRefresh} disabled={refreshing} data-testid="committed-refresh">{refreshing ? 'Đang tải…' : 'Tải lại'}</button></div>
    {schedules.length > 0 && <div className="tkb-grid-wrap"><table className="tkb-committed-table"><thead><tr><th>Lịch bộ môn</th><th>Số tiết</th><th>Đã lưu</th><th>Thao tác</th></tr></thead>
      <tbody>{schedules.map(s => <tr key={s.scheduleId} data-testid="committed-row" data-schedule-id={s.scheduleId}>
        <th scope="row">Phiên bản {s.version ?? '—'}<details><summary>Thông tin kiểm tra</summary><code>{s.scheduleId}</code><br /><code>{s.solutionId ?? '—'}</code><p className="tkb-hash" title={s.contentHash}>{s.contentHash ?? '—'}</p></details></th>
        <td>{s.slotCount ?? '—'}</td><td>{s.committedAt ? date(s.committedAt) : '—'}</td><td><button disabled={!onOpen} onClick={() => onOpen?.(s.scheduleId)}>Xem lịch</button>{onDelete && <button className="tkb-danger-button" onClick={() => onDelete(s.scheduleId)}>Xóa</button>}</td>
      </tr>)}</tbody></table></div>}
  </section>;
}
