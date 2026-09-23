'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  LABELS, WORKFLOWS_DIR, candidateRepositories, describePlan, installLabels, isPipelineRepository, parseArgs, planLabelChanges, syncOrganization,
} = require('../scripts/install-labels.js');

const workflow = path.join(__dirname, '..', '.github', 'workflows', 'install-labels.yml');

test('install-labels.yml inlines the same LABELS as scripts/install-labels.js', () => {
  const source = fs.readFileSync(workflow, 'utf8');
  const match = /const LABELS = (\[[\s\S]*?\n\s*\]);/.exec(source);
  assert.ok(match, `no LABELS array found in ${workflow}`);
  const inlined = vm.runInNewContext(match[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(inlined)), JSON.parse(JSON.stringify(LABELS)));
});

test('LABELS are well-formed and unique', () => {
  const names = new Set();
  for (const label of LABELS) {
    assert.match(label.name, /^agent\/[a-z-]+$/);
    assert.match(label.color, /^[0-9A-F]{6}$/);
    assert.ok(label.description.length > 0 && label.description.length <= 100, `${label.name} description length`);
    assert.ok(!names.has(label.name.toLowerCase()), `duplicate ${label.name}`);
    names.add(label.name.toLowerCase());
  }
});

const DESIRED = [
  { name: 'agent/code', color: '0E8A16', description: 'Triggers' },
  { name: 'agent/lgtm', color: '0E8A16', description: 'Approved' },
  { name: 'agent/fixme', color: 'D93F0B', description: 'Fix it' },
  { name: 'agent/new', color: 'FBCA04', description: 'New' },
];

// What a repository whose labels already match DESIRED returns (the API
// lowercases colors), plus an unrelated label that must be left alone.
const IN_SYNC = [
  ...DESIRED.map((label) => ({ ...label, color: label.color.toLowerCase() })),
  { name: 'bug', color: 'ff0000', description: 'Unrelated' },
];

const DRIFTED = [
  { name: 'agent/code', color: 'ffffff', description: 'Triggers' },
  { name: 'agent/lgtm', color: '0e8a16', description: null },
  { name: 'Agent/Fixme', color: '000000', description: 'stale' },
  { name: 'agent/obsolete', color: '000000', description: 'never deleted' },
];

test('plans creates and updates without touching unrelated labels', () => {
  for (const [name, existing, expected] of [
    ['empty repository creates everything', [], { create: DESIRED.map((label) => label.name), update: [] }],
    ['already in sync', IN_SYNC, { create: [], update: [] }],
    ['mixed drift', DRIFTED, {
      create: ['agent/new'],
      update: [
        { name: 'agent/code', changes: ['color'] },
        { name: 'agent/lgtm', changes: ['description'] },
        { name: 'Agent/Fixme', changes: ['name', 'color', 'description'] },
      ],
    }],
  ]) {
    const plan = planLabelChanges(DESIRED, existing);
    assert.deepEqual({
      create: plan.create.map((label) => label.name),
      update: plan.update.map(({ name: current, changes }) => ({ name: current, changes })),
    }, expected, name);
    for (const { label } of plan.update) assert.ok(DESIRED.includes(label), `${name}: update carries the desired label`);
  }
});

test('describes a plan one line per change', () => {
  assert.deepEqual(describePlan(planLabelChanges(DESIRED, IN_SYNC)), []);
  assert.deepEqual(describePlan(planLabelChanges(DESIRED, DRIFTED)), [
    '  create agent/new (#FBCA04: New)',
    '  update agent/code: color',
    '  update agent/lgtm: description',
    '  update Agent/Fixme: name, color, description -> agent/fixme',
  ]);
});

/** A minimal Octokit stand-in that records every write. */
function fakeOctokit(existing) {
  const calls = [];
  const record = (method) => async (params) => { calls.push([method, params]); };
  const listLabelsForRepo = () => { throw new Error('listLabelsForRepo must go through paginate'); };
  return {
    calls,
    paginate: async (endpoint, params) => {
      assert.equal(endpoint, listLabelsForRepo);
      calls.push(['list', params]);
      return existing;
    },
    rest: { issues: { listLabelsForRepo, createLabel: record('create'), updateLabel: record('update') } },
  };
}

test('installLabels writes only what the plan says', async (t) => {
  t.mock.method(console, 'log', () => {});
  const context = { repo: { owner: 'o', repo: 'r' } };
  const [code, lgtm, ...rest] = LABELS;
  const existing = [
    { ...code, color: code.color.toLowerCase() },
    { ...lgtm, name: lgtm.name.toUpperCase(), description: 'stale' },
  ];
  const github = fakeOctokit(existing);
  await installLabels(github, context);
  assert.deepEqual(github.calls, [
    ['list', { owner: 'o', repo: 'r', per_page: 100 }],
    ...rest.map(({ name, color, description }) => ['create', { owner: 'o', repo: 'r', name, color, description }]),
    ['update', { owner: 'o', repo: 'r', name: lgtm.name.toUpperCase(), new_name: lgtm.name, color: lgtm.color, description: lgtm.description }],
  ]);
});

test('candidates are non-archived, non-dot repositories in stable order', () => {
  assert.deepEqual(candidateRepositories([
    { name: 'zeta', archived: false },
    { name: 'old', archived: true },
    { name: '.github', archived: false },
    { name: 'alpha', archived: false },
  ]), ['alpha', 'zeta']);
});

test('a repository with any compiled pipeline workflow runs the pipeline', () => {
  for (const [workflows, expected] of [
    [['drafter.lock.yml'], true],
    [['review.lock.yml'], true],
    [['ci.yml', 'fix.lock.yml'], true],
    [['drafter.md', 'review.md', 'fix.md'], false],
    [['ci-triage.lock.yml', 'ci.yml'], false],
    [[], false],
  ]) {
    assert.equal(isPipelineRepository(workflows), expected, JSON.stringify(workflows));
  }
});

/**
 * An organization client stand-in: `repos` maps each repository name to
 * `{ workflows, labels }`, or to an Error its label listing throws (such a
 * repository counts as running the pipeline).
 */
function fakeOrg(repos) {
  const calls = [];
  const labelsOf = (repo) => {
    if (repos[repo] instanceof Error) throw repos[repo];
    return repos[repo].labels;
  };
  return {
    calls,
    async listRepositories(org, options) {
      calls.push(['repos', org, options]);
      return Object.keys(repos).map((name) => ({ name, archived: false }));
    },
    async listDirectory(owner, repo, path) {
      assert.equal(path, WORKFLOWS_DIR);
      return repos[repo] instanceof Error ? ['drafter.lock.yml'] : repos[repo].workflows;
    },
    async listLabels(owner, repo) { return labelsOf(repo); },
    async createLabel(owner, repo, label) { calls.push(['create', repo, label.name]); },
    async updateLabel(owner, repo, name, label) { calls.push(['update', repo, name, label.name]); },
  };
}

test('syncOrganization only touches pipeline repositories', async () => {
  const repos = {
    fresh: { workflows: ['review.lock.yml'], labels: [] },
    synced: { workflows: ['drafter.lock.yml', 'drafter.md'], labels: IN_SYNC },
    drifted: { workflows: ['fix.lock.yml'], labels: DRIFTED },
    unrelated: { workflows: ['ci.yml'], labels: [] },
    broken: Object.assign(new Error('boom'), { stderr: 'HTTP 502' }),
  };
  for (const [name, dryRun, installation, writes] of [
    ['dry run writes nothing', true, false, []],
    ['apply writes to pipeline repositories only', false, true, [
      // Repositories are processed in sorted order.
      ['create', 'drifted', 'agent/new'],
      ['update', 'drifted', 'agent/code', 'agent/code'],
      ['update', 'drifted', 'agent/lgtm', 'agent/lgtm'],
      ['update', 'drifted', 'Agent/Fixme', 'agent/fixme'],
      ...DESIRED.map((label) => ['create', 'fresh', label.name]),
    ]],
  ]) {
    const client = fakeOrg(repos);
    const log = [];
    const result = await syncOrganization(client, 'org', { dryRun, installation, labels: DESIRED, log: (line) => log.push(line) });
    assert.deepEqual(client.calls, [['repos', 'org', { installation }], ...writes], name);
    assert.deepEqual(result, { pipeline: ['broken', 'drifted', 'fresh', 'synced'], skipped: ['unrelated'], changed: 2, failed: ['broken'] }, name);
    assert.ok(log.includes('org/broken: FAILED: HTTP 502'), `${name}: failure is logged`);
    assert.ok(log.includes('org/synced: up to date'), `${name}: in-sync repository is logged`);
  }
});

test('parses CLI arguments', () => {
  const defaults = { dryRun: false, installation: false };
  for (const [argv, expected] of [
    [['--org', 'bootc-dev'], { ...defaults, org: 'bootc-dev' }],
    [['--dry-run', '--org', 'bootc-dev'], { ...defaults, dryRun: true, org: 'bootc-dev' }],
    [['--org', 'bootc-dev', '--installation'], { ...defaults, installation: true, org: 'bootc-dev' }],
    [['--help'], { ...defaults, help: true }],
  ]) {
    assert.deepEqual(parseArgs(argv), expected, JSON.stringify(argv));
  }
  for (const argv of [[], ['--org'], ['--org', '--dry-run'], ['--org', 'x', 'extra'], ['--bogus']]) {
    assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv));
  }
});
