#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sharedWorkflowPath = path.join(__dirname, '..', '.github', 'workflows', 'shared', 'workflow-rerun.md');
const sharedWorkflow = fs.readFileSync(sharedWorkflowPath, 'utf8');
const rerunWorkflow = require('../.github/workflows/shared/workflow-rerun.cjs');
for (const workflow of ['ci-triage', 'queue-triage']) {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', `${workflow}.md`), 'utf8');
  assert.match(source, /^\s+workflow_run:/m, `${workflow} must trigger on workflow_run`);
  assert.doesNotMatch(source, /workflow_dispatch/, `${workflow} must not support workflow_dispatch`);
  assert.match(source, /^resources:\n  - shared\/workflow-rerun\.cjs$/m, `${workflow} must install rerun handler`);

  const lock = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', `${workflow}.lock.yml`),
    'utf8',
  );
  const triggers = lock.match(/^on:\n([\s\S]*?)\npermissions:/m);
  assert(triggers, `${workflow} compiled trigger block not found`);
  assert.match(triggers[1], /^\s+workflow_run:/m, `${workflow} compiled workflow must trigger on workflow_run`);
  assert.doesNotMatch(
    triggers[1],
    /workflow_dispatch/,
    `${workflow} compiled workflow must not trigger on workflow_dispatch`,
  );
}
assert.match(sharedWorkflow, /permission-actions: write/, 'App token must allow workflow reruns');
assert.doesNotMatch(sharedWorkflow, /workflow_dispatch/, 'rerun handler must not support workflow_dispatch');
assert.match(
  sharedWorkflow,
  /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  'rerun handler must be checked out from the default branch',
);
assert.match(sharedWorkflow, /token: \$\{\{ github\.token \}\}/, 'checkout must use the job GITHUB_TOKEN');
assert.match(sharedWorkflow, /persist-credentials: false/, 'checkout must not persist credentials');
assert.match(sharedWorkflow, /github-token: \$\{\{ steps\.app-token\.outputs\.token \}\}/, 'rerun API must use the App token');
assert.match(sharedWorkflow, /require\([\s\S]*workflow-rerun\.cjs/, 'safe-output wrapper must load trusted rerun handler');

const repository = { full_name: 'octo/example' };
const validRun = {
  id: 123,
  repository,
  event: 'pull_request',
  name: 'CI',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 1,
};
const request = { type: 'workflow_rerun', scope: 'failed', reason: 'DNS failure' };

async function execute({
  items = [request], rawOutput, run = validRun, eventName = 'workflow_run', workflowRun, triggerRunId = 123, triggerAttempt = 1,
  getRunError, endpointError, staged = false,
}) {
  const outputPath = path.join(os.tmpdir(), `workflow-rerun-${process.pid}-${Math.random()}.json`);
  fs.writeFileSync(outputPath, rawOutput ?? JSON.stringify({ items }));
  const failed = [];
  const calls = [];
  const oldOutput = process.env.GH_AW_AGENT_OUTPUT;
  const oldStaged = process.env.GH_AW_SAFE_OUTPUTS_STAGED;
  process.env.GH_AW_AGENT_OUTPUT = outputPath;
  if (staged) process.env.GH_AW_SAFE_OUTPUTS_STAGED = 'true';
  else delete process.env.GH_AW_SAFE_OUTPUTS_STAGED;
  const core = {
    setFailed: (message) => failed.push(message),
    info: () => {},
    summary: { addHeading: () => core.summary, addRaw: () => core.summary, write: async () => {} },
  };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => {
          if (getRunError) throw getRunError;
          return { data: run };
        },
        reRunWorkflowFailedJobs: async (value) => {
          if (endpointError) throw endpointError;
          calls.push({ endpoint: 'failed', request: value });
        },
        reRunWorkflow: async (value) => {
          if (endpointError) throw endpointError;
          calls.push({ endpoint: 'all', request: value });
        },
      },
    },
  };
  const payload = { repository };
  if (eventName === 'workflow_run') {
    payload.workflow_run = workflowRun ?? { id: triggerRunId, run_attempt: triggerAttempt };
  }
  const context = {
    workflow: 'An Arbitrary Triage Name',
    eventName,
    repo: { owner: 'octo', repo: 'example' },
    payload,
  };

  try {
    await rerunWorkflow({
      core,
      context,
      expectedEvent: 'pull_request',
      github,
      monitoredWorkflow: 'CI',
      monitoredWorkflowPath: '.github/workflows/ci.yml',
      process,
    });
  } finally {
    fs.unlinkSync(outputPath);
    if (oldOutput === undefined) delete process.env.GH_AW_AGENT_OUTPUT;
    else process.env.GH_AW_AGENT_OUTPUT = oldOutput;
    if (oldStaged === undefined) delete process.env.GH_AW_SAFE_OUTPUTS_STAGED;
    else process.env.GH_AW_SAFE_OUTPUTS_STAGED = oldStaged;
  }
  return { failed, calls };
}

async function main() {
  const failures = [
    [{ rawOutput: '{not JSON' }, /Unable to parse safe output/],
    [{ items: null }, /items array/],
    [{ items: [request, request] }, /exactly one/],
    [{ items: [{ ...request, scope: 'other' }] }, /invalid scope or reason/],
    [{ items: [{ ...request, reason: ' ' }] }, /invalid scope or reason/],
    [{ run: { ...validRun, event: 'merge_group' } }, /configured failed CI workflow/],
    [{ run: { ...validRun, name: 'other' } }, /configured failed CI workflow/],
    [{ run: { ...validRun, path: '.github/workflows/other.yml' } }, /configured failed CI workflow/],
    [{ run: { ...validRun, repository: { full_name: 'octo/other' } } }, /configured failed CI workflow/],
    [{ run: { ...validRun, run_attempt: 2 } }, /stale workflow_run event/],
    [{ run: { ...validRun, run_attempt: 'bad' }, triggerAttempt: 'bad' }, /attempt cap/],
    [{ workflowRun: {} }, /numeric workflow run ID/],
    [{ triggerRunId: null }, /numeric workflow run ID/],
    [{ triggerRunId: 0 }, /numeric workflow run ID/],
    [{ triggerRunId: 'not-a-run-id' }, /numeric workflow run ID/],
    [{ eventName: 'workflow_dispatch' }, /unsupported event/],
    [{ eventName: 'push' }, /unsupported event/],
    [{ getRunError: new Error('not found') }, /Unable to fetch/],
    [{ endpointError: new Error('forbidden') }, /Unable to rerun/],
    [{ run: { ...validRun, run_attempt: 3 }, triggerAttempt: 3 }, /attempt cap/],
  ];
  for (const [options, expected] of failures) {
    const result = await execute(options);
    assert.match(result.failed[0], expected);
    assert.equal(result.calls.length, 0);
  }

  let result = await execute({ staged: true });
  assert.deepEqual(result, { failed: [], calls: [] });

  for (const scope of ['failed', 'all']) {
    result = await execute({ items: [{ ...request, scope }] });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.calls, [{ endpoint: scope, request: { owner: 'octo', repo: 'example', run_id: 123 } }]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
