'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { aicLinkedItems, applyCommentAicFallback, artifactAicProperties, deduplicateCommentAic, historyFilename, normalizedPullRequests, parseCommentAic, parsePeriod, previousCompleteIsoWeek, summarizeAicCoverage, validateDetailedItems, workflowRunRecord } = require('../scripts/org-history.js');

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
  const run = (id, aic, pullRequests = [], components = {}) => ({ id, repository: 'repo', kind: 'drafter', aic, pull_requests: pullRequests, ...components });
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
    { name: 'sums complete component breakdowns including zero', runs: [run(10, 1.25, [], { aicAgent: 1.25, aicDetection: 0 }), run(14, 2.5, [], { aicAgent: 2, aicDetection: 0.5 })], comments: [comment(10, 1), comment(14, 1)], expected: [{ repository: 'repo', number: 1, type: 'issue', aic: 3.75, aicRunIds: [10, 14], agentAic: 3.25, detectionAic: 0.5 }] },
    { name: 'omits partial component breakdowns', runs: [run(10, 1, [], { aicAgent: 1, aicDetection: 0 }), run(14, 2)], comments: [comment(10, 1), comment(14, 1)], expected: [{ repository: 'repo', number: 1, type: 'issue', aic: 3, aicRunIds: [10, 14] }] },
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

test('serializes sparse workflow-run AIC properties without losing zero values', () => {
  const record = workflowRunRecord({
    id: 1, path: 'drafter.lock.yml', aic: 0, aicRecords: 0, aicAgent: 0,
    aicDetection: 0, aicCommentId: 0, aicSource: null, aicCommentUrl: undefined,
  }, 'org', 'repo');
  assert.deepEqual(record, {
    repository: 'repo', id: 1, path: 'drafter.lock.yml', kind: 'drafter', pullRequests: [],
    aic: 0, aicRecords: 0, aicAgent: 0, aicDetection: 0, aicCommentId: 0,
  });
  for (const property of ['aicSource', 'aicCommentUrl', 'aicCommentActor']) assert.equal(property in record, false);
});

test('propagates normalized artifact AIC components when the extraction is complete', () => {
  for (const [name, usage, expected] of [
    ['known values', { known: true, aic: 1.2345678, records: 2, source: 'aggregate+detection', agent: { known: true, aic: 1.2 }, detection: { known: true, aic: 0.0345678 } }, { aic: 1.234568, aicArtifactKnown: true, aicSource: 'aggregate+detection', aicRecords: 2, aicAgent: 1.2, aicDetection: 0.034568 }],
    ['zero values', { known: true, aic: 0, records: 0, source: 'aggregate_empty+detection_empty', agent: { known: true, aic: 0 }, detection: { known: true, aic: 0 } }, { aic: 0, aicArtifactKnown: true, aicSource: 'aggregate_empty+detection_empty', aicRecords: 0, aicAgent: 0, aicDetection: 0 }],
    ['incomplete extraction', { known: false, aic: null, records: 0, source: 'agent_missing+detection_empty', agent: { known: false, aic: null }, detection: { known: true, aic: 0 } }, { aic: null, aicArtifactKnown: false, aicSource: 'agent_missing+detection_empty', aicRecords: 0, aicDetection: 0 }],
  ]) assert.deepEqual(artifactAicProperties(usage), expected, name);
});

test('merges comment AIC fallback with partial artifact components', () => {
  const footer = (agentAic, detectionAic, aic = detectionAic === null ? agentAic : agentAic + detectionAic) => ({ runId: 1, agentAic, detectionAic, aic, actor: 'bot', createdAt: 'created', updatedAt: 'updated', footerRunUrl: 'run', commentUrl: 'comment', commentId: 1, bodySha256: 'body' });
  for (const [name, artifact, record, expected] of [
    ['no artifact with split footer', {}, footer(1.2, 0.0345678), { aic: 1.234568, aicAgent: 1.2, aicDetection: 0.034568, aicSource: 'comment_footer' }],
    ['partial detection with split footer', { aicDetection: 2 }, footer(1.2, 9, 10.2), { aic: 3.2, aicAgent: 1.2, aicDetection: 2, aicSource: 'partial_artifact+comment_footer' }],
    ['partial agent with split footer', { aicAgent: 3 }, footer(1, 4), { aic: 7, aicAgent: 3, aicDetection: 4, aicSource: 'partial_artifact+comment_footer' }],
    ['partial detection with total-only footer', { aicDetection: 2 }, footer(9, null), { aic: 9, aicAgent: undefined, aicDetection: 2, aicSource: 'partial_artifact+comment_footer' }],
    ['no artifact with total-only footer', {}, footer(9, null), { aic: 9, aicAgent: undefined, aicDetection: undefined, aicSource: 'comment_footer' }],
    ['zero component footer', {}, footer(0, 0), { aic: 0, aicAgent: 0, aicDetection: 0, aicSource: 'comment_footer' }],
  ]) {
    const run = { id: 1, ...artifact };
    assert.equal(applyCommentAicFallback([run], [record]), 1, name);
    assert.deepEqual({ aic: run.aic, aicAgent: run.aicAgent, aicDetection: run.aicDetection, aicSource: run.aicSource, aicRecords: run.aicRecords }, { ...expected, aicRecords: 1 }, name);
    assert.equal(run.aicCommentUrl, 'comment', name);
  }
});

test('counts pure and hybrid comment-footer AIC coverage', () => {
  assert.deepEqual(summarizeAicCoverage([
    { aic: 1, aicSource: 'comment_footer' },
    { aic: 2, aicSource: 'partial_artifact+comment_footer' },
    { aic: 3, aicSource: 'aggregate+detection', aicArtifactKnown: true },
    { aic: null, aicSource: 'artifacts_missing' },
  ]), {
    relevantRuns: 4, eligibleRuns: 4, ineligibleRuns: 0, runsWithValues: 3,
    artifactBackedRuns: 1, commentBackedRuns: 2, missingOrExpired: 1, total: null,
  });
});

test('validates compact detailed item records and exact serialized evidence', () => {
  const issue = { repository: 'repo', number: 1, type: 'issue', aic: 0, aicRunIds: [1] };
  const pullRequest = { repository: 'repo', number: 2, type: 'pull_request', aic: 1, aicRunIds: [2] };
  const issueUrl = 'https://github.com/org/repo/issues/1';
  const pullRequestUrl = 'https://github.com/org/repo/pull/2';
  const commentAic = [{ repository: 'repo', runId: 1, itemNumber: 1, itemUrl: issueUrl }];
  const workflowRuns = [{ id: 1, repository: 'repo', aic: 0, pullRequests: [] }, { id: 2, repository: 'repo', aic: 1, pullRequests: [{ number: 2, url: pullRequestUrl }] }];
  assert.doesNotThrow(() => validateDetailedItems([issue, pullRequest], workflowRuns, commentAic, 'org'));
  const componentIssue = { ...issue, agentAic: 0, detectionAic: 0 };
  const componentRuns = [{ id: 1, repository: 'repo', aic: 0, aicAgent: 0, aicDetection: 0, pullRequests: [] }];
  assert.doesNotThrow(() => validateDetailedItems([componentIssue], componentRuns, commentAic, 'org'));
  for (const [name, items, runs, comments] of [
    ['missing evidence', [issue], [{ id: 1, repository: 'repo', aic: 0, pullRequests: [] }], []],
    ['wrong PR evidence', [pullRequest], [{ id: 2, repository: 'repo', aic: 1, pullRequests: [{ number: 2, url: issueUrl }] }], []],
    ['wrong type', [{ ...issue, type: 'pull_request' }], workflowRuns, commentAic],
    ['cross-repository comment URL', [issue], workflowRuns, [{ ...commentAic[0], itemUrl: 'https://github.com/other/repo/issues/1' }]],
    ['duplicate run ID', [{ ...issue, aicRunIds: [1, 1] }], workflowRuns, commentAic],
    ['missing AIC', [{ ...issue, aicRunIds: [2] }], [{ id: 2, repository: 'repo', pullRequests: [] }], commentAic],
    ['cross-repository run', [{ ...issue, aicRunIds: [3] }], [{ id: 3, repository: 'other', aic: 1, pullRequests: [] }], commentAic],
    ['wrong total', [{ ...pullRequest, aic: 2 }], workflowRuns, commentAic],
    ['missing known components', [issue], componentRuns, commentAic],
    ['incorrect agent component', [{ ...componentIssue, agentAic: 1 }], componentRuns, commentAic],
    ['one component field', [{ ...issue, agentAic: 0 }], componentRuns, commentAic],
    ['components for partial breakdown', [{ ...componentIssue }], workflowRuns, commentAic],
    ['duplicate item identity', [issue, { ...issue, type: 'pull_request' }], workflowRuns, commentAic],
    ['unexpected metadata', [{ ...issue, updatedAt: '2026-09-01T00:00:00Z' }], workflowRuns, commentAic],
    ['non-finite AIC', [{ ...issue, aic: Number.NaN }], workflowRuns, commentAic],
    ['malformed identity', [{ ...issue, repository: 'bad/repo' }], workflowRuns, commentAic],
  ]) assert.throws(() => validateDetailedItems(items, runs, comments, 'org'), name);
});
