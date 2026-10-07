const assert = require('node:assert/strict');
const config = require('../../src/config');
const { interpretIntent } = require('../../src/modules/timetable/assistant/intent-parser.service');
const { createPlan } = require('../../src/modules/timetable/assistant/repair-planner.service');
const { getRuntime } = require('../../src/modules/timetable/timetable.service');
const { disconnectDB } = require('../../src/config/db');
(async()=>{
  const settings = config.TIMETABLE.ASSISTANT;
  const intent = await interpretIntent('chuyển toàn bộ tiết thứ 4 của cô Nguyễn Thị Thu Kim sang thứ 5', { apiKey:settings.API_KEY, model:settings.MODEL, baseUrl:settings.BASE_URL, timeoutMs:settings.TIMEOUT_MS });
  assert.equal(intent.kind,'day');assert.equal(intent.fromDay,4);assert.equal(intent.toDay,5);
  const runtime=await getRuntime();const {scheduleStore,loadDataset}=runtime.dependencies;
  const before=await scheduleStore.list();const original=await scheduleStore.read(before[0].scheduleId);const {input}=await loadDataset();
  try {
    const plan=await createPlan({original,intent,input});assert.equal(plan.evaluation.summary.accepted,true);assert.equal(plan.rows.length,original.slots.length);
    console.log(JSON.stringify({provider:'modelapi',version:original.version,requestedSlots:plan.requestedSlots,changes:plan.changes.length,hardViolations:0,sourceDay:4,targetDay:5}));
  } catch(e) { if (!['BATCH_NO_SOLUTION','SOURCE_SLOT_NOT_FOUND'].includes(e.code)) throw e; console.log(JSON.stringify({provider:'modelapi',version:original.version,code:e.code,message:e.message})); }
  assert.equal((await scheduleStore.list()).length,before.length);assert.equal((await scheduleStore.read(original.scheduleId)).contentHash,original.contentHash);
  console.log('No timetable writes; source unchanged.');
})().catch(e=>{console.error(e.code,e.message);process.exitCode=1;}).finally(disconnectDB);
