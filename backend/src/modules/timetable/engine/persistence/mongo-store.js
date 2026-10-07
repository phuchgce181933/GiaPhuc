import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFromLegacySaplich, buildSchedulingModel } from '../loader/legacy-saplich/index.js';
import { config } from '../config/index.js';
import { validatePreferences } from './teacher-preference-store.js';
import { CatalogStore } from '../catalog/catalog.store.js';
import { ScheduleStoreError, scheduleIdFor } from './schedule-store.js';
import { contentHash } from './schedule-record.js';
import { buildPreviewRecord, deserializeCandidate, verifyPreviewRecord, isPreviewId, isExpired,
  PREVIEW_KIND, PREVIEW_SCHEMA_VERSION, PREVIEW_LIFECYCLE, PREVIEW_INTEGRITY } from './preview-record.js';

const emptyCatalog = () => ({ schemaVersion: 1, revision: 0, teachers: {}, subjects: {}, classes: {} });
const copy = (value) => structuredClone(value);
function assertSeparateDatabase(db) {
  if (!db?.databaseName || db.databaseName.toLowerCase() === config.mainDatabaseName.toLowerCase()) {
    throw new Error('Timetable storage must not use the GiaPhuc database.');
  }
}
const withoutId = (document) => { const { _id, ...value } = document; return value; };
function validateCatalog(value) {
  if (value?.schemaVersion !== 1 || !Number.isInteger(value.revision)
    || ['teachers', 'subjects', 'classes'].some((key) => !value[key] || Array.isArray(value[key]) || typeof value[key] !== 'object')) {
    throw new Error('Invalid persisted timetable catalog.');
  }
  return value;
}

// Optimistic revision updates also protect writers in different Node processes.
async function revise(collection, id, empty, change) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const current = await collection.findOne({ _id: id });
    const next = change(copy(current?.value ?? empty()));
    const revision = current?.revision ?? 0;
    if (current) {
      const result = await collection.updateOne({ _id: id, revision }, { $set: { value: next, revision: revision + 1 } });
      if (result.matchedCount) return next;
    } else {
      try { await collection.insertOne({ _id: id, value: next, revision: 1 }); return next; }
      catch (error) { if (error.code !== 11000) throw error; }
    }
  }
  throw new Error('Concurrent timetable update did not complete. Retry without discarding changes.');
}

class MongoCatalogStore {
  constructor(collection, state, source) { this.collection = collection; this.state = validateCatalog(state); this.source = source; }
  read() { return copy(this.state); }
  async update(change) {
    let result;
    this.state = await revise(this.collection, 'catalog', emptyCatalog, (state) => {
      validateCatalog(state); result = change(state); state.revision += 1; return validateCatalog(state);
    });
    return result;
  }
}

class MongoPreferenceStore {
  constructor(collection, preferences) { this.collection = collection; this.preferences = validatePreferences(preferences); }
  readAll() { return copy(this.preferences); }
  get(id) { return this.preferences[id] ?? null; }
  put(id, value) { return this.update(id, () => value); }
  async update(id, change) {
    const value = await revise(this.collection, id, () => null, (previous) => {
      if (previous !== null) validatePreferences({ [id]: previous });
      return validatePreferences({ [id]: change(previous) })[id];
    });
    this.preferences[id] = value;
    return value;
  }
}

export class MongoScheduleStore {
  constructor(db) { assertSeparateDatabase(db); this.collection = db.collection('schedules'); this.counters = db.collection('counters'); this.driver = 'mongodb'; }
  async withLock(_id, action) { return action(); } // unique index is the cross-process lock
  async read(id) {
    if (!/^sch-[0-9a-f]{16}$/.test(id ?? '')) return null;
    const document = await this.collection.findOne({ _id: id });
    if (!document) return null;
    const record = withoutId(document);
    if (record.scheduleId !== id || record.validated !== true || !Array.isArray(record.slots)
      || record.slotCount !== record.slots.length || contentHash(record.slots) !== record.contentHash) {
      await this.collection.updateOne({ _id: id }, { $set: { integrityFailed: true } });
      throw new ScheduleStoreError('RECORD_CORRUPT', 'Stored timetable failed integrity verification.');
    }
    return record;
  }
  async list() {
    return (await this.collection.find({ integrityFailed: { $ne: true } }, { projection: { _id: 0, slots: 0, directory: 0, calendar: 0, travel: 0 } })
      .sort({ version: -1, scheduleId: 1 }).toArray());
  }
  async create(id, build) {
    const existing = await this.collection.findOne({ _id: id });
    if (existing) {
      const record = await this.read(id);
      if (!record) throw new ScheduleStoreError('RECORD_CORRUPT', 'Existing timetable failed integrity verification.');
      return { created: false, record };
    }
    const counter = await this.counters.findOneAndUpdate({ _id: 'schedule-version' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
    const record = build(counter.value);
    if (record.scheduleId !== id || id !== scheduleIdFor(record.requestId, record.solutionId)) throw new ScheduleStoreError('MALFORMED_RECORD', 'Invalid timetable identity.');
    try { await this.collection.insertOne({ _id: id, ...record }); return { created: true, record }; }
    catch (error) {
      if (error.code !== 11000) throw error;
      const duplicate = await this.read(id);
      if (!duplicate) throw new ScheduleStoreError('RECORD_CORRUPT', 'Duplicate timetable could not be verified.');
      return { created: false, record: duplicate };
    }
  }
  async health() {
    const counter = await this.counters.findOne({ _id: 'schedule-version' });
    return { implemented: true, driver: this.driver, atomic: true, versionAllocation: 'MONGODB_COUNTER',
      versionHighWaterMark: counter?.value ?? 0, recordCount: await this.collection.countDocuments(),
      corruptRecordCount: await this.collection.countDocuments({ integrityFailed: true }),
      integrity: 'VERIFIED_ON_READ', staleTempFileCount: 0, idempotency: 'requestId+solutionId' };
  }
}

export class MongoPreviewStore {
  constructor(db, options = {}) {
    assertSeparateDatabase(db);
    this.collection = db.collection('previews'); this.schedules = db.collection('schedules');
    this.driver = 'mongodb'; this.limit = options.limit ?? config.previewLimit;
    this.ttlSeconds = options.ttlSeconds ?? config.previewTtlSeconds;
  }
  inspect(record, id) {
    const base = { requestId: id, solutionIds: [], integrity: PREVIEW_INTEGRITY.NOT_TRACKED };
    if (!isPreviewId(id)) return { ...base, lifecycle: PREVIEW_LIFECYCLE.INVALID, reason: 'MALFORMED_ID', integrity: PREVIEW_INTEGRITY.FAILED };
    if (!record) return { ...base, lifecycle: PREVIEW_LIFECYCLE.MISSING, reason: 'NOT_STORED' };
    if (record.kind !== PREVIEW_KIND || record.schemaVersion !== PREVIEW_SCHEMA_VERSION || !Array.isArray(record.solutions)) {
      return { ...base, lifecycle: PREVIEW_LIFECYCLE.INVALID, reason: 'NOT_A_PREVIEW', integrity: PREVIEW_INTEGRITY.FAILED };
    }
    const integrity = verifyPreviewRecord(record);
    const details = { ...base, createdAt: record.createdAt, expiresAt: record.expiresAt, integrity: integrity.integrity,
      solutionIds: record.solutions.map((s) => s.id), mismatched: integrity.mismatched };
    if (!integrity.ok) return { ...details, lifecycle: PREVIEW_LIFECYCLE.INVALID, reason: 'HASH_MISMATCH' };
    if (isExpired(record, new Date().toISOString())) return { ...details, lifecycle: PREVIEW_LIFECYCLE.EXPIRED, reason: 'TTL' };
    return { ...details, lifecycle: PREVIEW_LIFECYCLE.AVAILABLE, reason: null };
  }
  async describe(id) { return this.inspect(isPreviewId(id) ? await this.collection.findOne({ _id: id }) : null, id); }
  async get(id) {
    const record = isPreviewId(id) ? await this.collection.findOne({ _id: id }) : null;
    if (this.inspect(record, id).lifecycle !== PREVIEW_LIFECYCLE.AVAILABLE) return null;
    return record.solutions.map((s) => ({ ...s, candidate: deserializeCandidate(s.candidate) }));
  }
  async put(id, solutions) {
    if (!isPreviewId(id)) return { stored: false, reason: 'MALFORMED_ID' };
    const record = buildPreviewRecord({ requestId: id, solutions, createdAt: new Date().toISOString(), ttlSeconds: this.ttlSeconds });
    const result = await this.collection.updateOne({ _id: id }, { $setOnInsert: record }, { upsert: true });
    await this.prune();
    return { stored: true, duplicate: !result.upsertedCount, record };
  }
  async prune() {
    const protectedIds = await this.schedules.distinct('requestId');
    const excess = await this.collection.find({ requestId: { $nin: protectedIds } }, { projection: { _id: 1 } })
      .sort({ createdAt: -1, _id: -1 }).skip(this.limit).toArray();
    if (excess.length) await this.collection.deleteMany({ _id: { $in: excess.map((r) => r._id) } });
  }
  async available() {
    return this.collection.find({ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date().toISOString() } }] }, { projection: { _id: 1 } }).toArray();
  }
  async stats() { return { stored: await this.collection.countDocuments(), ttlSeconds: this.ttlSeconds, limit: this.limit }; }
}

// Runs once on startup; $setOnInsert preserves existing MongoDB records on restart.
export async function initializeMongoTimetable(connection) {
  const db = connection.db;
  assertSeparateDatabase(db);
  await db.collection('schedules').createIndex({ version: 1 }, { unique: true });
  await db.collection('previews').createIndex({ createdAt: -1 });
  const source = db.collection('sources');
  if (!await source.findOne({ _id: 'legacy-catalog' })) {
    const loaded = loadFromLegacySaplich();
    const value = JSON.parse(JSON.stringify({ normalized: loaded.normalized, inventory: loaded.inventory, integrity: loaded.integrity,
      serverVersion: loaded.serverVersion, toolVersion: loaded.toolVersion }));
    await source.updateOne({ _id: 'legacy-catalog' }, { $setOnInsert: { value, importedAt: new Date().toISOString() } }, { upsert: true });
  }
  if (await db.collection('migrations').findOne({ _id: 'legacy-state-v1' })) return db;
  // Validate all file inputs before importing, including preferences (never fallback to {}).
  const catalog = new CatalogStore(resolve(config.catalogDir, 'catalog.json')).read();
  const preferenceFile = resolve(config.persistenceDir, 'teacher-preferences.json');
  const preferences = existsSync(preferenceFile) ? validatePreferences(JSON.parse(readFileSync(preferenceFile, 'utf8'))) : {};
  const records = existsSync(config.persistenceDir) ? readdirSync(config.persistenceDir).filter((n) => /^sch-[0-9a-f]{16}\.json$/.test(n))
    .map((name) => JSON.parse(readFileSync(resolve(config.persistenceDir, name), 'utf8'))) : [];
  const previewDir = resolve(config.persistenceDir, 'previews');
  const previews = existsSync(previewDir) ? readdirSync(previewDir).filter((n) => /^req-[0-9]+-[0-9a-f]{8}\.json$/.test(n))
    .map((name) => JSON.parse(readFileSync(resolve(previewDir, name), 'utf8'))) : [];
  if (records.some((r) => !r.validated || contentHash(r.slots) !== r.contentHash)) throw new Error('Legacy timetable integrity failed; migration stopped.');
  if (previews.some((r) => !isPreviewId(r.requestId) || !verifyPreviewRecord(r).ok)) throw new Error('Legacy preview integrity failed; migration stopped.');
  await db.collection('catalog').updateOne({ _id: 'catalog' }, { $setOnInsert: { value: catalog, revision: 1 } }, { upsert: true });
  for (const [id, value] of Object.entries(preferences)) await db.collection('preferences').updateOne({ _id: id }, { $setOnInsert: { value, revision: 1 } }, { upsert: true });
  for (const record of records) await db.collection('schedules').updateOne({ _id: record.scheduleId }, { $setOnInsert: record }, { upsert: true });
  for (const preview of previews) await db.collection('previews').updateOne({ _id: preview.requestId }, { $setOnInsert: preview }, { upsert: true });
  await db.collection('counters').updateOne({ _id: 'schedule-version' }, { $max: { value: Math.max(0, ...records.map((r) => r.version)) } }, { upsert: true });
  await db.collection('migrations').updateOne({ _id: 'legacy-state-v1' }, { $setOnInsert: {
    completedAt: new Date().toISOString(), preferences: Object.keys(preferences).length,
    schedules: records.length, previews: previews.length, catalogRevision: catalog.revision,
  } }, { upsert: true });
  return db;
}

// Only the catalog projection is synchronous for the pure solver. Every request
// obtains a fresh DB snapshot; there is no process-wide file/cache fallback.
export async function loadMongoStores(connection) {
  const db = connection.db;
  assertSeparateDatabase(db);
  const [sourceDoc, catalog, rows] = await Promise.all([db.collection('sources').findOne({ _id: 'legacy-catalog' }),
    db.collection('catalog').findOne({ _id: 'catalog' }), db.collection('preferences').find({}).toArray()]);
  if (!sourceDoc?.value || !catalog?.value) throw new Error('Timetable database is not initialized.');
  const source = { ...sourceDoc.value, scheduling: buildSchedulingModel(sourceDoc.value.normalized) };
  return { catalogStore: new MongoCatalogStore(db.collection('catalog'), catalog.value, source),
    preferenceStore: new MongoPreferenceStore(db.collection('preferences'), Object.fromEntries(rows.map((row) => [row._id, row.value]))),
    scheduleStore: new MongoScheduleStore(db), previewStore: new MongoPreviewStore(db) };
}
