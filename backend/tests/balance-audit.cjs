const mongoose = require('mongoose');
const assert = require('node:assert/strict');
const config = require('../src/config');
(async () => {
  const connection = await mongoose.createConnection(config.TIMETABLE.MONGODB_URI, { dbName: config.TIMETABLE.MONGODB_DB }).asPromise();
  try {
    const { loadMongoStores } = await import('../src/modules/timetable/engine/persistence/mongo-store.js');
    const { loadBenchmarkDataset } = await import('../src/modules/timetable/engine/loader/catalog-dataset.js');
    const { candidateFromRows } = require('../src/modules/timetable/assistant/repair-planner.service');
    const { optimizeSubjectTeacherBalance } = await import('../src/modules/timetable/engine/domain/subject-teacher-balance.js');
    const { evaluateCandidate } = await import('../src/modules/timetable/engine/domain/constraints/index.js');
    const { deriveMetrics } = await import('../src/modules/timetable/engine/domain/metrics.js');
    const { compareOptimizationCandidates, globalObjective } = await import('../src/modules/timetable/engine/domain/comparator.js');
    const stores = await loadMongoStores(connection);
    const { input } = loadBenchmarkDataset(stores);
    const summaries = await stores.scheduleStore.list();
    const record = await stores.scheduleStore.read(summaries[0].scheduleId);
    const report = candidate => {
      const loads = new Map();
      for (const [id, slots] of candidate.assignments) {
        const a = input.assignmentIndex.get(id);
        const tid = candidate.placements.get(id).teacherId;
        if (!loads.has(a.subjectId)) loads.set(a.subjectId, new Map());
        const group = loads.get(a.subjectId); group.set(tid, (group.get(tid) ?? 0) + slots.length);
      }
      return [...loads].map(([sid, group]) => ({ subject: input.subjects.find(s => s.id === sid)?.name, teachers: [...group].map(([id, total]) => ({ name: input.teachers.find(t => t.id === id)?.hoTen, total })), spread: Math.max(...group.values()) - Math.min(...group.values()) }));
    };
    const candidate = candidateFromRows(record.slots);
    console.log(JSON.stringify({ version: record.version, before: report(candidate), accepted: evaluateCandidate(candidate, input).summary.accepted }));
    const improved = optimizeSubjectTeacherBalance(candidate, input, { timeBudgetMs: 15000, maxSearchNodes: 20000, maxSearchIterations: 100 });
    assert.equal(evaluateCandidate(improved.candidate, input).summary.accepted, true);
    assert.equal([...improved.candidate.assignments.values()].reduce((sum, slots) => sum + slots.length, 0), record.slotCount);
    assert.equal((await stores.scheduleStore.read(record.scheduleId)).contentHash, record.contentHash);
    console.log(JSON.stringify({ after: report(improved.candidate), validation: evaluateCandidate(improved.candidate, input).summary, slotCount: [...improved.candidate.assignments.values()].reduce((sum, slots) => sum + slots.length, 0), diagnostics: improved.diagnostics }));
    const pe = input.subjects.find(s => s.name === 'Giáo dục thể chất');
    const peTeachers = report(candidate).find(s => s.subject === pe.name).teachers;
    const targetTeachers = input.teachers.filter(t => peTeachers.some(p => p.name === t.hoTen && p.total === 14));
    const rejectionCounts = {};
    let acceptedMoves = 0;
    for (const a of input.assignments.filter(a => a.subjectId === pe.id)) {
      const sourceId = candidate.placements.get(a.id)?.teacherId;
      const sourceTeacher = input.teachers.find(t => t.id === sourceId);
      if (!peTeachers.some(t => t.name === sourceTeacher?.hoTen && t.total === 26)) continue;
      for (const teacher of targetTeachers) {
        const proposal = structuredClone(candidate);
        proposal.placements.get(a.id).teacherId = teacher.id;
        for (const slot of proposal.assignments.get(a.id)) slot.teacherId = teacher.id;
        const ev = evaluateCandidate(proposal, input);
        if (ev.summary.accepted) acceptedMoves++;
        for (const v of ev.hard.violations) { const code = v.constraintId ?? v.code; rejectionCounts[code] = (rejectionCounts[code] ?? 0) + 1; }
      }
    }
    console.log(JSON.stringify({ peDirectMoveAudit: { acceptedMoves, rejectionCounts } }));
    const it = input.subjects.find(s => s.name === 'Tin học');
    const itCandidates = input.teachers.filter(t => report(improved.candidate).find(s => s.subject === it.name).teachers.some(p => p.name === t.hoTen && p.total === 13));
    const blockers = {}; let itAccepted = 0;
    for (const a of input.assignments.filter(a => a.subjectId === it.id)) {
      const sourceTeacher = input.teachers.find(t => t.id === improved.candidate.placements.get(a.id)?.teacherId);
      if (sourceTeacher?.hoTen !== 'Huỳnh Văn Danh') continue;
      for (const target of itCandidates) {
        const proposal = structuredClone(improved.candidate);
        proposal.placements.get(a.id).teacherId = target.id;
        for (const slot of proposal.assignments.get(a.id)) slot.teacherId = target.id;
        const ev = evaluateCandidate(proposal, input);
        if (ev.summary.accepted) {
          itAccepted++;
          if (itAccepted === 1) {
            proposal.metrics = deriveMetrics(proposal, input);
            console.log(JSON.stringify({ firstInformaticsMove: { target: target.hoTen, before: globalObjective(improved.candidate), after: globalObjective(proposal), comparator: compareOptimizationCandidates(proposal, improved.candidate), preferenceBefore: improved.candidate.metrics.preferenceBreakdown.transferBranch, preferenceAfter: proposal.metrics.preferenceBreakdown.transferBranch } }));
          }
        }
        for (const violation of ev.hard.violations) { const code = violation.constraintId ?? violation.code; blockers[code] = (blockers[code] ?? 0) + 1; }
      }
    }
    console.log(JSON.stringify({ informaticsAudit: { acceptedMoves: itAccepted, blockers } }));
    if (process.argv.includes('--generate')) {
      const { generateSchedules, PreviewStore } = await import('../src/modules/timetable/engine/api/generate.js');
      const previewStore = new PreviewStore();
      const generated = await generateSchedules({ body: { candidateCount: 1 }, deps: { loadDataset: () => ({ input }), previewStore }, placementDetail: 'all' });
      const entries = previewStore.get(generated.payload.requestId) ?? [];
      console.log(JSON.stringify({ newGeneration: generated.payload.status, solutions: entries.map(entry => ({ loads: report(entry.candidate), validation: evaluateCandidate(entry.candidate, input).summary, diagnostics: entry.candidate.diagnostics?.postCoverageOptimization })) }));
    }
  } finally { await connection.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
