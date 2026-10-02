'use strict';

const mongoose = require('mongoose');
const env = require('./index');

mongoose.set('strictQuery', true);

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

async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

module.exports = { connectDB, disconnectDB, mongoose };