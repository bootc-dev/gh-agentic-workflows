#!/usr/bin/env node
'use strict';

// Collect a reproducible, machine-readable period snapshot. Narrative belongs in
// the companion skill, not here, so that conclusions can be reviewed separately.
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 5;
const AGENT_LABELS = ['agent/code', 'agent/fixme', 'agent/lgtm'];
const AGGREGATE_USAGE_FILE = 'agent_usage.json';
const TOKEN_USAGE_FILE = 'agent/token_usage.jsonl';

function parseMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Month must be YYYY-MM, got ${month}`);
  const [year, number] = month.split('-').map(Number);
  if (year < 1000) throw new Error(`Year must be at least 1000, got ${year}`);
  const start = new Date(Date.UTC(year, number - 1, 1));
  const end = new Date(Date.UTC(year, number, 1));
  return { period: month, start: start.toISOString(), end: end.toISOString() };
}

function isoWeekParts(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const year = utc.getUTCFullYear();
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const januaryFourthDay = januaryFourth.getUTCDay() || 7;
  januaryFourth.setUTCDate(januaryFourth.getUTCDate() - januaryFourthDay + 1);
  return { year, week: Math.floor((utc - januaryFourth) / 604800000) + 1 };
}

function parseIsoWeek(period) {
  const match = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(period);
  if (!match) throw new Error(`ISO week must be YYYY-Www, got ${period}`);
  const year = Number(match[1]); const week = Number(match[2]);
  if (year < 1000) throw new Error(`Year must be at least 1000, got ${year}`);
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const day = januaryFourth.getUTCDay() || 7;
  const start = new Date(Date.UTC(year, 0, 4 - day + 1 + (week - 1) * 7));
  const resolved = isoWeekParts(start);
  if (resolved.year !== year || resolved.week !== week) throw new Error(`ISO year ${year} does not have week ${week}`);
  const end = new Date(start.getTime() + 7 * 86400000);
  return { period, start: start.toISOString(), end: end.toISOString() };
}

function parsePeriod(period) {
  return /^\d{4}-W/.test(period) ? parseIsoWeek(period) : parseMonth(period);
}

function historyFilename(period) {
  return `${parseIsoWeek(period).period.replace('-W', '-')}.json`;
}

function previousCompleteIsoWeek(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Expected a valid date');
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7;
  const start = new Date(midnight.getTime() - (daysSinceMonday + 7) * 86400000);
  const { year, week } = isoWeekParts(start);
  return parseIsoWeek(`${year}-W${String(week).padStart(2, '0')}`);
}

function inInterval(value, interval) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(interval.start) && timestamp < Date.parse(interval.end);
}

function issueSince(interval) { return new Date(Date.parse(interval.start) - 1).toISOString(); }

function labelsOf(item) {
  return (item.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean).sort();
}

function markers(body) {
  const text = body || '';
  return {
    assistedByAi: (text.match(/^Assisted-by:\s*AI\s*$/gim) || []).length,
    generatedByAi: (text.match(/^Generated-by:\s*AI\s*$/gim) || []).length,
  };
}

function itemRecord(item, repository, interval) {
  const isPullRequest = Boolean(item.pull_request || item.is_pull_request);
  const labels = labelsOf(item);
  return {
    repository, number: item.number, url: item.html_url || item.url, type: isPullRequest ? 'pull_request' : 'issue',
    title: item.title || '', createdAt: item.created_at, updatedAt: item.updated_at,
    mergedAt: item.merged_at || null, labels, headRefName: item.head && item.head.ref || item.head_ref_name || null,
    createdInPeriod: inInterval(item.created_at, interval), mergedInPeriod: isPullRequest && inInterval(item.merged_at, interval),
    agentLabels: labels.filter((label) => AGENT_LABELS.includes(label)),
    agentBranch: isPullRequest && /^agent\//.test(item.head && item.head.ref || item.head_ref_name || ''),
    attribution: markers(item.body),
  };
}

function classifyItems(items, repository, interval) {
  return items.map((item) => itemRecord(item, repository, interval)).sort((a, b) =>
    a.repository.localeCompare(b.repository) || a.number - b.number);
}

function classifyWorkflow(run) {
  const match = path.posix.basename(run.path || '').match(/^(.+)\.lock\.yml$/);
  return match ? match[1] : null;
}

function conclusionCounts(runs) {
  const counts = {};
  for (const run of runs) {
    const conclusion = run.conclusion || run.status || 'unknown';
    counts[conclusion] = (counts[conclusion] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function aggregateRepository(items, workflows) {
  const result = { issuesCreated: 0, prsCreated: 0, prsMerged: 0, agentLabelSignals: {}, agentBranchPrs: 0, attribution: { cohort: 'items_created_in_period', items: 0, assistedByAi: 0, generatedByAi: 0 }, workflows: {} };
  for (const item of items) {
    if (item.type === 'issue' && item.createdInPeriod) result.issuesCreated++;
    if (item.type === 'pull_request' && item.createdInPeriod) result.prsCreated++;
    if (item.mergedInPeriod) result.prsMerged++;
    if (item.agentBranch) result.agentBranchPrs++;
    for (const label of item.agentLabels) result.agentLabelSignals[label] = (result.agentLabelSignals[label] || 0) + 1;
    if (item.createdInPeriod) {
      result.attribution.items++;
      result.attribution.assistedByAi += item.attribution.assistedByAi;
      result.attribution.generatedByAi += item.attribution.generatedByAi;
    }
  }
  for (const run of workflows) {
    const kind = classifyWorkflow(run);
    if (!kind) continue;
    (result.workflows[kind] ||= []).push(run);
  }
  for (const kind of Object.keys(result.workflows)) result.workflows[kind] = conclusionCounts(result.workflows[kind]);
  return result;
}

function finiteNonnegative(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

function itemIdentityFromUrl(url, org, repository) {
  if (typeof url !== 'string') return null;
  const escapedOrg = org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^https://(?:api\\.)?github\\.com/${url.includes('api.github.com') ? 'repos/' : ''}${escapedOrg}/${escapedRepository}/(?:issues|pulls)/(\\d+)$`).exec(url);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? { number } : null;
}

function commentItemIdentity(issueUrl, commentUrl, org, repository) {
  const issue = itemIdentityFromUrl(issueUrl, org, repository);
  if (!issue || typeof commentUrl !== 'string') return null;
  const escapedOrg = org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^(https://github\\.com/${escapedOrg}/${escapedRepository}/(issues|pull)/(\\d+))(?:#issuecomment-\\d+)?$`).exec(commentUrl);
  if (!match || Number(match[3]) !== issue.number) return null;
  return { number: issue.number, url: match[1] };
}

function runUrlForRepository(url, org, repository) {
  if (typeof url !== 'string') return null;
  const escapedOrg = org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^https://github\\.com/${escapedOrg}/${escapedRepository}/actions/runs/(\\d+)$`).exec(url);
  return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 ? Number(match[1]) : null;
}

function normalizedPullRequests(run, org, repository) {
  const escapedOrg = org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^https://api\\.github\\.com/repos/${escapedOrg}/${escapedRepository}/pulls/(\\d+)$`);
  const references = new Map();
  for (const pullRequest of run.pull_requests || []) {
    const match = pattern.exec(pullRequest.url);
    const number = match && Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0) references.set(number, { number, url: `https://github.com/${org}/${repository}/pull/${number}` });
  }
  return [...references.values()].sort((a, b) => a.number - b.number);
}

function cumulativeUsage(files, filename, component) {
  const selected = files.filter((file) => file.name === filename);
  if (!selected.length) return { known: false, aic: null, records: 0, source: `${component}_missing` };
  const totals = new Set();
  for (const file of selected) {
    const text = String(file.text);
    if (!text.trim()) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!finiteNonnegative(event.ai_credits_total)) return { known: false, aic: null, records: 0, source: `${component}_malformed` };
        totals.add(event.ai_credits_total);
      } catch (_) { return { known: false, aic: null, records: 0, source: `${component}_malformed` }; }
    }
  }
  return { known: true, aic: totals.size ? Math.max(...totals) : 0, records: totals.size, source: totals.size ? `${component}_token_total` : `${component}_empty` };
}

function extractAicFromFiles(files) {
  // gh-aw's root aggregate is authoritative.  Do not also read token events:
  // their `ai_credits_total` is cumulative and would double-count the aggregate.
  const aggregateFiles = files.filter((file) => file.name === AGGREGATE_USAGE_FILE);
  const aggregateValues = new Set();
  let malformedAggregate = false;
  for (const file of aggregateFiles) {
    try {
      const usage = JSON.parse(file.text);
      if (usage && typeof usage === 'object' && finiteNonnegative(usage.ai_credits)) aggregateValues.add(usage.ai_credits);
      else malformedAggregate = true;
    } catch (_) { malformedAggregate = true; }
  }
  let agent;
  if (aggregateFiles.length) {
    if (malformedAggregate || aggregateValues.size !== 1) return { known: false, aic: null, records: 0, source: malformedAggregate ? 'malformed_aggregate' : 'conflicting_aggregates' };
    agent = { known: true, aic: [...aggregateValues][0], records: 1, source: 'aggregate' };
  } else {
    agent = cumulativeUsage(files, TOKEN_USAGE_FILE, 'agent');
  }
  const detection = cumulativeUsage(files, 'detection/token_usage.jsonl', 'detection');
  if (!agent.known || !detection.known) return { known: false, aic: null, records: 0, source: `${agent.source}+${detection.source}`, agent, detection };
  return { known: true, aic: agent.aic + detection.aic, records: agent.records + detection.records, source: `${agent.source}+${detection.source}`, agent, detection };
}

function normalizeAic(value) { return Number(value.toFixed(6)); }

// Only read the machine-produced footer, not arbitrary discussion of AIC in a
// comment.  The optional hidden marker is emitted by newer gh-aw versions and
// gives an independently labelled run identity.
function parseCommentAic(comment, org, repository) {
  const body = typeof comment.body === 'string' ? comment.body : '';
  const footers = [...body.matchAll(/^>\s*Generated by\s+\[[^\]]+\]\((https:\/\/github\.com\/[^\s)]+\/actions\/runs\/(\d+))\)([^\r\n]*)$/gim)];
  const hiddenMarkers = [...body.matchAll(/<!--\s*gh-aw-agentic-workflow:\s*[^>]*?\bid:\s*(\d+)\s*,\s*workflow_id:\s*[^,\s]+\s*,\s*run:\s*(https:\/\/github\.com\/[^\s>]+\/actions\/runs\/(\d+))\s*-->/gi)];
  if (footers.length > 1 || hiddenMarkers.length > 1) return null;
  const footer = footers[0];
  const hidden = hiddenMarkers[0];
  if (!footer && !hidden) return null;
  const footerRunId = footer && footer[2];
  const hiddenRunId = hidden && hidden[1];
  if (hidden && (hiddenRunId !== hidden[3] || (footerRunId && footerRunId !== hiddenRunId))) return null;
  if (!footer) return null; // Hidden metadata identifies a run, but does not itself contain usage.
  const tokens = [...footer[3].matchAll(/(?:^|·\s*)(⌖\s*)?(\d+(?:\.\d+)?)([KM])?\s+AIC\b/g)];
  const agent = tokens.filter((token) => !token[1]);
  const detection = tokens.filter((token) => token[1]);
  if (agent.length !== 1 || detection.length > 1) return null;
  const expandAic = (token) => Number(token[2]) * (token[3] === 'K' ? 1_000 : token[3] === 'M' ? 1_000_000 : 1);
  const agentAic = expandAic(agent[0]);
  const detectionAic = detection.length ? expandAic(detection[0]) : null;
  const item = commentItemIdentity(comment.issue_url, comment.html_url, org, repository);
  if (!Number.isSafeInteger(Number(footerRunId)) || Number(footerRunId) <= 0 || runUrlForRepository(footer[1], org, repository) !== Number(footerRunId) || (hidden && runUrlForRepository(hidden[2], org, repository) !== Number(hiddenRunId)) || !Number.isSafeInteger(comment.id) || comment.id <= 0 || !item || !finiteNonnegative(agentAic) || (detectionAic !== null && !finiteNonnegative(detectionAic))) return null;
  return {
    runId: Number(footerRunId), agentAic: normalizeAic(agentAic), detectionAic: detectionAic === null ? null : normalizeAic(detectionAic),
    aic: normalizeAic(agentAic + (detectionAic === null ? 0 : detectionAic)),
    actor: comment.user && comment.user.login || null, createdAt: comment.created_at || null, updatedAt: comment.updated_at || null,
    footerRunUrl: footer[1], commentUrl: comment.html_url || comment.url || null, commentId: comment.id,
    itemNumber: item.number, itemUrl: item.url,
    bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
  };
}

function botCommentsInInterval(comments, login, interval) {
  return comments.filter((comment) => comment.user && comment.user.login === login && inInterval(comment.created_at, interval));
}

function deduplicateCommentAic(records) {
  const grouped = new Map();
  for (const record of records) {
    const group = grouped.get(record.runId) || [];
    group.push(record);
    grouped.set(record.runId, group);
  }
  const accepted = []; const errors = [];
  for (const [runId, group] of [...grouped.entries()].sort(([a], [b]) => a - b)) {
    const ordered = group.sort((a, b) => a.commentId - b.commentId || String(a.commentUrl).localeCompare(String(b.commentUrl)));
    const first = ordered[0];
    if (ordered.some((record) => record.agentAic !== first.agentAic || record.detectionAic !== first.detectionAic || record.aic !== first.aic)) {
      errors.push({ runId, message: 'conflicting comment AIC records' });
    } else accepted.push(...ordered);
  }
  return { records: accepted, errors };
}

function applyCommentAicFallback(runs, records) {
  const byRun = new Map();
  for (const record of records) if (!byRun.has(record.runId)) byRun.set(record.runId, record);
  let commentBackedRuns = 0;
  for (const run of runs) {
    const record = byRun.get(run.id);
    if (!record || run.aic !== null && run.aic !== undefined) continue;
    run.aic = record.aic; run.aicSource = 'comment_footer'; run.aicRecords = 1;
    run.aicAgent = record.agentAic; run.aicDetection = record.detectionAic;
    run.aicCommentActor = record.actor; run.aicCommentCreatedAt = record.createdAt; run.aicCommentUpdatedAt = record.updatedAt;
    run.aicFooterRunUrl = record.footerRunUrl; run.aicCommentUrl = record.commentUrl; run.aicCommentId = record.commentId;
    run.aicCommentBodySha256 = record.bodySha256;
    commentBackedRuns++;
  }
  return commentBackedRuns;
}

function integrateCommentAic(comments, bot, interval, relevantRuns, org, repository) {
  const eligibleById = new Map(relevantRuns.filter(aicEligible).map((run) => [run.id, run]));
  const parsed = botCommentsInInterval(comments, bot, interval).map((comment) => parseCommentAic(comment, org, repository))
    .filter((record) => record && eligibleById.has(record.runId));
  const usage = deduplicateCommentAic(parsed);
  return {
    evidence: usage.records,
    errors: usage.errors,
    commentBackedRuns: applyCommentAicFallback([...eligibleById.values()], usage.records),
  };
}

function aicLinkedItems(items, runs, commentAic, org) {
  const itemsByKey = new Map(items.map((item) => [`${item.repository}/${item.number}`, item]));
  const runById = new Map(runs.filter((run) => (run.kind || classifyWorkflow(run)) && finiteNonnegative(run.aic)).map((run) => [run.id, run]));
  const links = new Map();
  const link = (repository, number, runId) => {
    const item = itemsByKey.get(`${repository}/${number}`);
    const run = runById.get(runId);
    if (!item || !run || run.repository !== repository) return;
    const ids = links.get(item) || new Set();
    ids.add(runId);
    links.set(item, ids);
  };
  for (const evidence of commentAic) link(evidence.repository, evidence.itemNumber, evidence.runId);
  for (const run of runById.values()) {
    for (const pullRequest of normalizedPullRequests(run, org, run.repository)) {
      const candidate = itemsByKey.get(`${run.repository}/${pullRequest.number}`);
      if (candidate && candidate.type === 'pull_request' && candidate.url === pullRequest.url) {
        link(run.repository, pullRequest.number, run.id);
      }
    }
  }
  return [...links.entries()].map(([item, runIds]) => ({ ...item, aicRunIds: [...runIds].sort((a, b) => a - b) }))
    .sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number);
}

function validateDetailedItems(items, workflowRuns, commentAic, org) {
  const runById = new Map(workflowRuns.map((run) => [run.id, run]));
  for (const item of items) {
    if (!Array.isArray(item.aicRunIds) || !item.aicRunIds.length) throw new Error(`Detailed item ${item.repository}#${item.number} has no AIC runs`);
    const itemPath = item.type === 'pull_request' ? 'pull' : item.type === 'issue' ? 'issues' : null;
    const canonicalItemUrl = itemPath && `https://github.com/${org}/${item.repository}/${itemPath}/${item.number}`;
    if (item.url !== canonicalItemUrl) throw new Error(`Detailed item ${item.repository}#${item.number} has a mismatched canonical URL`);
    const sortedUnique = [...new Set(item.aicRunIds)].sort((a, b) => a - b);
    if (JSON.stringify(item.aicRunIds) !== JSON.stringify(sortedUnique)) throw new Error(`Detailed item ${item.repository}#${item.number} has unsorted or duplicate AIC runs`);
    for (const runId of item.aicRunIds) {
      const run = runById.get(runId);
      if (!run || run.repository !== item.repository || !finiteNonnegative(run.aic)) throw new Error(`Detailed item ${item.repository}#${item.number} references unknown-AIC run ${runId}`);
      const commentEvidence = (commentAic || []).some((record) => record.repository === item.repository && record.runId === runId && record.itemNumber === item.number && record.itemUrl === item.url);
      const pullRequestEvidence = item.type === 'pull_request' && (run.pullRequests || []).some((reference) => reference.number === item.number && reference.url === item.url);
      if (!commentEvidence && !pullRequestEvidence) throw new Error(`Detailed item ${item.repository}#${item.number} lacks exact evidence for run ${runId}`);
    }
  }
}

function summarizeAicCoverage(runs) {
  const coverage = { relevantRuns: runs.length, eligibleRuns: 0, ineligibleRuns: 0, runsWithValues: 0, artifactBackedRuns: 0, commentBackedRuns: 0, missingOrExpired: 0, total: null };
  for (const run of runs) {
    if (!aicEligible(run)) { coverage.ineligibleRuns++; continue; }
    coverage.eligibleRuns++;
    if (run.aic === null || run.aic === undefined) { coverage.missingOrExpired++; continue; }
    coverage.runsWithValues++;
    if (run.aicArtifactKnown) coverage.artifactBackedRuns++;
    if (run.aicSource === 'comment_footer') coverage.commentBackedRuns++;
  }
  finalizeAicCoverage(coverage, runs);
  return coverage;
}

function exec(command, args, encoding = 'utf8') {
  return childProcess.execFileSync(command, args, { encoding, maxBuffer: 32 * 1024 * 1024 });
}
function ghJson(args) { return JSON.parse(exec('gh', ['api', ...args])); }
function paged(endpoint) { return ghJson(['--paginate', '--slurp', endpoint]).flat(); }
function pagedWorkflowRuns(endpoint) {
  return ghJson(['--paginate', '--slurp', endpoint]).flatMap((page) => page.workflow_runs || []);
}

function boundedWorkflowRuns(fetchRange, start, end) {
  const startMs = Date.parse(start); const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('Invalid workflow-run interval');
  function fetchPartition(low, high) {
    const runs = fetchRange(new Date(low).toISOString(), new Date(high - 1).toISOString());
    if (runs.length < 1000) return runs;
    if (high - low <= 1) throw new Error(`Workflow run query reached GitHub's 1,000-result cap for ${new Date(low).toISOString()}`);
    const middle = low + Math.floor((high - low) / 2);
    return [...fetchPartition(low, middle), ...fetchPartition(middle, high)];
  }
  const unique = new Map();
  for (const run of fetchPartition(startMs, endMs)) unique.set(run.id, run);
  return [...unique.values()].sort((a, b) => a.id - b.id);
}

function fetchWorkflowRuns(org, repo, interval) {
  return boundedWorkflowRuns((start, end) => pagedWorkflowRuns(
    `repos/${org}/${repo}/actions/runs?created=${encodeURIComponent(`${start}..${end}`)}&per_page=100`,
  ), interval.start, interval.end);
}

function usageFromArtifact(artifact) {
  let files;
  try { files = exec('unzip', ['-Z1', artifact], 'utf8').split(/\r?\n/).filter((name) => name === AGGREGATE_USAGE_FILE || name === TOKEN_USAGE_FILE || name === 'detection/token_usage.jsonl'); }
  catch (error) { return { files: [], error: `cannot inspect artifact: ${error.message}` }; }
  const extractedFiles = [];
  for (const file of files) {
    try { extractedFiles.push({ name: file, text: exec('unzip', ['-p', artifact, file], 'utf8') }); }
    catch (error) { return { files: extractedFiles, error: `cannot read ${file}: ${error.message}` }; }
  }
  return { files: extractedFiles };
}

function collectRunUsage(owner, repo, run) {
  const artifacts = ghJson(['--paginate', '--slurp', `repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?per_page=100`]).flatMap((page) => page.artifacts || []);
  if (!artifacts.length) return { known: false, missing: true, aic: null, records: 0, source: 'artifacts_missing' };
  const files = []; let error;
  for (const artifact of artifacts) {
    if (!/usage/i.test(artifact.name || '')) continue;
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-aw-usage-'));
    const temporary = path.join(temporaryDirectory, 'artifact.zip');
    try {
      fs.writeFileSync(temporary, exec('gh', ['api', `repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`], null));
      const extracted = usageFromArtifact(temporary); files.push(...extracted.files); error ||= extracted.error;
    } finally { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); }
  }
  const result = extractAicFromFiles(files);
  return { ...result, missing: !result.known, error };
}

function aicEligible(run) { return run.conclusion !== 'skipped'; }
function finalizeAicCoverage(coverage, runs) {
  if (coverage.eligibleRuns > 0 && coverage.runsWithValues === coverage.eligibleRuns) {
    coverage.total = normalizeAic(runs.filter(aicEligible).reduce((total, run) => total + (run.aic || 0), 0));
  }
}

function mergeAicCoverage(aggregate, repository) {
  const merged = { ...aggregate, total: null };
  for (const key of Object.keys(repository)) {
    if (key !== 'total') merged[key] = (merged[key] || 0) + repository[key];
  }
  return merged;
}

function writeSnapshot(output, snapshot) {
  fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function selectedRepositories(org, repositoryFilter) {
  if (!repositoryFilter) return paged(`orgs/${org}/repos?type=all&per_page=100`)
    .filter((repo) => !repo.archived && !repo.fork)
    .sort((a, b) => a.name.localeCompare(b.name));

  const repository = ghJson([`repos/${org}/${repositoryFilter}`]);
  const resolvedOwner = repository.owner && repository.owner.login;
  if (resolvedOwner !== org || repository.name !== repositoryFilter) {
    throw new Error(`Requested repository ${org}/${repositoryFilter} resolved to ${resolvedOwner || 'unknown'}/${repository.name || 'unknown'}`);
  }
  if (repository.archived) throw new Error(`Requested repository ${org}/${repositoryFilter} is archived`);
  if (repository.fork) throw new Error(`Requested repository ${org}/${repositoryFilter} is a fork`);
  return [repository];
}

function collect(org, interval, bot, repositoryFilter) {
  // These are global prerequisites: do not turn a missing CLI/authentication
  // problem into misleading per-repository coverage gaps.
  exec('gh', ['auth', 'status']);
  exec('unzip', ['-v']);
  const repositories = selectedRepositories(org, repositoryFilter);
  const snapshot = { schemaVersion: SCHEMA_VERSION, org, period: interval.period, bot: bot || null, repositoryFilter: repositoryFilter || null, interval: { start: interval.start, end: interval.end }, repositories: [], items: [], workflowRuns: [], commentAic: [], coverage: { repositories: { included: repositories.length, failed: [] }, aic: { relevantRuns: 0, eligibleRuns: 0, runsWithValues: 0, artifactBackedRuns: 0, commentBackedRuns: 0, ineligibleRuns: 0, missingOrExpired: 0, total: null } }, errors: [] };
  for (const repo of repositories) {
    let repositoryAic;
    try {
      const name = repo.name;
      const repositoryErrors = [];
      const rawItems = paged(`repos/${org}/${name}/issues?state=all&since=${encodeURIComponent(issueSince(interval))}&per_page=100`);
      const prs = [];
      for (const item of rawItems.filter((item) => item.pull_request)) {
        try { prs.push(ghJson([`repos/${org}/${name}/pulls/${item.number}`])); }
        catch (error) { repositoryErrors.push({ repository: name, operation: `pull/${item.number}`, message: error.message }); prs.push(item); }
      }
      const prByNumber = new Map(prs.map((item) => [item.number, item]));
      const items = classifyItems(rawItems.map((item) => {
        const pull = prByNumber.get(item.number);
        return pull ? { ...item, ...pull, pull_request: item.pull_request } : item;
      }), name, interval).filter((item) => inInterval(item.updatedAt, interval) || item.createdInPeriod || item.mergedInPeriod);
      const runs = fetchWorkflowRuns(org, name, interval).filter((run) => inInterval(run.created_at, interval)).map((run) => ({ ...run, repository: name }));
      const relevant = runs.filter(classifyWorkflow);
      for (const run of relevant) {
        if (!aicEligible(run)) continue;
        try { const usage = collectRunUsage(org, name, run); if (usage.error) repositoryErrors.push({ repository: name, operation: `artifact/${run.id}`, message: usage.error }); run.aic = usage.known ? usage.aic : null; run.aicArtifactKnown = usage.known; run.aicSource = usage.source; run.aicRecords = usage.records; }
        catch (error) { run.aic = null; repositoryErrors.push({ repository: name, operation: `artifact/${run.id}`, message: error.message }); }
      }
      if (bot) {
        try {
          const commentUsage = integrateCommentAic(paged(`repos/${org}/${name}/issues/comments?since=${encodeURIComponent(issueSince(interval))}&per_page=100`), bot, interval, relevant, org, name);
          for (const error of commentUsage.errors) repositoryErrors.push({ repository: name, operation: `comment/${error.runId}`, message: error.message });
          snapshot.commentAic.push(...commentUsage.evidence.map((record) => ({ repository: name, ...record })));
        } catch (error) { repositoryErrors.push({ repository: name, operation: 'comments', message: error.message }); }
      }
      repositoryAic = summarizeAicCoverage(relevant);
      const workflowRuns = runs.map((run) => ({ repository: name, id: run.id, url: run.html_url, name: run.name, path: run.path, createdAt: run.created_at, conclusion: run.conclusion, kind: classifyWorkflow(run), pullRequests: normalizedPullRequests(run, org, name), aic: run.aic === undefined ? null : run.aic, aicSource: run.aicSource || null, aicRecords: run.aicRecords === undefined ? null : run.aicRecords, aicAgent: run.aicAgent === undefined ? null : run.aicAgent, aicDetection: run.aicDetection === undefined ? null : run.aicDetection, aicCommentActor: run.aicCommentActor || null, aicCommentCreatedAt: run.aicCommentCreatedAt || null, aicCommentUpdatedAt: run.aicCommentUpdatedAt || null, aicFooterRunUrl: run.aicFooterRunUrl || null, aicCommentUrl: run.aicCommentUrl || null, aicCommentId: run.aicCommentId === undefined ? null : run.aicCommentId, aicCommentBodySha256: run.aicCommentBodySha256 || null })).filter((run) => run.kind);
      snapshot.items.push(...aicLinkedItems(items, runs, snapshot.commentAic.filter((record) => record.repository === name), org));
      snapshot.workflowRuns.push(...workflowRuns);
      snapshot.repositories.push({ name, url: repo.html_url, ...aggregateRepository(items, runs) });
      snapshot.errors.push(...repositoryErrors);
      snapshot.coverage.aic = mergeAicCoverage(snapshot.coverage.aic, repositoryAic);
    } catch (error) { snapshot.coverage.repositories.failed.push(repo.name); snapshot.errors.push({ repository: repo.name, operation: 'collection', message: error.message }); }
  }
  snapshot.items.sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number);
  snapshot.workflowRuns.sort((a, b) => a.repository.localeCompare(b.repository) || a.id - b.id);
  snapshot.commentAic.sort((a, b) => a.repository.localeCompare(b.repository) || a.runId - b.runId || a.commentId - b.commentId);
  finalizeAicCoverage(snapshot.coverage.aic, snapshot.workflowRuns);
  return snapshot;
}

function parseArgs(argv) {
  if (argv[0] === '--previous-iso-week') {
    if (argv.length === 1) return { previousIsoWeek: true };
    if (argv.length === 3 && argv[1] === '--as-of') return { previousIsoWeek: true, asOf: argv[2] };
    throw new Error(help());
  }
  if (argv[0] === '--history-filename' && argv.length === 2) return { historyFilename: argv[1] };
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const positional = []; let output; let bot; let repo;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--output' || argument === '--bot' || argument === '--repo') {
      const value = argv[++index]; if (!value) throw new Error(help());
      if (argument === '--output') {
        if (output !== undefined) throw new Error(help());
        output = value;
      } else if (argument === '--bot') {
        if (bot !== undefined) throw new Error(help());
        bot = value;
      } else {
        if (repo !== undefined) throw new Error(help());
        repo = value;
      }
    } else if (argument.startsWith('--')) throw new Error(help()); else positional.push(argument);
  }
  if (positional.length !== 2) throw new Error(help());
  return { org: positional[0], period: positional[1], output, bot, repo };
}
function help() { return "Usage: node scripts/org-history.js ORG PERIOD [--output PATH] [--repo REPO] [--bot LOGIN]\n       node scripts/org-history.js --previous-iso-week [--as-of ISO_TIMESTAMP]\n       node scripts/org-history.js --history-filename YYYY-Www\n\nCollect a deterministic UTC calendar-month (YYYY-MM) or ISO-week (YYYY-Www) GitHub-organization snapshot. --previous-iso-week prints the prior complete ISO Monday-Sunday week, optionally as of an ISO timestamp. --history-filename converts an ISO period to its canonical history/YYYY-WW.json basename. --repo limits collection to one non-archived, non-fork repository within ORG. --bot reads that bot's in-period issue/PR conversation comments as a human-formatted AIC fallback when retained artifacts are unavailable; artifacts remain authoritative. Hidden metadata verifies run identity only; it is not AIC without a generated footer. PR review bodies currently have no AIC metadata. Bot comments and retained artifacts may be unavailable. Requires authenticated gh and unzip. Refuses to overwrite an existing output path."; }
function main(argv) {
  const args = parseArgs(argv); if (args.help) return console.log(help());
  if (args.historyFilename) return console.log(historyFilename(args.historyFilename));
  if (args.previousIsoWeek) return console.log(previousCompleteIsoWeek(args.asOf === undefined ? new Date() : new Date(args.asOf)).period);
  const output = args.output || path.join(os.tmpdir(), `${args.org}-${args.period}-history.json`);
  writeSnapshot(output, collect(args.org, parsePeriod(args.period), args.bot, args.repo));
  console.log(`Wrote ${output}`);
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(`org-history: ${error.message}`); process.exitCode = 1; } }

module.exports = { aicLinkedItems, deduplicateCommentAic, historyFilename, normalizedPullRequests, parseCommentAic, parsePeriod, previousCompleteIsoWeek, validateDetailedItems };
