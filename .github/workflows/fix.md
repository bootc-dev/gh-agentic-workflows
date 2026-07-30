---
description: |
  Fix-iteration agent. When review.md flags an agent-authored pull request
  with the 'ai/fixme' label, this agent reads the reviewer's feedback and
  pushes follow-up commits to the same branch, closing the
  code -> review -> fix loop.

on:
  pull_request:
    types: [labeled]
  bots: ["cgwaltersbot[bot]"]

if: |
  github.event.label.name == 'ai/fixme' &&
  startsWith(github.event.pull_request.head.ref, 'agent/')

permissions:
  contents: read
  issues: read
  pull-requests: read

engine:
  id: claude
  model: claude-sonnet-4-5-20250929

tools:
  bash: ["*"]
  github:
    toolsets: [default]

safe-outputs:
  github-app:
    client-id: ${{ vars.GH_AW_APP_CLIENT_ID }}
    private-key: ${{ secrets.GH_AW_APP_PRIVATE_KEY }}
  add-comment:
    max: 1
  remove-labels:
    max: 1
    allowed: ["ai/fixme"]
  push-to-pull-request-branch:
    max: 1
    # Mirrors drafter.md's override: if the PR itself carries
    # `agent/workflow-edits-allowed` (e.g. the drafter PR was opened under
    # the override, or a human added it afterwards), fix commits may also
    # touch protected files without the request_review gate. See "Letting
    # the agent edit protected files" in README.md.
    protected-files:
      # See drafter.md for why this uses case() instead of the more common
      # "cond && 'allowed' || 'request_review'" ternary idiom: gh-aw's
      # compiler HTML-escapes && to \u0026\u0026 when JSON-encoding this
      # value, which breaks GitHub Actions' expression parser.
      policy: ${{ case(contains(github.event.pull_request.labels.*.name, 'agent/workflow-edits-allowed'), 'allowed', 'request_review') }}

timeout-minutes: 15
---

# PR Fix Agent

The `ai/fixme` label was applied to pull request
#${{ github.event.pull_request.number }} by the review agent (`review.md`),
meaning it found something that needs to change.

Note: this workflow uses a plain `pull_request: types: [labeled]` trigger
gated by `if:` rather than gh-aw's `label_command:` trigger, because
`label_command:` combined with a custom top-level `if:` (needed here for
the `agent/` branch-prefix check) silently drops its own label-name match
condition, which would make this workflow fire on *any* label added to an
`agent/`-branch PR. So the label must be consumed manually: this workflow
removes `ai/fixme` itself via `remove-labels` (step 1 below) so it can't
cause a duplicate re-trigger.

## Your task

1. Remove the `ai/fixme` label from this PR via the `remove-labels`
   safe-output, so it's consumed and can't re-trigger this workflow.
2. **Enforce the iteration cap.** Run
   `gh pr view ${{ github.event.pull_request.number }} --json commits --jq '.commits | length'`
   to count the commits on this PR — the same technique `tests/e2e.sh`
   already uses (its `get_commit_count` helper) to detect fix commits,
   via the GitHub API rather than a raw `git fetch`. Use `gh`/the API for
   this, not `git fetch`: in the sandboxed agent job, a raw `git fetch`
   against this (private) repo is not guaranteed to have working
   credentials, whereas `gh`/`GH_TOKEN` is always set up for you.
   If the count is already 3 or more, the cap has been reached:
   - Do not make any code changes and do not emit a
     `push-to-pull-request-branch` safe-output.
   - Emit an `add-comment` safe-output on this PR whose body says: the
     automated fix loop has reached its iteration limit (3) and automated
     fixing has stopped; a human needs to review the PR and either push a
     fix commit and apply `ai/lgtm` directly once satisfied, or close the
     PR. Explicitly note that re-applying `ai/fixme` will **not** give the
     loop another attempt: this cap is simply the total commit count on
     the branch, which only grows, so relabeling will immediately hit the
     same cap again without attempting a fix (the only way to actually
     continue the automated loop is to reduce the branch's commit count,
     e.g. by squashing, below 3 first).
   - Stop here. Do not proceed to the remaining steps.

   This caps the loop at 2 fix iterations, on the assumption that
   `drafter.md` pushes exactly one initial commit before this workflow
   ever runs. If a drafter ever pushes more than one initial commit, the
   cap will trip slightly earlier than 2 true fix iterations — an accepted
   trade-off for not depending on `git fetch` credentials that may not be
   present in the sandbox.
3. Otherwise (cap not reached), determine the PR's branch name by running
   `gh pr view ${{ github.event.pull_request.number }} --json headRefName --jq .headRefName`.
4. Read the reviewer's feedback: run
   `gh pr view ${{ github.event.pull_request.number }} --json reviews` (or
   `gh api repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/reviews`)
   and use the body of the most recent review to see what needs fixing.
5. Check out the PR branch and make the smallest change that addresses the
   feedback.
6. Validate your change using whatever the repo actually provides (tests,
   a lint command, or a small ad hoc check) — do not assume tooling that
   may not exist.
7. Push your fix as a new commit on the same branch via the
   `push-to-pull-request-branch` safe-output. Do not open a new PR.

## Constraints

- Only ever modify the existing PR branch via `push-to-pull-request-branch`
  — never push directly to `main` and never open a new PR.
- Respect the iteration cap in step 2 without exception.
- Always remove `ai/fixme` (step 1), even if the iteration cap causes you
  to stop before making any code changes.
- When the iteration cap is reached, never emit `add-labels` for
  `ai/fixme` or `ai/lgtm` — an unlabeled PR with the cap-reached comment
  is the intended "stuck, needs a human" signal. Only emit the
  `add-comment` safe-output described in step 2.
