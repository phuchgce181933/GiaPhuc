import test from 'node:test';
import assert from 'node:assert/strict';
import parser from '../../src/modules/timetable/assistant/intent-parser.service.js';
const move = { action: 'move_lesson', teacher: 'Kim', from: { day: 6, session: 'sang', period: 1 }, to: { day: 5, session: 'sang', period: 2 }, clarification: '' };
const options = result => ({ apiKey: 'test-key', model: 'codex-auto-review', baseUrl: 'https://modelapi.vn/v1', fetcher: async (url, request) => {
  assert.equal(url, 'https://modelapi.vn/v1/chat/completions');
  const body = JSON.parse(request.body); assert.equal(body.model, 'codex-auto-review'); assert.equal(body.messages[1].role, 'user'); assert.equal(body.stream, false);
  assert.equal(body.messages.length, 2); assert.equal(body.slots, undefined);
  return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }) };
} });
test('ModelAPI intent preserves Vietnamese weekdays and session-local periods', async () => {
  const result = await parser.interpretIntent('Chuyển giúp cô Kim tiết đầu sáng thứ sáu sang tiết hai sáng thứ năm', options(move));
  assert.equal(result.parser, 'modelapi'); assert.deepEqual(result.from, move.from); assert.deepEqual(result.to, move.to);
});
test('out-of-scope request is rejected before planner', async () => {
  await assert.rejects(parser.interpretIntent('Viết code React', options({ action: 'unsupported', teacher: null, from: null, to: null, clarification: 'No' })), e => e.code === 'ASSISTANT_OUT_OF_SCOPE' && e.status === 422);
});
test('missing time asks a specific clarification instead of inventing coordinates', async () => {
  await assert.rejects(parser.interpretIntent('Cô Kim chuyển sang thứ năm', options({ ...move, action: 'clarify', to: null, clarification: 'Chuyển sang buổi nào và tiết mấy?' })), e => e.code === 'INTENT_NEEDS_CLARIFICATION' && e.message.includes('tiết mấy'));
});
test('invalid model JSON, arbitrary slots and invalid weekdays fail closed', async () => {
  for (const invalid of [{ ...move, slots: [] }, { ...move, from: { ...move.from, day: 1 } }, { ...move, teacher: null }]) await assert.rejects(parser.interpretIntent('Yêu cầu', options(invalid)), e => e.status === 503);
});
test('provider failure does not expose secret or raw upstream output', async () => {
  await assert.rejects(parser.interpretIntent('Yêu cầu', { apiKey: 'test-secret', fetcher: async () => { throw new Error('test-secret'); } }), e => e.status === 503 && !e.message.includes('test-secret'));
});
test('empty requests are rejected before the provider is called', async () => {
  await assert.rejects(parser.interpretIntent(' ', { apiKey: 'key', fetcher: () => { throw new Error('should not call'); } }), e => e.status === 400);
});
test('whole day request is structured without invented source periods', async () => {
  const result = await parser.interpretIntent('chuyển toàn bộ tiết thứ 4 của cô kim sang thứ 5', options({ action: 'move_day', teacher: 'kim', from: null, to: null, clarification: '', dayMove: { fromDay: 4, toDay: 5, fromSession: null, toSession: null }, moves: null }));
  assert.equal(result.kind, 'day'); assert.equal(result.fromDay, 4); assert.equal(result.toDay, 5); assert.equal(result.from, undefined);
});
test('multiple explicit moves preserve the complete move list', async () => {
  const item = { teacher: 'Kim', from: move.from, to: move.to };
  const result = await parser.interpretIntent('Chuyển 2 tiết', options({ action: 'move_many', teacher: null, from: null, to: null, clarification: '', dayMove: null, moves: [item, { ...item, from: { ...move.from, period: 3 } }] }));
  assert.equal(result.kind, 'many'); assert.equal(result.moves.length, 2);
});
