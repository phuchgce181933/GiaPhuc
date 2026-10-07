// Real provider + read-only product data smoke test. Does not commit a schedule.
const assert = require('node:assert/strict');
const env = require('../../src/config');
const { interpretIntent } = require('../../src/modules/timetable/assistant/intent-parser.service');
const assistant = require('../../src/modules/timetable/assistant/assistant.service');
const { getRuntime } = require('../../src/modules/timetable/timetable.service');
const { disconnectDB } = require('../../src/config/db');
(async () => {
  const config = env.TIMETABLE.ASSISTANT;
  const options = { apiKey: config.API_KEY, model: config.MODEL, baseUrl: config.BASE_URL, timeoutMs: config.TIMEOUT_MS };
  const text = 'Chuyển giúp cô Nguyễn Thị Thu Kim tiết đầu buổi sáng thứ sáu sang tiết thứ hai sáng thứ năm nhé';
  const intent = await interpretIntent(text, options);
  assert.equal(intent.teacher, 'Nguyễn Thị Thu Kim'); assert.equal(intent.from.day, 6); assert.equal(intent.to.day, 5); assert.equal(intent.to.period, 2);
  await assert.rejects(interpretIntent('Viết giúp tôi một website bán hàng', options), e => e.code === 'ASSISTANT_OUT_OF_SCOPE');
  await assert.rejects(interpretIntent('Cho cô Kim chuyển sang thứ năm', options), e => e.code === 'INTENT_NEEDS_CLARIFICATION');
  const runtime = await getRuntime(); const { scheduleStore } = runtime.dependencies;
  const before = await scheduleStore.list(); assert.ok(before.length);
  const source = await scheduleStore.read(before[0].scheduleId);
  const row = source.slots.find(s => s.session === 'sang');
  const name = source.directory.teachers.find(t => t.id === row.teacherId).name;
  const toDay = row.day === 5 ? 4 : 5;
  const request = `Chuyển giúp giáo viên ${name} từ tiết ${row.period} sáng thứ ${row.day + 1} sang tiết 2 sáng thứ ${toDay + 1}`;
  const plan = await assistant.preview({ body: { scheduleId: source.scheduleId, text: request }, dependencies: runtime.dependencies, config: env.TIMETABLE });
  assert.equal(plan.intent.parser, 'modelapi'); assert.ok(plan.changes.length);
  assert.equal((await scheduleStore.list()).length, before.length);
  assert.equal((await scheduleStore.read(source.scheduleId)).contentHash, source.contentHash);
  console.log(JSON.stringify({ provider: 'modelapi', naturalLanguage: 'passed', unsupported: 'rejected', clarification: 'passed', preview: 'created', sourceVersion: source.version, changes: plan.changes.length, hardViolations: plan.evaluation.summary.totalHardViolations, scheduleWrites: 0 }));
})().catch(e => { console.error(e.code ?? 'LIVE_TEST_FAILED', e.message); process.exitCode = 1; }).finally(disconnectDB);
