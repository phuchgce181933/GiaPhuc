const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const env = require('../../src/config');
test('Canva refresh token survives service restart, stays encrypted and rotates sequentially', async () => {
  const name = 'presentation_qa_' + crypto.randomBytes(6).toString('hex');
  const connection = await mongoose.createConnection(env.PRESENTATION.MONGODB_URI, { dbName: name }).asPromise();
  const db = require('../../src/config/db'); const originalConnect = db.connectPresentationDB;
  const originalFetch = global.fetch; const originalCanva = { ...env.PRESENTATION.CANVA }; const originalEncryption = env.PRESENTATION.TOKEN_ENCRYPTION_KEY;
  db.connectPresentationDB = async () => connection;
  env.PRESENTATION.CANVA = { CLIENT_ID: 'QA-client', CLIENT_SECRET: 'QA-secret', REDIRECT_URI: 'http://127.0.0.1:5001/api/presentations/canva/callback', SCOPES: 'design:content:read design:content:write' };
  env.PRESENTATION.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  let counter = 0;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.canva.com/rest/v1/oauth/token');
    const body = options.body;
    if (body.get('grant_type') === 'authorization_code') assert.equal(body.get('redirect_uri'), env.PRESENTATION.CANVA.REDIRECT_URI);
    else assert.equal(body.get('refresh_token'), 'QA-refresh-' + counter);
    counter++;
    return { ok: true, json: async () => ({ access_token: 'QA-access-' + counter, refresh_token: 'QA-refresh-' + counter, expires_in: 3600 }) };
  };
  try {
    delete require.cache[require.resolve('../../src/modules/presentation/presentation.model')];
    delete require.cache[require.resolve('../../src/modules/presentation/presentation.service')];
    let service = require('../../src/modules/presentation/presentation.service');
    const authorizationUrl = new URL(service.oauthStart('QA-user'));
    await service.oauthCallback('QA-code', authorizationUrl.searchParams.get('state'));
    const { getCanvaAccountModel } = require('../../src/modules/presentation/presentation.model'); const model = await getCanvaAccountModel();
    const record = await model.findById('QA-user').lean(); assert.equal(record.refreshToken, undefined);
    const privateRecord = await model.findById('QA-user').select('+refreshToken').lean(); assert.ok(!privateRecord.refreshToken.includes('QA-refresh'));
    delete require.cache[require.resolve('../../src/modules/presentation/presentation.service')];
    service = require('../../src/modules/presentation/presentation.service');
    assert.equal(await service.accessToken({ ownerId: 'QA-user' }), 'QA-access-2');
    const tokens = await Promise.all([service.accessToken({ ownerId: 'QA-user' }), service.accessToken({ ownerId: 'QA-user' })]);
    assert.deepEqual(tokens, ['QA-access-3', 'QA-access-4']);
    global.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(service.accessToken({ ownerId: 'QA-user' }), e => e.statusCode === 503);
  } finally {
    global.fetch = originalFetch; db.connectPresentationDB = originalConnect; env.PRESENTATION.CANVA = originalCanva; env.PRESENTATION.TOKEN_ENCRYPTION_KEY = originalEncryption;
    assert.ok(connection.name.startsWith('presentation_qa_')); await connection.dropDatabase(); await connection.close();
  }
});
