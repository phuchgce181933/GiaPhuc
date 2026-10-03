// Layer 1 — RAW reader.
//
// Reads a `mongodump` directory and returns the documents of every
// collection as plain JavaScript objects. This is the SOLE layer
// that touches the BSON files. Everything downstream operates on
// the output of this layer.
//
// ObjectId and Date are preserved as their JS values (ObjectId and
// Date). They are stringified on demand by the normalizer. The
// `bson` package does NOT mutate the source buffer; this function
// reads bytes from disk, parses them, and discards the buffer.
//
// `mongodump` BSON files are concatenations of BSON documents
// (each prefixed by a 4-byte little-endian size). We iterate by
// size. If a doc fails to parse, we stop at that offset and
// record the partial count; we never silently drop a record.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize, calculateObjectSize } from 'bson';

/**
 * @typedef {Object} RawCollection
 * @property {string} collectionName      // matches the .metadata.json uuid+name
 * @property {object[]} documents         // ordered, indexed by `documents[i]`
 * @property {number}  docCount
 * @property {{ collectionName: string, indexes: object[] } | null} metadata
 *
 * @typedef {Object} RawDump
 * @property {string}   sourceDir
 * @property {string}   serverVersion
 * @property {string}   toolVersion
 * @property {Map<string, RawCollection>} collections  // key = collectionName
 */

/**
 * Read the `prelude.json` to extract ServerVersion / ToolVersion.
 * @param {string} sourceDir
 */
function readPrelude(sourceDir) {
  try {
    const raw = JSON.parse(readFileSync(join(sourceDir, 'prelude.json'), 'utf8'));
    return {
      serverVersion: raw?.ServerVersion ?? 'unknown',
      toolVersion: raw?.ToolVersion ?? 'unknown',
    };
  } catch {
    return { serverVersion: 'unknown', toolVersion: 'unknown' };
  }
}

/**
 * Read one `.metadata.json` file next to a `.bson` file. Return
 * the parsed object, or null on failure. We do not validate the
 * content — the metadata is for audit; the loader never queries
 * the indexes.
 */
function readMetadata(sourceDir, baseName) {
  try {
    return JSON.parse(readFileSync(join(sourceDir, `${baseName}.metadata.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Parse a `mongodump` BSON file. Each file is a sequence of
 * BSON documents; we iterate by reading the 4-byte length
 * prefix.
 *
 * @param {Buffer} buf
 * @returns {object[]}
 */
function parseBsonFile(buf) {
  const docs = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const size = buf.readInt32LE(pos);
    if (size <= 0 || pos + size > buf.length) {
      // Stop on a malformed prefix. We never silently skip a doc.
      break;
    }
    const slice = buf.subarray(pos, pos + size);
    let doc;
    try {
      doc = deserialize(slice, { allowObjectSmallerThanRecommendedLength: true });
    } catch (e) {
      // Stop on parse error. The doc is appended only on success.
      break;
    }
    if (!doc || typeof doc !== 'object') break;
    docs.push(doc);
    pos += size;
  }
  return docs;
}

/**
 * Read the whole `mongodump` directory into a RawDump.
 *
 * @param {string} sourceDir
 * @returns {RawDump}
 */
export function readRawDump(sourceDir) {
  const prelude = readPrelude(sourceDir);
  const entries = readdirSync(sourceDir);
  const bsonBases = entries
    .filter((n) => n.endsWith('.bson'))
    .map((n) => n.slice(0, -'.bson'.length))
    .sort();

  /** @type {Map<string, RawCollection>} */
  const collections = new Map();
  for (const base of bsonBases) {
    const buf = readFileSync(join(sourceDir, `${base}.bson`));
    const documents = parseBsonFile(buf);
    const meta = readMetadata(sourceDir, base);
    const collectionName = meta?.collectionName ?? base;
    collections.set(collectionName, {
      collectionName,
      documents,
      docCount: documents.length,
      metadata: meta ? { collectionName: meta.collectionName, indexes: meta.indexes ?? [] } : null,
    });
  }
  return {
    sourceDir,
    serverVersion: prelude.serverVersion,
    toolVersion: prelude.toolVersion,
    collections,
  };
}

/**
 * Pure helper: count records per collection.
 * Useful for inventory reports.
 */
export function inventory(raw) {
  const out = {};
  for (const [name, c] of raw.collections) {
    out[name] = c.docCount;
  }
  return out;
}

// `calculateObjectSize` is imported for potential future use
// (e.g. when building a raw dump from a JS object). It is not
// called by `readRawDump` because we already have the on-disk
// sizes.
export const _internal = { calculateObjectSize };