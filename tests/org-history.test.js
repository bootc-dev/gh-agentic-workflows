'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { aicLinkedItems, deduplicateCommentAic, historyFilename, normalizedPullRequests, parseCommentAic, parsePeriod, previousCompleteIsoWeek, validateDetailedItems } = require('../scripts/org-history.js');

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

test('projects compact AIC-linked items from exact known-AIC evidence', () => {
  const items = [
    { repository: 'repo', number: 1, type: 'issue', url: 'https://github.com/org/repo/issues/1', updatedAt: 'metadata' },
    { repository: 'repo', number: 2, type: 'pull_request', url: 'https://github.com/org/repo/pull/2', title: 'metadata' },
    { repository: 'repo', number: 3, type: 'issue', url: 'https://github.com/org/repo/issues/3' },
  ];
  const run = (id, aic, pullRequests = []) => ({ id, repository: 'repo', kind: 'drafter', aic, pull_requests: pullRequests });
  const pull = (number, repository = 'repo') => ({ url: `https://api.github.com/repos/org/${repository}/pulls/${number}` });
  const comment = (runId, itemNumber) => ({ repository: 'repo', runId, itemNumber, itemUrl: items.find((item) => item.number === itemNumber).url });
  for (const scenario of [
    { name: 'comment', runs: [run(10, 1)], comments: [comment(10, 1)], expected: [{ repository: 'repo', number: 1, type: 'issue', aic: 1, aicRunIds: [10] }] },
    { name: 'pull request', runs: [run(11, 2, [pull(2)])], comments: [], expected: [{ repository: 'repo', number: 2, type: 'pull_request', aic: 2, aicRunIds: [11] }] },
    { name: 'unrelated or cross-repository evidence', runs: [run(12, 3, [pull(3, 'other')]), run(13, null, [pull(2)])], comments: [{ ...comment(12, 1), itemNumber: 99 }], expected: [] },
    { name: 'sums multiple runs', runs: [run(10, 1.25), run(14, 2.5)], comments: [comment(10, 1), comment(14, 1)], expected: [{ repository: 'repo', number: 1, type: 'issue', aic: 3.75, aicRunIds: [10, 14] }] },
    { name: 'deduplicates evidence', runs: [run(14, 4, [pull(2), pull(2)])], comments: [comment(14, 2), comment(14, 2)], expected: [{ repository: 'repo', number: 2, type: 'pull_request', aic: 4, aicRunIds: [14] }] },
    { name: 'attributes one run fully to multiple items', runs: [run(16, 5)], comments: [comment(16, 1), comment(16, 3)], expected: [{ repository: 'repo', number: 1, type: 'issue', aic: 5, aicRunIds: [16] }, { repository: 'repo', number: 3, type: 'issue', aic: 5, aicRunIds: [16] }] },
    { name: 'retains zero AIC', runs: [run(15, 0)], comments: [comment(15, 1)], expected: [{ repository: 'repo', number: 1, type: 'issue', aic: 0, aicRunIds: [15] }] },
  ]) assert.deepEqual(aicLinkedItems(items, scenario.runs, scenario.comments, 'org'), scenario.expected, scenario.name);
});

test('parses comment AIC with transparent same-repository item identity', () => {
  const comment = parseCommentAic({ id: 1, issue_url: 'https://api.github.com/repos/org/repo/issues/7', html_url: 'https://github.com/org/repo/pull/7#issuecomment-9', body: '> Generated by [workflow](https://github.com/org/repo/actions/runs/42) · 0 AIC' }, 'org', 'repo');
  assert.deepEqual({ runId: comment.runId, itemNumber: comment.itemNumber, itemUrl: comment.itemUrl, aic: comment.aic }, { runId: 42, itemNumber: 7, itemUrl: 'https://github.com/org/repo/pull/7', aic: 0 });
  assert.equal(parseCommentAic({ id: 1, issue_url: 'https://api.github.com/repos/other/repo/issues/7', html_url: 'https://github.com/other/repo/issues/7#issuecomment-9', body: '> Generated by [workflow](https://github.com/org/repo/actions/runs/42) · 1 AIC' }, 'org', 'repo'), null);
  assert.equal(parseCommentAic({ id: 1, issue_url: 'https://api.github.com/repos/org/repo/issues/7', html_url: 'https://github.com/org/repo/issues/7#issuecomment-9', body: '> Generated by [workflow](https://github.com/other/repo/actions/runs/42) · 1 AIC' }, 'org', 'repo'), null);
  assert.equal(parseCommentAic({ id: 1, issue_url: 'https://api.github.com/repos/org/repo/issues/7', html_url: 'https://github.com/org/repo/issues/7#issuecomment-9', body: '> Generated by [workflow](https://github.com/org/repo/actions/runs/42) · 1 AIC\n<!-- gh-aw-agentic-workflow: id: 42, workflow_id: 1, run: https://github.com/other/repo/actions/runs/42 -->' }, 'org', 'repo'), null);
});

test('retains consistent comment evidence for every exact item target', () => {
  const records = deduplicateCommentAic([{ runId: 20, commentId: 1, commentUrl: 'one', agentAic: 1, detectionAic: null, aic: 1, repository: 'repo', itemNumber: 1 }, { runId: 20, commentId: 2, commentUrl: 'two', agentAic: 1, detectionAic: null, aic: 1, repository: 'repo', itemNumber: 2 }]).records;
  const items = [{ repository: 'repo', number: 1, type: 'issue', url: 'https://github.com/org/repo/issues/1' }, { repository: 'repo', number: 2, type: 'issue', url: 'https://github.com/org/repo/issues/2' }];
  for (const record of records) record.itemUrl = `https://github.com/org/repo/issues/${record.itemNumber}`;
  assert.deepEqual(aicLinkedItems(items, [{ id: 20, repository: 'repo', kind: 'drafter', aic: 1 }], records, 'org'), [{ repository: 'repo', number: 1, type: 'issue', aic: 1, aicRunIds: [20] }, { repository: 'repo', number: 2, type: 'issue', aic: 1, aicRunIds: [20] }]);
});

test('normalizes only same-repository workflow PR references', () => {
  assert.deepEqual(normalizedPullRequests({ pull_requests: [{ url: 'https://api.github.com/repos/org/repo/pulls/2' }, { url: 'https://api.github.com/repos/org/repo/pulls/1' }, { url: 'https://api.github.com/repos/org/repo/pulls/2' }, { url: 'https://api.github.com/repos/org/other/pulls/3' }] }, 'org', 'repo'), [{ number: 1, url: 'https://github.com/org/repo/pull/1' }, { number: 2, url: 'https://github.com/org/repo/pull/2' }]);
});

test('validates compact detailed item records and exact serialized evidence', () => {
  const issue = { repository: 'repo', number: 1, type: 'issue', aic: 0, aicRunIds: [1] };
  const pullRequest = { repository: 'repo', number: 2, type: 'pull_request', aic: 1, aicRunIds: [2] };
  const issueUrl = 'https://github.com/org/repo/issues/1';
  const pullRequestUrl = 'https://github.com/org/repo/pull/2';
  const commentAic = [{ repository: 'repo', runId: 1, itemNumber: 1, itemUrl: issueUrl }];
  const workflowRuns = [{ id: 1, repository: 'repo', aic: 0, pullRequests: [] }, { id: 2, repository: 'repo', aic: 1, pullRequests: [{ number: 2, url: pullRequestUrl }] }];
  assert.doesNotThrow(() => validateDetailedItems([issue, pullRequest], workflowRuns, commentAic, 'org'));
  for (const [name, items, runs, comments] of [
    ['missing evidence', [issue], [{ id: 1, repository: 'repo', aic: 0, pullRequests: [] }], []],
    ['wrong PR evidence', [pullRequest], [{ id: 2, repository: 'repo', aic: 1, pullRequests: [{ number: 2, url: issueUrl }] }], []],
    ['wrong type', [{ ...issue, type: 'pull_request' }], workflowRuns, commentAic],
    ['cross-repository comment URL', [issue], workflowRuns, [{ ...commentAic[0], itemUrl: 'https://github.com/other/repo/issues/1' }]],
    ['duplicate run ID', [{ ...issue, aicRunIds: [1, 1] }], workflowRuns, commentAic],
    ['unknown AIC', [{ ...issue, aicRunIds: [2] }], [{ id: 2, repository: 'repo', aic: null, pullRequests: [] }], commentAic],
    ['cross-repository run', [{ ...issue, aicRunIds: [3] }], [{ id: 3, repository: 'other', aic: 1, pullRequests: [] }], commentAic],
    ['wrong total', [{ ...pullRequest, aic: 2 }], workflowRuns, commentAic],
    ['duplicate item identity', [issue, { ...issue, type: 'pull_request' }], workflowRuns, commentAic],
    ['unexpected metadata', [{ ...issue, updatedAt: '2026-09-01T00:00:00Z' }], workflowRuns, commentAic],
    ['non-finite AIC', [{ ...issue, aic: Number.NaN }], workflowRuns, commentAic],
    ['malformed identity', [{ ...issue, repository: 'bad/repo' }], workflowRuns, commentAic],
  ]) assert.throws(() => validateDetailedItems(items, runs, comments, 'org'), name);
});
