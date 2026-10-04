// PHASE 24.1 — Variant expansion diagnostic in BALANCED mode
// Show which assignments have multiple variants with full ID prefixes

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { isEligibleFor } from '../src/domain/eligibility.js';

const full = loadFromLegacySaplich();
const input = full.scheduling;

function expandVariantsForBalanced(a, input) {
  // BASE: only pre-set teacher
  let variants = [];
  if (a.teacherId) {
    variants.push({ teacherId: a.teacherId, branchId: a.branchId });
  }
  // BALANCED expansion: add all eligible teachers whose home branch
  // matches effectiveBranchId
  const classRec = Array.isArray(input.classes)
    ? input.classes.find((c) => c.id === a.classId)
    : null;
  const classBranchId = classRec?.branchId ?? null;
  const effectiveBranchId = a.branchId ?? classBranchId;
  const allEligible = (input.teachers ?? []).filter(
    (t) => isEligibleFor(t, a.subjectId),
  );
  const extra = [];
  for (const t of allEligible) {
    const home = t.homeBranchId;
    if (!home) continue;
    if (effectiveBranchId && home !== effectiveBranchId) {
      if (!Array.isArray(t.allowedTransferBranches) || !t.allowedTransferBranches.includes(effectiveBranchId)) continue;
    }
    if (variants.some((v) => v.teacherId === t.id && v.branchId === home)) continue;
    extra.push({ teacherId: t.id, branchId: home });
  }
  return [...variants, ...extra];
}

// Distribution of variant counts
const variantCounts = new Map();
const multiVariantAssignments = [];
let totalAssignments = 0;
for (const a of input.assignments) {
  totalAssignments++;
  const variants = expandVariantsForBalanced(a, input);
  variantCounts.set(variants.length, (variantCounts.get(variants.length) ?? 0) + 1);
  if (variants.length > 1) {
    multiVariantAssignments.push({
      aId: a.id,
      preSet: a.teacherId,
      subjectId: a.subjectId,
      branchId: a.branchId,
      variantCount: variants.length,
      teachers: variants.map((v) => v.teacherId),
    });
  }
}

console.log(`Total assignments: ${totalAssignments}`);
console.log();
console.log('Variant count distribution (BASE = 1 for all; BALANCED expands):');
for (const [count, n] of [...variantCounts.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${count} variants: ${n} assignments`);
}
console.log();
console.log(`Multi-variant assignments (BALANCED): ${multiVariantAssignments.length}`);
console.log();

// Print 10 sample multi-variant assignments
console.log('Sample multi-variant assignments (first 10):');
for (const a of multiVariantAssignments.slice(0, 10)) {
  console.log(`  ${a.aId} (subj=${a.subjectId.slice(-8)} branch=${a.branchId.slice(-8)}):`);
  console.log(`    pre-set teacher: ${a.preSet.slice(-8)}`);
  console.log(`    ${a.variantCount} variants: ${a.teachers.map((t) => t.slice(-8)).join(', ')}`);
}
console.log();

// Now look at the assignments that actually differ
console.log('Variant lists for the assignments that DIFFER between BASE and BALANCED:');
console.log();
const differingIds = new Set([
  '6a95e5f9a4aafcb22d41b06f', '6a95e5f9a4aafcb22d41b075',
  '6a95e5f9a4aafcb22d41b07b', '6a95e5f9a4aafcb22d41b081',
  '6a95e5f9a4aafcb22d41b0a5', '6a95e5f9a4aafcb22d41b0b1',
  '6a95e5f9a4aafcb22d41b13e', '6a95e5f9a4aafcb22d41b144',
  '6a95e5f9a4aafcb22d41b12c', '6a95e5f9a4aafcb22d41b132',
]);
for (const aId of differingIds) {
  const a = input.assignments.find((a) => a.id === aId);
  if (!a) continue;
  const variants = expandVariantsForBalanced(a, input);
  console.log(`  ${aId} (subj=${a.subjectId.slice(-8)} branch=${a.branchId.slice(-8)}):`);
  console.log(`    pre-set: ${a.teacherId.slice(-8)}`);
  console.log(`    ${variants.length} variants: ${variants.map((v) => v.teacherId.slice(-8)).join(', ')}`);
}