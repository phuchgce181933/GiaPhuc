const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function headerHtml(columns, headerRows) {
  const rows = headerRows?.length ? headerRows.map(row => `<tr>${row.map(cell => `<th${cell.colSpan ? ` colspan="${cell.colSpan}"` : ''}${cell.rowSpan ? ` rowspan="${cell.rowSpan}"` : ''}>${escapeHtml(cell.label)}</th>`).join('')}</tr>`).join('') : `<tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr>`;
  return `<thead>${rows}</thead>`;
}
export function downloadExcel(filename, title, columns, rows, headerRows) {
  const table = `<html><head><meta charset="utf-8"></head><body><h1>${escapeHtml(title)}</h1><table border="1">${headerHtml(columns, headerRows)}<tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
  const blob = new Blob([`\ufeff${table}`], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${filename}.xls`; link.click(); URL.revokeObjectURL(link.href);
}
export function printPdf(title, columns, rows, headerRows) {
  const table = `<table>${headerHtml(columns, headerRows)}<tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const html = `<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>@page{size:landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#111}h1{text-align:center;font-size:20px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #555;padding:5px;text-align:left;white-space:pre-line}th{background:#dbeafe}</style></head><body><h1>${escapeHtml(title)}</h1>${table}<script>window.addEventListener('load',function(){window.focus();setTimeout(function(){window.print()},150)});</script></body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const popup = window.open(url, '_blank');
  if (!popup) { URL.revokeObjectURL(url); return false; }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
