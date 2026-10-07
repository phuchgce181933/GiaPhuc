// Layer 5 — LEGACY BASELINE.
//
// Assembles a frozen, append-only bundle of the historical
// data. This is the artifact a future phase will compare against
// new solver outputs (per §26 of the brief).
//
// It is NOT consumed by the solver. It is exposed for analysis,
// regression, and warm-start.

/**
 * @param {ReturnType<typeof import('./normalize.js').normalizeAll>} normalized
 * @returns {{
 *   assignments: object[],
 *   scheduleSlots: object[],
 *   transferHistory: object[],
 *   teacherWorkloadSnapshot: { id: string, name: string, teachingWorkloadLegacy: number | null }[],
 *   scheduleMetadata: object[],
 *   classIds: Set<string>,
 *   teacherIds: Set<string>,
 *   summary: { totalAssignments: number, totalSlots: number, totalTransfers: number, transferredAssignments: number, transferredAssignmentsWithoutOrigin: number },
 * }}
 */
export function buildLegacyBaseline(normalized) {
  const assignments = normalized.historicalAssignments.map((a) => ({ ...a }));
  const scheduleSlots = normalized.historicalScheduleSlots.map((s) => ({ ...s }));
  const transferHistory = normalized.transferHistory.map((t) => ({ ...t }));
  const scheduleMetadata = normalized.historicalSchedule.map((s) => ({ ...s }));

  // Teacher workload snapshot is the `teachingWorkload` field
  // preserved verbatim. The brief says: do NOT overwrite source.
  const teacherWorkloadSnapshot = normalized.teachers.map((t) => ({
    id: t.id,
    name: t.name,
    teachingWorkloadLegacy: t.teachingWorkload,
  }));

  const transferredAssignments = assignments.filter((a) => a.isTransferred).length;
  const transferredAssignmentsWithoutOrigin = assignments.filter(
    (a) => a.isTransferred && a.transferredFromTeacher == null
  ).length;

  return {
    assignments,
    scheduleSlots,
    transferHistory,
    teacherWorkloadSnapshot,
    scheduleMetadata,
    classIds: new Set(normalized.classes.map((c) => c.id)),
    teacherIds: new Set(normalized.teachers.map((t) => t.id)),
    summary: {
      totalAssignments: assignments.length,
      totalSlots: scheduleSlots.length,
      totalTransfers: transferHistory.length,
      transferredAssignments,
      transferredAssignmentsWithoutOrigin,
    },
  };
}