'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { historyFilename, parsePeriod, previousCompleteIsoWeek } = require('../scripts/org-history.js');

const script = path.join(__dirname, '..', 'scripts', 'org-history.js');

test('parses calendar months and ISO weeks as UTC half-open intervals', () => {
  for (const [period, start, end] of [
    ['2026-09', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ['2026-W38', '2026-09-14T00:00:00.000Z', '2026-09-21T00:00:00.000Z'],
    ['2026-W01', '2025-12-29T00:00:00.000Z', '2026-01-05T00:00:00.000Z'],
    ['2020-W53', '2020-12-28T00:00:00.000Z', '2021-01-04T00:00:00.000Z'],
  ]) assert.deepEqual(parsePeriod(period), { period, start, end });
});

test('rejects invalid periods, including week 53 in a 52-week ISO year', () => {
  for (const period of ['2026-13', '2026-W00', '2026-W54', '2021-W53']) {
    assert.throws(() => parsePeriod(period));
  }
});

test('selects the prior complete ISO week across year boundaries', () => {
  for (const [now, period] of [
    ['2026-01-04T12:00:00Z', '2025-W52'],
    ['2026-01-01T12:00:00Z', '2025-W52'],
    ['2026-01-05T00:00:00Z', '2026-W01'],
    ['2026-01-06T12:00:00Z', '2026-W01'],
    ['2026-01-07T12:00:00Z', '2026-W01'],
    ['2026-01-08T12:00:00Z', '2026-W01'],
    ['2026-01-09T12:00:00Z', '2026-W01'],
    ['2026-01-10T12:00:00Z', '2026-W01'],
    ['2026-01-11T23:59:59Z', '2026-W01'],
  ]) assert.equal(previousCompleteIsoWeek(new Date(now)).period, period);
});

test('converts only valid ISO weeks to canonical history filenames', () => {
  for (const [period, filename] of [['2026-W01', '2026-01.json'], ['2020-W53', '2020-53.json']]) {
    assert.equal(historyFilename(period), filename);
  }
  for (const period of ['2026-01', '2021-W53']) assert.throws(() => historyFilename(period));
});

test('rejects invalid as-of dates', () => {
  assert.throws(() => previousCompleteIsoWeek(new Date('not-a-date')));
});

test('supports deterministic as-of week selection from the CLI', () => {
  assert.equal(childProcess.execFileSync(process.execPath, [script, '--previous-iso-week', '--as-of', '2026-01-01T12:00:00Z'], { encoding: 'utf8' }).trim(), '2025-W52');
  assert.throws(() => childProcess.execFileSync(process.execPath, [script, '--previous-iso-week', '--as-of', 'not-a-date'], { encoding: 'utf8' }));
});
