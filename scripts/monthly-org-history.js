#!/usr/bin/env node
'use strict';

// Collect a reproducible, machine-readable monthly snapshot.  Narrative belongs in
// the companion skill, not here, so that conclusions can be reviewed separately.
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 3;
const AGENT_LABELS = ['agent/code', 'agent/fixme', 'agent/lgtm'];
const WORKFLOW_NAMES = new Map([
  ['Drafter', 'drafter'], ['PR Review Agent', 'review'], ['PR Fix Agent', 'fix'],
  ['PR CI Failure Analyzer', 'ci-triage'], ['Merge Queue Failure Analyzer', 'queue-triage'],
]);
const WORKFLOW_PATHS = new Map([
  ['drafter.lock.yml', 'drafter'], ['review.lock.yml', 'review'], ['fix.lock.yml', 'fix'],
  ['ci-triage.lock.yml', 'ci-triage'], ['queue-triage.lock.yml', 'queue-triage'],
  ['drafter.yml', 'drafter'], ['review.yml', 'review'], ['fix.yml', 'fix'],
  ['ci-triage.yml', 'ci-triage'], ['queue-triage.yml', 'queue-triage'],
]);
const AGGREGATE_USAGE_FILE = 'agent_usage.json';
const TOKEN_USAGE_FILE = 'agent/token_usage.jsonl';

function parseMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Month must be YYYY-MM, got ${month}`);
  const [year, number] = month.split('-').map(Number);
  if (year < 1000) throw new Error(`Year must be at least 1000, got ${year}`);
  const start = new Date(Date.UTC(year, number - 1, 1));
  const end = new Date(Date.UTC(year, number, 1));
  return { month, start: start.toISOString(), end: end.toISOString() };
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
    createdInMonth: inInterval(item.created_at, interval), mergedInMonth: isPullRequest && inInterval(item.merged_at, interval),
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
  return WORKFLOW_NAMES.get(run.name || run.workflow_name) || WORKFLOW_PATHS.get(path.posix.basename(run.path || '')) || null;
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
  const result = { issuesCreated: 0, prsCreated: 0, prsMerged: 0, agentLabelSignals: {}, agentBranchPrs: 0, attribution: { cohort: 'items_created_in_month', items: 0, assistedByAi: 0, generatedByAi: 0 }, workflows: {} };
  for (const item of items) {
    if (item.type === 'issue' && item.createdInMonth) result.issuesCreated++;
    if (item.type === 'pull_request' && item.createdInMonth) result.prsCreated++;
    if (item.mergedInMonth) result.prsMerged++;
    if (item.agentBranch) result.agentBranchPrs++;
    for (const label of item.agentLabels) result.agentLabelSignals[label] = (result.agentLabelSignals[label] || 0) + 1;
    if (item.createdInMonth) {
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
function parseCommentAic(comment) {
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
  if (!Number.isSafeInteger(Number(footerRunId)) || Number(footerRunId) <= 0 || !Number.isSafeInteger(comment.id) || comment.id <= 0 || !finiteNonnegative(agentAic) || (detectionAic !== null && !finiteNonnegative(detectionAic))) return null;
  return {
    runId: Number(footerRunId), agentAic: normalizeAic(agentAic), detectionAic: detectionAic === null ? null : normalizeAic(detectionAic),
    aic: normalizeAic(agentAic + (detectionAic === null ? 0 : detectionAic)),
    actor: comment.user && comment.user.login || null, createdAt: comment.created_at || null, updatedAt: comment.updated_at || null,
    footerRunUrl: footer[1], commentUrl: comment.html_url || comment.url || null, commentId: comment.id,
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
    } else accepted.push(first);
  }
  return { records: accepted, errors };
}

function applyCommentAicFallback(runs, records) {
  const byRun = new Map(records.map((record) => [record.runId, record]));
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

function integrateCommentAic(comments, bot, interval, relevantRuns) {
  const eligibleById = new Map(relevantRuns.filter(aicEligible).map((run) => [run.id, run]));
  const parsed = botCommentsInInterval(comments, bot, interval).map(parseCommentAic)
    .filter((record) => record && eligibleById.has(record.runId));
  const usage = deduplicateCommentAic(parsed);
  return {
    evidence: usage.records,
    errors: usage.errors,
    commentBackedRuns: applyCommentAicFallback([...eligibleById.values()], usage.records),
  };
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

function collect(org, interval, bot) {
  // These are global prerequisites: do not turn a missing CLI/authentication
  // problem into misleading per-repository coverage gaps.
  exec('gh', ['auth', 'status']);
  exec('unzip', ['-v']);
  const repositories = paged(`orgs/${org}/repos?type=all&per_page=100`).filter((repo) => !repo.archived && !repo.fork).sort((a, b) => a.name.localeCompare(b.name));
  const snapshot = { schemaVersion: SCHEMA_VERSION, org, month: interval.month, bot: bot || null, interval: { start: interval.start, end: interval.end }, repositories: [], items: [], workflowRuns: [], commentAic: [], coverage: { repositories: { included: repositories.length, failed: [] }, aic: { relevantRuns: 0, eligibleRuns: 0, runsWithValues: 0, artifactBackedRuns: 0, commentBackedRuns: 0, ineligibleRuns: 0, missingOrExpired: 0, total: null } }, errors: [] };
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
      }), name, interval).filter((item) => inInterval(item.updatedAt, interval) || item.createdInMonth || item.mergedInMonth);
      const runs = fetchWorkflowRuns(org, name, interval).filter((run) => inInterval(run.created_at, interval));
      const relevant = runs.filter(classifyWorkflow);
      for (const run of relevant) {
        if (!aicEligible(run)) continue;
        try { const usage = collectRunUsage(org, name, run); if (usage.error) repositoryErrors.push({ repository: name, operation: `artifact/${run.id}`, message: usage.error }); run.aic = usage.known ? usage.aic : null; run.aicArtifactKnown = usage.known; run.aicSource = usage.source; run.aicRecords = usage.records; }
        catch (error) { run.aic = null; repositoryErrors.push({ repository: name, operation: `artifact/${run.id}`, message: error.message }); }
      }
      if (bot) {
        try {
          const commentUsage = integrateCommentAic(paged(`repos/${org}/${name}/issues/comments?since=${encodeURIComponent(issueSince(interval))}&per_page=100`), bot, interval, relevant);
          for (const error of commentUsage.errors) repositoryErrors.push({ repository: name, operation: `comment/${error.runId}`, message: error.message });
          snapshot.commentAic.push(...commentUsage.evidence.map((record) => ({ repository: name, ...record })));
        } catch (error) { repositoryErrors.push({ repository: name, operation: 'comments', message: error.message }); }
      }
      repositoryAic = summarizeAicCoverage(relevant);
      const workflowRuns = runs.map((run) => ({ repository: name, id: run.id, url: run.html_url, name: run.name, path: run.path, createdAt: run.created_at, conclusion: run.conclusion, kind: classifyWorkflow(run), aic: run.aic === undefined ? null : run.aic, aicSource: run.aicSource || null, aicRecords: run.aicRecords === undefined ? null : run.aicRecords, aicAgent: run.aicAgent === undefined ? null : run.aicAgent, aicDetection: run.aicDetection === undefined ? null : run.aicDetection, aicCommentActor: run.aicCommentActor || null, aicCommentCreatedAt: run.aicCommentCreatedAt || null, aicCommentUpdatedAt: run.aicCommentUpdatedAt || null, aicFooterRunUrl: run.aicFooterRunUrl || null, aicCommentUrl: run.aicCommentUrl || null, aicCommentId: run.aicCommentId === undefined ? null : run.aicCommentId, aicCommentBodySha256: run.aicCommentBodySha256 || null })).filter((run) => run.kind);
      snapshot.items.push(...items);
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
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const positional = []; let output; let bot;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--output' || argument === '--bot') {
      const value = argv[++index]; if (!value) throw new Error(help());
      if (argument === '--output') {
        if (output !== undefined) throw new Error(help());
        output = value;
      } else {
        if (bot !== undefined) throw new Error(help());
        bot = value;
      }
    } else if (argument.startsWith('--')) throw new Error(help()); else positional.push(argument);
  }
  if (positional.length !== 2) throw new Error(help());
  return { org: positional[0], month: positional[1], output, bot };
}
function help() { return "Usage: node scripts/monthly-org-history.js ORG YYYY-MM [--output PATH] [--bot LOGIN]\n\nCollect a deterministic UTC monthly GitHub-organization snapshot. --bot reads that bot's in-month issue/PR conversation comments as a human-formatted AIC fallback when retained artifacts are unavailable; artifacts remain authoritative. Hidden metadata verifies run identity only; it is not AIC without a generated footer. PR review bodies currently have no AIC metadata. Bot comments and retained artifacts may be unavailable. Requires authenticated gh and unzip. Refuses to overwrite an existing output path."; }
function main(argv) {
  const args = parseArgs(argv); if (args.help) return console.log(help());
  const output = args.output || path.join(os.tmpdir(), `${args.org}-${args.month}-history.json`);
  writeSnapshot(output, collect(args.org, parseMonth(args.month), args.bot));
  console.log(`Wrote ${output}`);
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(`monthly-org-history: ${error.message}`); process.exitCode = 1; } }
module.exports = { aggregateRepository, aicEligible, applyCommentAicFallback, botCommentsInInterval, boundedWorkflowRuns, classifyItems, classifyWorkflow, deduplicateCommentAic, extractAicFromFiles, finalizeAicCoverage, inInterval, integrateCommentAic, issueSince, markers, mergeAicCoverage, parseArgs, parseCommentAic, parseMonth, summarizeAicCoverage, writeSnapshot };
