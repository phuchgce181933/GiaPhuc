// Tests for the diversity filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diversity, dedupe } from '../src/domain/diversity.js';

function sol(slots) {
  const assignments = new Map();
  assignments.set('a1', slots);
  return { id: 's', assignments };
}

test('identical solutions: diversity = 0', () => {
  const a = sol([{ branchId: 'b1', day: 1, period: 1 }, { branchId: 'b1', day: 2, period: 2 }]);
  const b = sol([{ branchId: 'b1', day: 1, period: 1 }, { branchId: 'b1', day: 2, period: 2 }]);
  assert.equal(diversity(a, b), 0);
});

test('completely disjoint: diversity = 1', () => {
  const a = sol([{ branchId: 'b1', day: 1, period: 1 }]);
  const b = sol([{ branchId: 'b1', day: 2, period: 2 }]);
  assert.equal(diversity(a, b), 1);
});

test('half-overlap: diversity = 2/3', () => {
  const a = sol([{ branchId: 'b1', day: 1, period: 1 }, { branchId: 'b1', day: 2, period: 2 }]);
  const b = sol([{ branchId: 'b1', day: 1, period: 1 }, { branchId: 'b1', day: 3, period: 3 }]);
  // inter=1, symDiff=2, union=3 → 2/3
  const d = diversity(a, b);
  assert.equal(Math.round(d * 100) / 100, 0.67);
});

test('dedupe keeps only diverse candidates', () => {
  const a = sol([{ branchId: 'b1', day: 1, period: 1 }]);
  const b = sol([{ branchId: 'b1', day: 1, period: 1 }]); // same as a
  const c = sol([{ branchId: 'b1', day: 2, period: 2 }]); // different
  const out = dedupe([a, b, c], 0.15);
  assert.equal(out.length, 2);
});
