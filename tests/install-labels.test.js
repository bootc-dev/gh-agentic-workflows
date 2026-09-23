'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { LABELS, describePlan, installLabels, planLabelChanges } = require('../scripts/install-labels.js');

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
