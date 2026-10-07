'use strict';
const { connectTimetableDB } = require('../../config/db');
const { runGenerate } = require('./timetable.worker');
let initialization;
let runtime;

async function initializeTimetable() {
  if (!initialization) initialization = (async () => {
    const connection = await connectTimetableDB();
    const persistence = await import('./engine/persistence/mongo-store.js');
    await persistence.initializeMongoTimetable(connection);
    return { connection, persistence };
  })().catch((error) => { initialization = null; throw error; });
  return initialization;
}

async function createRequestRouter() {
  if (runtime?.router) return runtime.router;
  const { connection, persistence } = await initializeTimetable();
  const [catalog, scheduling, loader] = await Promise.all([
    import('./engine/catalog/catalog.route.js'), import('./engine/api/routes.js'),
    import('./engine/loader/catalog-dataset.js'),
  ]);
  const stores = await persistence.loadMongoStores(connection);
  const dependencies = { ...stores, runGenerate,
    loadDataset: async () => loader.loadBenchmarkDataset(stores) };
  const express = require('express');
  const router = express.Router();
  router.use('/schedules', scheduling.createSchedulesRouter(dependencies));
  router.use('/', catalog.createCatalogRouter(dependencies));
  runtime = { router, dependencies, stores, connection };
  return router;
}
async function getRuntime() { await createRequestRouter(); return runtime; }
module.exports = { initializeTimetable, createRequestRouter, getRuntime };
