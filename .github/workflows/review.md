---
description: |
  Reviewer agent. Automatically reviews pull requests authored by the code
  agent and signals readiness via labels: 'ai/fixme' when changes are
  needed, 'ai/lgtm' when the PR is ready to merge.

on:
  pull_request:
    types: [opened, synchronize]

if: startsWith(github.event.pull_request.head.ref, 'agent/')

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
  submit-pull-request-review:
    max: 1
  add-labels:
    max: 1
    allowed: ["ai/fixme", "ai/lgtm"]
    github-token: ${{ secrets.GH_AW_CI_TRIGGER_TOKEN }}
  remove-labels:
    max: 2
    allowed: ["ai/fixme", "ai/lgtm"]
    github-token: ${{ secrets.GH_AW_CI_TRIGGER_TOKEN }}

timeout-minutes: 15
---

# PR Review Agent

The code agent has opened or updated pull request
#${{ github.event.pull_request.number }}.

## Your task

1. Look at the PR's diff and the full context of any files it touches.
2. Review it for correctness, quality, safety, and adherence to repository
   conventions.
3. Decide on exactly one of two outcomes:
   - **Needs more work**: remove the `ai/lgtm` label if present, submit a
     `submit-pull-request-review` with `event: COMMENT` and concrete,
     actionable feedback describing exactly what needs to change, then add
     the `ai/fixme` label.
   - **Looks good, ready to merge**: remove the `ai/fixme` label if
     present, submit a `submit-pull-request-review` with `event: COMMENT`
     noting what you checked and that it looks good, then add the
     `ai/lgtm` label.

   Always use `event: COMMENT` for the review itself — never
   `REQUEST_CHANGES` or `APPROVE`. GitHub silently downgrades both of those
   to `COMMENT` whenever the reviewing identity matches the PR author's
   identity (as it does here, since both this workflow and `drafter.md`
   act as the same bot account), so requesting either would be misleading
   about what actually happens. The labels below are what
   actually carry the fix/merge decision.

## Constraints

- Submit exactly one review via `submit-pull-request-review`, always with
  `event: COMMENT`.
- `ai/fixme` and `ai/lgtm` are mutually exclusive — the PR must have
  exactly one of them applied after you finish, never both and never
  neither. Always remove the other one first (removal of a label that
  isn't present is a harmless no-op).
- Be specific in your feedback when applying `ai/fixme` — it will be read
  by another agent (`fix.md`) that will attempt to address it
  automatically.
