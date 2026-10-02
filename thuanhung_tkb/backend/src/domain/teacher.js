// Normalize a teacher record from the authoritative fixture or MongoDB.
// The output shape is the contract; this is the ONLY place that maps
// the raw source shape to the contract.

/**
 * @param {any} raw
 * @returns {{
 *   id: string,
 *   hoTen: string,
 *   email: string,
 *   soDienThoai: string,
 *   trangThai: string,
 *   chuyenMon: { tenChuyenMon: string, soTietTuan: number }[],
 *   nguyenVong: { soBuoiToiDa: number, buoiUuTien: string, thuNghi: number[] } | null,
 *   homeBranchId: string | null,
 * }}
 */
export function normalizeTeacher(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Teacher record must be an object');
  }
  const id = extractId(raw);
  const hoTen = String(raw.hoTen ?? '').trim();
  if (!id) throw new TypeError('Teacher record missing _id');
  if (!hoTen) throw new TypeError(`Teacher ${id} missing hoTen`);

  const chuyenMon = Array.isArray(raw.chuyenMon) ? raw.chuyenMon.map((s, i) => ({
    tenChuyenMon: String(s?.tenChuyenMon ?? '').trim(),
    soTietTuan: Number(s?.soTietTuan ?? 0),
  })) : [];

  if (chuyenMon.length === 0) {
    throw new TypeError(`Teacher ${id} (${hoTen}) has empty chuyenMon`);
  }

  const nguyenVong = raw.nguyenVong ? {
    soBuoiToiDa: Number(raw.nguyenVong.soBuoiToiDa ?? 0),
    buoiUuTien: String(raw.nguyenVong.buoiUuTien ?? 'ca_hai'),
    thuNghi: Array.isArray(raw.nguyenVong.thuNghi) ? raw.nguyenVong.thuNghi.map(Number) : [],
  } : null;

  return {
    id,
    hoTen,
    email: String(raw.email ?? ''),
    soDienThoai: String(raw.soDienThoai ?? ''),
    trangThai: String(raw.trangThai ?? 'active'),
    chuyenMon,
    nguyenVong,
    homeBranchId: raw.homeBranchId ?? null,
  };
}

function extractId(raw) {
  if (typeof raw._id === 'string') return raw._id;
  if (raw._id && typeof raw._id === 'object' && typeof raw._id.$oid === 'string') return raw._id.$oid;
  if (typeof raw.id === 'string') return raw.id;
  return null;
}

/**
 * Surface optional fields that are absent. The contract is to report,
 * not invent.
 */
export function teacherMissingFields(t) {
  const out = [];
  if (!t.email) out.push({ entity: 'teacher', entityId: t.id, field: 'email', reason: 'empty_in_source' });
  if (!t.soDienThoai) out.push({ entity: 'teacher', entityId: t.id, field: 'soDienThoai', reason: 'empty_in_source' });
  if (!t.nguyenVong) out.push({ entity: 'teacher', entityId: t.id, field: 'nguyenVong', reason: 'absent_in_source' });
  if (!t.homeBranchId) out.push({ entity: 'teacher', entityId: t.id, field: 'homeBranchId', reason: 'absent_in_source' });
  return out;
}
