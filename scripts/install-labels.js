#!/usr/bin/env node
'use strict';

/**
 * Install gh-agentic-workflows labels
 *
 * Defines the labels required by the gh-agentic-workflows
 * issue → PR → review → fix → merge pipeline, and a helper to create or
 * update them via the GitHub REST API.
 *
 * `.github/workflows/install-labels.yml` embeds this same LABELS array and a
 * simpler create-or-update loop directly in its actions/github-script step,
 * because `gh aw add` copies that workflow into consumer repositories without
 * this file. This module exists so the same logic can be reused from your own
 * scripts or workflows - see scripts/README.md for other installation methods
 * (the Actions workflow, `gh label create`, `gh api`).
 *
 * Keep LABELS here in sync with the copy in
 * .github/workflows/install-labels.yml; tests/install-labels.test.js fails
 * if they differ.
 *
 * Run as a script, this installs LABELS on every repository of an
 * organization that runs the pipeline (see `--help`), which
 * `.github/workflows/install-labels-org.yml` does on every push to main. Labels every
 * bootc-dev repository should have regardless of the pipeline belong in
 * bootc-dev/infra's labels.toml instead.
 */

const childProcess = require('child_process');

const LABELS = [
  {
    name: 'agent/code',
    description: 'Triggers the drafter agent',
    color: '0E8A16', // green
  },
  {
    name: 'agent/fixme',
    description: 'Reviewer agent found issues that need fixing',
    color: 'D93F0B', // red
  },
  {
    name: 'agent/lgtm',
    description: 'Reviewer agent approved; ready to auto-merge',
    color: '0E8A16', // green
  },
  {
    name: 'agent/drafter-working',
    description: 'The drafter agent is actively working on this issue',
    color: 'FBCA04', // yellow
  },
  {
    name: 'agent/review-working',
    description: 'The review agent is actively working on this PR',
    color: 'FBCA04', // yellow
  },
  {
    name: 'agent/fix-working',
    description: 'The fix agent is actively working on this PR',
    color: 'FBCA04', // yellow
  },
  {
    name: 'agent/workflow-edits-allowed',
    description: 'Pre-authorizes agent runs to edit protected files without the request_review gate',
    color: '5319E7', // purple
  },
  {
    name: 'agent/flake-tracker',
    description: 'Marks the CI flake tracker issue the merge queue analyzer maintains',
    color: '1D76DB', // blue
  },
];

/**
 * Compute what is needed to make a repository's labels match `desired`.
 *
 * `existing` is the repository's current label list as returned by the REST
 * API (`{ name, color, description }`, color without `#`). GitHub treats label
 * names case-insensitively and returns colors lowercase, so both are compared
 * that way; a label whose name differs only in case is renamed as part of its
 * update. Labels not in `desired` are never touched.
 *
 * Returns `{ create: [label], update: [{ name, label, changes }] }` where
 * `name` is the existing label's current name (needed to address it) and
 * `changes` lists the differing fields, for logging.
 */
function planLabelChanges(desired, existing) {
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  const create = [];
  const update = [];
  for (const label of desired) {
    const current = byName.get(label.name.toLowerCase());
    if (!current) {
      create.push(label);
      continue;
    }
    const changes = [];
    if (current.name !== label.name) changes.push('name');
    if (current.color.toLowerCase() !== label.color.toLowerCase()) changes.push('color');
    if ((current.description || '') !== label.description) changes.push('description');
    if (changes.length > 0) update.push({ name: current.name, label, changes });
  }
  return { create, update };
}

/** One human-readable line per planned change; empty when nothing changes. */
function describePlan(plan) {
  return [
    ...plan.create.map((label) => `  create ${label.name} (#${label.color}: ${label.description})`),
    ...plan.update.map(({ name, label, changes }) => `  update ${name}: ${changes.join(', ')}${name !== label.name ? ` -> ${label.name}` : ''}`),
  ];
}

/**
 * Bring one repository's labels in line with `labels` and return the plan.
 *
 * `api` is the transport, `{ listLabels(owner, repo), createLabel(owner,
 * repo, label), updateLabel(owner, repo, currentName, label) }`, each
 * returning a promise; see octokitLabelApi(). With `dryRun` only
 * listLabels is called.
 */
async function syncRepositoryLabels(api, owner, repo, { labels = LABELS, dryRun = false } = {}) {
  const plan = planLabelChanges(labels, await api.listLabels(owner, repo));
  if (dryRun) return plan;
  for (const label of plan.create) await api.createLabel(owner, repo, label);
  for (const { name, label } of plan.update) await api.updateLabel(owner, repo, name, label);
  return plan;
}

/** Adapt an Octokit client to the `api` syncRepositoryLabels() expects. */
function octokitLabelApi(github) {
  return {
    listLabels: (owner, repo) => github.paginate(github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 }),
    createLabel: (owner, repo, { name, color, description }) => github.rest.issues.createLabel({ owner, repo, name, color, description }),
    updateLabel: (owner, repo, name, label) => github.rest.issues.updateLabel({
      owner, repo, name, new_name: label.name, color: label.color, description: label.description,
    }),
  };
}

/**
 * Create or update all LABELS on a repository.
 *
 * `github` must be an Octokit client with `paginate` and `rest.issues` (e.g.
 * the `github` object actions/github-script injects, or the result of
 * `@actions/github`'s `getOctokit()`). `context` must expose
 * `repo: { owner, repo }`. Only labels that are missing or differ are
 * written.
 */
async function installLabels(github, context) {
  const { owner, repo } = context.repo;
  console.log(`Installing labels on ${owner}/${repo}...`);
  const plan = await syncRepositoryLabels(octokitLabelApi(github), owner, repo);
  const lines = describePlan(plan);
  for (const line of lines) console.log(line);
  console.log(lines.length === 0 ? 'All labels already up to date.' : 'All labels installed successfully.');
}

/** Where `gh aw add` installs the pipeline's compiled workflows. */
const WORKFLOWS_DIR = '.github/workflows';

/**
 * Compiled pipeline workflows in WORKFLOWS_DIR. A repository with any of them
 * has adopted (at least part of) the pipeline, and only those repositories get
 * LABELS from the org-wide installer.
 */
const PIPELINE_MARKERS = ['drafter.lock.yml', 'review.lock.yml', 'fix.lock.yml'];

/** Whether the file names found in WORKFLOWS_DIR include a PIPELINE_MARKERS entry. */
function isPipelineRepository(workflowFiles) {
  return workflowFiles.some((name) => PIPELINE_MARKERS.includes(name));
}

/**
 * Select the repositories worth checking for PIPELINE_MARKERS: every
 * non-archived one, skipping dot-named repositories such as `.github` the
 * same way bootc-dev/actions' discover-repos does. Returned sorted for stable
 * output.
 */
function candidateRepositories(repos) {
  return repos
    .filter((repo) => !repo.archived && !repo.name.startsWith('.'))
    .map((repo) => repo.name)
    .sort();
}

function ghApi(args) {
  const stdout = childProcess.execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return stdout.trim() === '' ? null : JSON.parse(stdout);
}

/** All pages of a paginated endpoint, each page passed through `items`. */
function ghPaged(endpoint, items = (page) => page) {
  return ghApi(['--paginate', '--slurp', endpoint]).flatMap(items);
}

function isNotFound(error) {
  return /HTTP 404/.test(String(error.stderr || ''));
}

/**
 * The organization-level client syncOrganization() uses, backed by the `gh`
 * CLI so it works with whatever token `gh` is authenticated with.
 */
const ghCliClient = {
  /**
   * With `installation`, the repositories the App installation behind the
   * token can access (so repositories it isn't installed on are never
   * tried); otherwise every repository of `org` the token can see.
   */
  async listRepositories(org, { installation = false } = {}) {
    if (!installation) return ghPaged(`orgs/${org}/repos?type=all&per_page=100`);
    let repos;
    try {
      repos = ghPaged('installation/repositories?per_page=100', (page) => page.repositories);
    } catch (error) {
      throw new Error(`listing the App installation's repositories failed (--installation needs a GitHub App installation token): ${String(error.stderr || error.message).trim()}`);
    }
    return repos.filter((repo) => repo.owner.login.toLowerCase() === org.toLowerCase());
  },
  /** Names of the entries in directory `path`, or [] if it doesn't exist. */
  async listDirectory(owner, repo, path) {
    let entries;
    try {
      entries = ghApi([`repos/${owner}/${repo}/contents/${path}`]);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return Array.isArray(entries) ? entries.map((entry) => entry.name) : [];
  },
  async listLabels(owner, repo) {
    return ghPaged(`repos/${owner}/${repo}/labels?per_page=100`);
  },
  async createLabel(owner, repo, { name, color, description }) {
    ghApi(['-X', 'POST', `repos/${owner}/${repo}/labels`, '-f', `name=${name}`, '-f', `color=${color}`, '-f', `description=${description}`]);
  },
  async updateLabel(owner, repo, currentName, label) {
    ghApi(['-X', 'PATCH', `repos/${owner}/${repo}/labels/${encodeURIComponent(currentName)}`,
      '-f', `new_name=${label.name}`, '-f', `color=${label.color}`, '-f', `description=${label.description}`]);
  },
};

/**
 * Install `labels` on every repository of `org` whose WORKFLOWS_DIR contains
 * any of PIPELINE_MARKERS.
 *
 * `client` provides listRepositories() and listDirectory() plus the label methods
 * syncRepositoryLabels() needs; see ghCliClient. With `dryRun`, only reads
 * and logs the plan. A failure on one repository is logged and the rest still
 * proceed; the returned `failed` list lets the caller exit non-zero.
 */
async function syncOrganization(client, org, { dryRun = false, installation = false, labels = LABELS, log = console.log } = {}) {
  const candidates = candidateRepositories(await client.listRepositories(org, { installation }));
  log(`${dryRun ? 'Dry run: planning' : 'Installing'} ${labels.length} labels on ${org} repositories with any of ${PIPELINE_MARKERS.join(', ')} (${candidates.length} candidates${installation ? ' from the App installation' : ''})`);
  const pipeline = [];
  const skipped = [];
  const failed = [];
  let changed = 0;
  for (const repo of candidates) {
    try {
      if (!isPipelineRepository(await client.listDirectory(org, repo, WORKFLOWS_DIR))) {
        skipped.push(repo);
        continue;
      }
      pipeline.push(repo);
      const lines = describePlan(await syncRepositoryLabels(client, org, repo, { labels, dryRun }));
      if (lines.length === 0) {
        log(`${org}/${repo}: up to date`);
        continue;
      }
      changed++;
      log(`${org}/${repo}: ${dryRun ? 'would change' : 'changed'} ${lines.length} label(s)`);
      for (const line of lines) log(line);
    } catch (error) {
      failed.push(repo);
      log(`${org}/${repo}: FAILED: ${String(error.stderr || error.message).trim()}`);
    }
  }
  if (skipped.length > 0) log(`Skipped ${skipped.length} without the pipeline: ${skipped.join(', ')}`);
  log(`${pipeline.length} pipeline repositories, ${changed} ${dryRun ? 'would change' : 'changed'}, ${failed.length} failed`);
  return { pipeline, skipped, changed, failed };
}

function help() {
  return `Usage: node scripts/install-labels.js --org ORG [--installation] [--dry-run]

Create missing gh-agentic-workflows labels and fix the color, description and
name case of existing ones on every non-archived repository in ORG whose
${WORKFLOWS_DIR} contains any of ${PIPELINE_MARKERS.join(', ')}. Labels are
never deleted.

  --installation  Only consider repositories the GitHub App installation behind
                  the token can access (requires an installation token).
  --dry-run       Only read, and print what would change.

Requires an authenticated gh CLI; without --dry-run the token needs
issues: write on every pipeline repository.`;
}

function parseArgs(argv) {
  const args = { dryRun: false, installation: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') args.help = true;
    else if (argument === '--dry-run') args.dryRun = true;
    else if (argument === '--installation') args.installation = true;
    else if (argument === '--org') {
      args.org = argv[++index];
      if (!args.org || args.org.startsWith('-')) throw new Error(`--org requires a value\n\n${help()}`);
    } else throw new Error(`Unexpected argument ${argument}\n\n${help()}`);
  }
  if (!args.help && !args.org) throw new Error(`--org is required\n\n${help()}`);
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return console.log(help());
  const { failed } = await syncOrganization(ghCliClient, args.org, { dryRun: args.dryRun, installation: args.installation });
  if (failed.length > 0) throw new Error(`failed on: ${failed.join(', ')}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`install-labels: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  LABELS,
  PIPELINE_MARKERS,
  WORKFLOWS_DIR,
  candidateRepositories,
  describePlan,
  ghCliClient,
  installLabels,
  isPipelineRepository,
  octokitLabelApi,
  parseArgs,
  planLabelChanges,
  syncOrganization,
  syncRepositoryLabels,
};
