// PHASE 22.1 — Independent raw duplicate check.
// Read-only. Does NOT modify any data. Counts class and teacher
// duplicates in the raw 802 scheduleslots, using TWO identity
// definitions:
//   (A) (class, day, session, period) — what Phase 19/20 uses.
//   (B) (class, day, period)          — what Phase 22 currently uses.
// The result will show that the discrepancy is in the IDENTITY
// definition, not in the data.

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';

const full = loadFromLegacySaplich();
const slots = full.legacyBaseline.scheduleSlots;

console.log('Total raw slots:', slots.length);

// (A) Phase 19/20 identity: (class, day, session, period)
const aClassKeys = new Map();
let aClassDup = 0;
const aTeacherKeys = new Map();
let aTeacherDup = 0;
for (const s of slots) {
  const ck = `${s.class}|${s.day}|${s.session}|${s.period}`;
  if (aClassKeys.has(ck)) aClassDup++;
  else aClassKeys.set(ck, s.id);
  const tk = `${s.teacher}|${s.day}|${s.session}|${s.period}`;
  if (aTeacherKeys.has(tk)) aTeacherDup++;
  else aTeacherKeys.set(tk, s.id);
}

// (B) Phase 22 (current) identity: (class, day, period) — drops session
const bClassKeys = new Map();
let bClassDup = 0;
const bTeacherKeys = new Map();
let bTeacherDup = 0;
const bClassDupExamples = [];
const bTeacherDupExamples = [];
for (const s of slots) {
  const ck = `${s.class}|${s.day}|${s.period}`;
  if (bClassKeys.has(ck)) {
    bClassDup++;
    if (bClassDupExamples.length < 3) {
      bClassDupExamples.push({
        prev: bClassKeys.get(ck),
        curr: s.id,
        class: s.class,
        day: s.day,
        period: s.period,
        prevSession: slots.find(x => x.id === bClassKeys.get(ck))?.session,
        currSession: s.session,
      });
    }
  } else bClassKeys.set(ck, s.id);
  const tk = `${s.teacher}|${s.day}|${s.period}`;
  if (bTeacherKeys.has(tk)) {
    bTeacherDup++;
    if (bTeacherDupExamples.length < 3) {
      bTeacherDupExamples.push({
        prev: bTeacherKeys.get(tk),
        curr: s.id,
        teacher: s.teacher,
        day: s.day,
        period: s.period,
        prevSession: slots.find(x => x.id === bTeacherKeys.get(tk))?.session,
        currSession: s.session,
      });
    }
  } else bTeacherKeys.set(tk, s.id);
}

console.log('=== Identity (A): (entity, day, session, period) ===');
console.log('  rawClassDuplicates    :', aClassDup);
console.log('  rawTeacherDuplicates  :', aTeacherDup);

console.log('=== Identity (B): (entity, day, period) [drops session] ===');
console.log('  rawClassDuplicates    :', bClassDup);
console.log('  rawTeacherDuplicates  :', bTeacherDup);

console.log('\n=== Sample (B) class duplicates (cross-session) ===');
for (const ex of bClassDupExamples) {
  console.log(`  class=${ex.class} day=${ex.day} period=${ex.period} sessions=${ex.prevSession},${ex.currSession} prevSlot=${ex.prev} currSlot=${ex.curr}`);
}

console.log('\n=== Sample (B) teacher duplicates (cross-session) ===');
for (const ex of bTeacherDupExamples) {
  console.log(`  teacher=${ex.teacher} day=${ex.day} period=${ex.period} sessions=${ex.prevSession},${ex.currSession} prevSlot=${ex.prev} currSlot=${ex.curr}`);
}

// Cross-check: every (B) duplicate must have a different session
// between the two slots. This proves the duplicate is cross-session,
// not a real conflict.
let allCrossSession = true;
for (const s of slots) {
  const ck = `${s.class}|${s.day}|${s.period}`;
  if (bClassKeys.has(ck) && bClassKeys.get(ck) !== s.id) {
    const prev = slots.find(x => x.id === bClassKeys.get(ck));
    if (prev && prev.session === s.session) {
      allCrossSession = false;
      console.log('!! same-session class duplicate found:', prev.id, s.id);
    }
  }
}
console.log('\nAll (B) class duplicates are cross-session:', allCrossSession);

let allTeacherCrossSession = true;
for (const s of slots) {
  const tk = `${s.teacher}|${s.day}|${s.period}`;
  if (bTeacherKeys.has(tk) && bTeacherKeys.get(tk) !== s.id) {
    const prev = slots.find(x => x.id === bTeacherKeys.get(tk));
    if (prev && prev.session === s.session) {
      allTeacherCrossSession = false;
      console.log('!! same-session teacher duplicate found:', prev.id, s.id);
    }
  }
}
console.log('All (B) teacher duplicates are cross-session:', allTeacherCrossSession);
