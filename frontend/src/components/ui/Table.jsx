import './Table.css';

export function Table({ columns, rows, loading, empty, rowKey = '_id' }) {
  return (
    <div className="gp-table">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={columns.length} className="gp-table__state">Đang tải…</td></tr>
          ) : !rows || rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="gp-table__state">{empty || 'Chưa có dữ liệu'}</td></tr>
          ) : rows.map((row, idx) => (
            <tr key={row[rowKey] || idx}>
              {columns.map((c) => (
                <td key={c.key}>{c.render ? c.render(row) : row[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
