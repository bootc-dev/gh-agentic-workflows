#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../scripts/monthly-org-history.js');

const cases = [
  ['leap month', '2024-02', '2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
  ['year boundary', '2024-12', '2024-12-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'],
];
for (const [name, month, start, end] of cases) assert.deepEqual(history.parseMonth(month), { month, start, end }, name);
assert.throws(() => history.parseMonth('2024-13'), /YYYY-MM/);
assert.throws(() => history.parseMonth('0099-01'), /at least 1000/);
for (const [name, timestamp, expected] of [
  ['start without milliseconds', '2024-02-01T00:00:00Z', true],
  ['start with milliseconds', '2024-02-01T00:00:00.000Z', true],
  ['end without milliseconds', '2024-03-01T00:00:00Z', false],
  ['end with milliseconds', '2024-03-01T00:00:00.000Z', false],
  ['malformed', 'not-a-date', false],
]) assert.equal(history.inInterval(timestamp, history.parseMonth('2024-02')), expected, name);
assert.equal(history.issueSince(history.parseMonth('2024-02')), '2024-01-31T23:59:59.999Z');

const interval = history.parseMonth('2024-02');
const items = history.classifyItems([
  { number: 2, title: 'PR', created_at: '2024-02-29T23:00:00Z', updated_at: '2024-03-01T00:00:00Z', merged_at: '2024-03-01T00:00:00.000Z', pull_request: {}, head: { ref: 'agent/task' }, labels: [{ name: 'agent/lgtm' }], body: 'Assisted-by: AI\nGenerated-by: AI' },
  { number: 1, title: 'issue', created_at: '2024-01-31T23:00:00Z', updated_at: '2024-02-01T00:00:00Z', labels: [{ name: 'agent/code' }], body: 'assisted-by: AI\nnot a marker' },
], 'repo', interval);
assert.deepEqual(items.map((item) => [item.number, item.createdInMonth, item.mergedInMonth, item.agentBranch]), [[1, false, false, false], [2, true, false, true]]);
assert.deepEqual(history.aggregateRepository(items, [{ name: 'Drafter', conclusion: 'success' }, { name: 'PR Review Agent', conclusion: 'failure' }]), { issuesCreated: 0, prsCreated: 1, prsMerged: 0, agentLabelSignals: { 'agent/code': 1, 'agent/lgtm': 1 }, agentBranchPrs: 1, attribution: { cohort: 'items_created_in_month', items: 1, assistedByAi: 1, generatedByAi: 1 }, workflows: { drafter: { success: 1 }, review: { failure: 1 } } });
for (const [run, expected] of [
  [{ name: 'Drafter' }, 'drafter'], [{ name: 'PR Review Agent' }, 'review'],
  [{ name: 'PR Fix Agent' }, 'fix'], [{ path: '.github/workflows/queue-triage.yml' }, 'queue-triage'],
  [{ name: 'fixture runner' }, null], [{ name: 'unrelated' }, null],
]) assert.equal(history.classifyWorkflow(run), expected);

const aggregate = fs.readFileSync(path.join(__dirname, 'fixtures/gh-aw-agent_usage.json'), 'utf8');
for (const [name, files, expected] of [
  ['real aggregate plus empty detection', [{ name: 'agent_usage.json', text: aggregate }, { name: 'agent/token_usage.jsonl', text: '{"ai_credits_total":999}' }, { name: 'detection/token_usage.jsonl', text: '' }], { known: true, aic: 66.989505, records: 1, source: 'aggregate+detection_empty', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: true, aic: 0, records: 0, source: 'detection_empty' } }],
  ['aggregate plus detection total', [{ name: 'agent_usage.json', text: aggregate }, { name: 'detection/token_usage.jsonl', text: '{"ai_credits_total":2}\n{"ai_credits_total":3}' }], { known: true, aic: 69.989505, records: 3, source: 'aggregate+detection_token_total', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: true, aic: 3, records: 2, source: 'detection_token_total' } }],
  ['duplicate archive files', [{ name: 'agent_usage.json', text: aggregate }, { name: 'agent_usage.json', text: aggregate }, { name: 'detection/token_usage.jsonl', text: '' }], { known: true, aic: 66.989505, records: 1, source: 'aggregate+detection_empty', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: true, aic: 0, records: 0, source: 'detection_empty' } }],
  ['token fallback uses cumulative maximum', [{ name: 'agent/token_usage.jsonl', text: '{"ai_credits_total":2}\n{"ai_credits_total":5}' }, { name: 'detection/token_usage.jsonl', text: '' }], { known: true, aic: 5, records: 2, source: 'agent_token_total+detection_empty', agent: { known: true, aic: 5, records: 2, source: 'agent_token_total' }, detection: { known: true, aic: 0, records: 0, source: 'detection_empty' } }],
  ['malformed aggregate is unknown', [{ name: 'agent_usage.json', text: '{"ai_credits":"bad"}' }, { name: 'agent/token_usage.jsonl', text: '{"ai_credits_total":5}' }, { name: 'detection/token_usage.jsonl', text: '' }], { known: false, aic: null, records: 0, source: 'malformed_aggregate' }],
  ['missing detection is unknown', [{ name: 'agent_usage.json', text: aggregate }], { known: false, aic: null, records: 0, source: 'aggregate+detection_missing', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: false, aic: null, records: 0, source: 'detection_missing' } }],
  ['malformed detection is unknown', [{ name: 'agent_usage.json', text: aggregate }, { name: 'detection/token_usage.jsonl', text: '{"ai_credits_this_response":3}' }], { known: false, aic: null, records: 0, source: 'aggregate+detection_malformed', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: false, aic: null, records: 0, source: 'detection_malformed' } }],
  ['arbitrary detection file is ignored', [{ name: 'agent_usage.json', text: aggregate }, { name: 'detection_usage.jsonl', text: '{"ai_credits_total":4}' }], { known: false, aic: null, records: 0, source: 'aggregate+detection_missing', agent: { known: true, aic: 66.989505, records: 1, source: 'aggregate' }, detection: { known: false, aic: null, records: 0, source: 'detection_missing' } }],
  ['unrelated nested credits are absent', [{ name: 'other.json', text: '{"nested":{"ai_credits":9}}' }], { known: false, aic: null, records: 0, source: 'agent_missing+detection_missing', agent: { known: false, aic: null, records: 0, source: 'agent_missing' }, detection: { known: false, aic: null, records: 0, source: 'detection_missing' } }],
]) assert.deepEqual(history.extractAicFromFiles(files), expected, name);

for (const [name, coverage, runs, expected] of [
  ['no eligible runs stays unknown', { eligibleRuns: 0, runsWithValues: 0, total: null }, [], null],
  ['complete coverage totals values', { eligibleRuns: 1, runsWithValues: 1, total: null }, [{ aic: 4 }], 4],
  ['skipped run is excluded from total', { eligibleRuns: 1, runsWithValues: 1, total: null }, [{ aic: 4, conclusion: 'success' }, { aic: 99, conclusion: 'skipped' }], 4],
  ['partial coverage stays unknown', { eligibleRuns: 2, runsWithValues: 1, total: null }, [{ aic: 4 }, { aic: null }], null],
]) { history.finalizeAicCoverage(coverage, runs); assert.equal(coverage.total, expected, name); }
const decimalCoverage = { eligibleRuns: 2, runsWithValues: 2, total: null };
history.finalizeAicCoverage(decimalCoverage, [{ conclusion: 'success', aic: 0.1 }, { conclusion: 'success', aic: 0.2 }]);
assert.equal(decimalCoverage.total, 0.3, 'complete total has stable decimal precision');
const emptyCoverage = { relevantRuns: 0, eligibleRuns: 0, ineligibleRuns: 0, runsWithValues: 0, artifactBackedRuns: 0, commentBackedRuns: 0, missingOrExpired: 0, total: null };
const incompleteCoverage = { relevantRuns: 2, eligibleRuns: 2, ineligibleRuns: 0, runsWithValues: 1, artifactBackedRuns: 1, commentBackedRuns: 0, missingOrExpired: 1, total: null };
const completeCoverage = { relevantRuns: 2, eligibleRuns: 1, ineligibleRuns: 1, runsWithValues: 1, artifactBackedRuns: 0, commentBackedRuns: 1, missingOrExpired: 0, total: 2.5 };
assert.equal(history.mergeAicCoverage(emptyCoverage, incompleteCoverage).total, null, 'incomplete repository coverage remains unknown');
assert.deepEqual(history.mergeAicCoverage(history.mergeAicCoverage(emptyCoverage, completeCoverage), completeCoverage), { relevantRuns: 4, eligibleRuns: 2, ineligibleRuns: 2, runsWithValues: 2, artifactBackedRuns: 0, commentBackedRuns: 2, missingOrExpired: 0, total: null }, 'merge leaves final total for global finalization');
const finalizedCompleteCoverage = history.mergeAicCoverage(emptyCoverage, completeCoverage);
history.finalizeAicCoverage(finalizedCompleteCoverage, [{ conclusion: 'success', aic: 2.5 }, { conclusion: 'skipped', aic: 99 }]);
assert.equal(finalizedCompleteCoverage.total, 2.5, 'complete merged coverage finalizes while excluding skipped runs');
assert.equal(history.aicEligible({ conclusion: 'skipped' }), false);
assert.equal(history.aicEligible({ conclusion: 'success' }), true);

const footer = '> Generated by [Drafter](https://github.com/bootc-dev/bcvk/actions/runs/33798440561) · claude · sonnet45 · 133.1 AIC · ⌖ 61.3 AIC · details';
for (const [name, comment, expected] of [
  ['old footer sums agent and threat', { id: 2, html_url: 'https://example.test/comment/2', body: footer }, { runId: 33798440561, agentAic: 133.1, detectionAic: 61.3, aic: 194.4, commentUrl: 'https://example.test/comment/2', commentId: 2 }],
  ['new footer verifies hidden run', { id: 3, body: `${footer}\n<!-- gh-aw-agentic-workflow: x, id: 33798440561, workflow_id: drafter, run: https://github.com/bootc-dev/bcvk/actions/runs/33798440561 -->` }, { runId: 33798440561, agentAic: 133.1, detectionAic: 61.3, aic: 194.4, commentUrl: null, commentId: 3 }],
  ['no threat is accepted', { id: 4, body: '> Generated by [PR Fix Agent](https://github.com/bootc-dev/bcvk/actions/runs/34494688968) · claude · 73 AIC · details' }, { runId: 34494688968, agentAic: 73, detectionAic: null, aic: 73, commentUrl: null, commentId: 4 }],
  ['arbitrary prose is rejected', { id: 5, body: 'Generated by somebody: https://github.com/x/y/actions/runs/12 and 9 AIC' }, null],
  ['negative is rejected', { id: 6, body: '> Generated by [x](https://github.com/x/y/actions/runs/12) · -9 AIC' }, null],
  ['conflicting hidden run is rejected', { id: 7, body: `${footer}\n<!-- gh-aw-agentic-workflow: x, id: 2, workflow_id: drafter, run: https://github.com/x/y/actions/runs/2 -->` }, null],
]) {
  const actual = history.parseCommentAic(comment);
  if (expected === null) assert.equal(actual, null, name);
  else assert.deepEqual(actual, {
    ...expected, actor: comment.user && comment.user.login || null, createdAt: comment.created_at || null, updatedAt: comment.updated_at || null,
    footerRunUrl: comment.body.match(/\((https:\/\/github\.com\/[^)]+\/actions\/runs\/\d+)\)/)[1],
    bodySha256: crypto.createHash('sha256').update(comment.body).digest('hex'),
  }, name);
}
for (const [displayed, expected] of [['0.125', 0.125], ['1.25', 1.25], ['12.3', 12.3], ['1.2K', 1200], ['2M', 2000000]]) {
  const parsed = history.parseCommentAic({ id: 8, body: `> Generated by [x](https://github.com/x/y/actions/runs/8) · ${displayed} AIC` });
  assert.equal(parsed.agentAic, expected, `displayed AIC ${displayed}`);
}
assert.equal(history.parseCommentAic({ id: 8, body: '> Generated by [x](https://github.com/x/y/actions/runs/8) · 0.125 AIC · ⌖ 1.25 AIC' }).aic, 1.375, 'displayed components retain precision when summed');

const commentInterval = history.parseMonth('2024-02');
assert.deepEqual(history.botCommentsInInterval([
  { id: 1, user: { login: 'bot[bot]' }, created_at: '2024-02-01T00:00:00Z' },
  { id: 2, user: { login: 'other' }, created_at: '2024-02-02T00:00:00Z' },
  { id: 3, user: { login: 'bot[bot]' }, created_at: '2024-03-01T00:00:00Z' },
], 'bot[bot]', commentInterval).map((comment) => comment.id), [1], 'actor and UTC month filtering');

const same = { runId: 9, agentAic: 1, detectionAic: 2, aic: 3, commentUrl: 'a', commentId: 2 };
assert.deepEqual(history.deduplicateCommentAic([same, { ...same, commentId: 1, commentUrl: 'b' }]), { records: [{ ...same, commentId: 1, commentUrl: 'b' }], errors: [] }, 'duplicate agreement is deterministic');
assert.deepEqual(history.deduplicateCommentAic([same, { ...same, aic: 4, detectionAic: 3 }]), { records: [], errors: [{ runId: 9, message: 'conflicting comment AIC records' }] }, 'duplicate conflict is excluded');
const fallbackRuns = [{ id: 1, aic: 10, aicSource: 'aggregate' }, { id: 2, aic: null }];
assert.equal(history.applyCommentAicFallback(fallbackRuns, [{ runId: 1, agentAic: 1, detectionAic: null, aic: 1, commentUrl: 'one', commentId: 1 }, { runId: 2, agentAic: 2, detectionAic: 3, aic: 5, commentUrl: 'two', commentId: 2 }]), 1);
assert.equal(fallbackRuns[0].aic, 10, 'artifact AIC takes precedence');
assert.deepEqual({ id: fallbackRuns[1].id, aic: fallbackRuns[1].aic, aicSource: fallbackRuns[1].aicSource, aicAgent: fallbackRuns[1].aicAgent, aicDetection: fallbackRuns[1].aicDetection, aicCommentUrl: fallbackRuns[1].aicCommentUrl, aicCommentId: fallbackRuns[1].aicCommentId }, { id: 2, aic: 5, aicSource: 'comment_footer', aicAgent: 2, aicDetection: 3, aicCommentUrl: 'two', aicCommentId: 2 }, 'comment fallback retains components');

const integrationRuns = [{ id: 10, conclusion: 'success', aic: 7, aicArtifactKnown: true, aicSource: 'aggregate' }, { id: 11, conclusion: 'success', aic: null }, { id: 12, conclusion: 'skipped', aic: null }, { id: 13, conclusion: 'success', aic: null }];
const integrationComments = [
  { id: 1, user: { login: 'bot[bot]' }, created_at: '2024-02-02T00:00:00Z', updated_at: '2024-02-02T00:00:00Z', body: '> Generated by [x](https://github.com/x/y/actions/runs/10) · 2 AIC' },
  { id: 2, user: { login: 'bot[bot]' }, created_at: '2024-02-02T00:00:00Z', updated_at: '2024-02-02T00:00:00Z', body: '> Generated by [x](https://github.com/x/y/actions/runs/11) · 0.125 AIC · ⌖ 1.25 AIC' },
  { id: 3, user: { login: 'bot[bot]' }, created_at: '2024-02-02T00:00:00Z', body: '> Generated by [x](https://github.com/x/y/actions/runs/12) · 3 AIC' },
  { id: 4, user: { login: 'bot[bot]' }, created_at: '2024-02-02T00:00:00Z', body: '> Generated by [x](https://github.com/x/y/actions/runs/99) · 3 AIC' },
  { id: 5, user: { login: 'wrong' }, created_at: '2024-02-02T00:00:00Z', body: '> Generated by [x](https://github.com/x/y/actions/runs/13) · 3 AIC' },
  { id: 6, user: { login: 'bot[bot]' }, created_at: '2024-03-01T00:00:00Z', body: '> Generated by [x](https://github.com/x/y/actions/runs/13) · 3 AIC' },
  { id: 7, user: { login: 'bot[bot]' }, created_at: '2024-02-02T00:00:00Z', body: '> Generated by [x](https://github.com/x/y/actions/runs/13) · 3 AIC' },
  { id: 8, user: { login: 'bot[bot]' }, created_at: '2024-02-02T00:00:00Z', body: '> Generated by [x](https://github.com/x/y/actions/runs/13) · 4 AIC' },
];
const integration = history.integrateCommentAic(integrationComments, 'bot[bot]', commentInterval, integrationRuns);
assert.equal(integration.commentBackedRuns, 1);
assert.deepEqual(integration.evidence.map((record) => record.runId), [10, 11]);
assert.deepEqual(integration.errors, [{ runId: 13, message: 'conflicting comment AIC records' }]);
assert.deepEqual(integrationRuns.map((run) => run.aic), [7, 1.375, null, null], 'artifact wins; skipped, unrelated, conflict, and review-without-metadata remain unknown');
assert.deepEqual(history.summarizeAicCoverage(integrationRuns), { relevantRuns: 4, eligibleRuns: 3, ineligibleRuns: 1, runsWithValues: 2, artifactBackedRuns: 1, commentBackedRuns: 1, missingOrExpired: 1, total: null }, 'coverage tracks sources and incomplete runs');
assert.deepEqual(history.parseArgs(['bootc-dev', '2024-02', '--output', '/tmp/a', '--bot', 'bootc-bot[bot]']), { org: 'bootc-dev', month: '2024-02', output: '/tmp/a', bot: 'bootc-bot[bot]' });
assert.throws(() => history.parseArgs(['bootc-dev', '2024-02', '--bot']), /Usage/);
assert.throws(() => history.parseArgs(['bootc-dev', '2024-02', '--bot', 'one', '--bot', 'two']), /Usage/);

const rangeStart = '2024-02-01T00:00:00.000Z';
const rangeEnd = '2024-02-02T00:00:00.000Z';
const calls = [];
const runs = history.boundedWorkflowRuns((start, end) => {
  calls.push([start, end]);
  return calls.length === 1 ? Array.from({ length: 1000 }, (_, id) => ({ id })) : [{ id: 2 }, { id: 1 }];
}, rangeStart, rangeEnd);
assert.deepEqual(runs.map((run) => run.id), [1, 2]);
assert.deepEqual(calls, [
  [rangeStart, '2024-02-01T23:59:59.999Z'],
  [rangeStart, '2024-02-01T11:59:59.999Z'],
  ['2024-02-01T12:00:00.000Z', '2024-02-01T23:59:59.999Z'],
]);
assert.throws(() => history.boundedWorkflowRuns(() => Array.from({ length: 1000 }, (_, id) => ({ id })), rangeStart, '2024-02-01T00:00:00.001Z'), /1,000-result cap/);

const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-history-test-'));
const output = path.join(outputDirectory, 'snapshot.json');
try {
  history.writeSnapshot(output, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { ok: true });
  assert.throws(() => history.writeSnapshot(output, { ok: false }), /EEXIST/);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
} finally { fs.rmSync(outputDirectory, { recursive: true, force: true }); }
