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
 */

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

module.exports = { LABELS, describePlan, installLabels, octokitLabelApi, planLabelChanges, syncRepositoryLabels };
