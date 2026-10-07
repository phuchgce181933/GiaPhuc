'use strict';

const mongoose = require('mongoose');
const env = require('./index');

mongoose.set('strictQuery', true);
let timetableConnection;
let presentationConnection;
let presentationConnecting;
let progressConnection;
let progressConnecting;

async function connectProgressTestDB() {
  if (progressConnection?.readyState === 1) return progressConnection;
  if (!progressConnecting) {
    progressConnection = mongoose.createConnection(env.PROGRESS_TEST.MONGODB_URI, { dbName: env.PROGRESS_TEST.MONGODB_DB, serverSelectionTimeoutMS: 10000 });
    progressConnecting = progressConnection.asPromise().then(connection => connection).catch(async error => { await progressConnection.close().catch(() => {}); throw error; }).finally(() => { progressConnecting = null; });
  }
  return progressConnecting;
}

async function connectTimetableDB() {
  if (timetableConnection?.readyState === 1) return timetableConnection;
  timetableConnection = mongoose.createConnection(env.TIMETABLE.MONGODB_URI, {
    dbName: env.TIMETABLE.MONGODB_DB,
    serverSelectionTimeoutMS: 10_000,
  });
  await timetableConnection.asPromise();
  console.log(`[db] timetable connected to "${env.TIMETABLE.MONGODB_DB}"`);
  return timetableConnection;
}

async function connectDB() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  mongoose.connection.on('connected', () => {
    console.log(`[db] connected to "${env.MONGODB_DB}"`);
  });
  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] disconnected');
  });

  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DB,
    serverSelectionTimeoutMS: 10_000,
  });

  return mongoose.connection;
}

async function connectPresentationDB() {
  if (presentationConnection?.readyState === 1) return presentationConnection;
  if (!presentationConnecting) {
    presentationConnection = mongoose.createConnection(env.PRESENTATION.MONGODB_URI, { dbName: 'presentations', serverSelectionTimeoutMS: 10_000 });
    presentationConnecting = presentationConnection.asPromise().catch(async () => {
      await presentationConnection.close().catch(() => {});
      presentationConnection = null;
      throw new Error('Presentation database unavailable.');
    }).finally(() => { presentationConnecting = null; });
  }
  return presentationConnecting;
}

async function disconnectDB() {
  if (progressConnection) await progressConnection.close();
  if (timetableConnection) await timetableConnection.close();
  if (presentationConnection) await presentationConnection.close();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

module.exports = { connectDB, connectTimetableDB, connectProgressTestDB, connectPresentationDB, disconnectDB, mongoose };
