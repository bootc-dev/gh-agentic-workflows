---
description: |
  Fix-iteration agent. When review.md flags an agent-authored pull request
  with the 'ai/fixme' label, this agent reads the reviewer's feedback and
  pushes follow-up commits to the same branch, closing the
  code -> review -> fix loop.

on:
  pull_request:
    types: [labeled]

if: |
  github.event.label.name == 'ai/fixme' &&
  startsWith(github.event.pull_request.head.ref, 'agent/')

permissions:
  contents: read
  issues: read
  pull-requests: read

engine: claude

tools:
  bash: ["*"]
  github:
    toolsets: [default]

safe-outputs:
  remove-labels:
    max: 1
    allowed: ["ai/fixme"]
    github-token: ${{ secrets.GH_AW_CI_TRIGGER_TOKEN }}
  push-to-pull-request-branch:
    max: 1
    github-token: ${{ secrets.GH_AW_CI_TRIGGER_TOKEN }}

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
2. Determine the PR's branch name by running
   `gh pr view ${{ github.event.pull_request.number }} --json headRefName --jq .headRefName`.
3. **Enforce the iteration cap.** Run
   `git fetch origin && git rev-list --count origin/main..origin/<branch>`
   (substituting the branch name from step 2) to count commits already on
   this branch relative to `main`. If the count is already 3 or more, stop
   immediately: do not make any further changes and do not emit a
   `push-to-pull-request-branch` safe-output. This caps the loop at 2 fix
   iterations.
4. Otherwise, read the reviewer's feedback: run
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
- Respect the iteration cap in step 3 without exception.
- Always remove `ai/fixme` (step 1), even if the iteration cap causes you
  to stop before making any code changes.
