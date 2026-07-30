---
description: |
  Autonomous implementation agent. When an issue is labeled 'agent/code',
  this agent reads the issue, explores the repo, implements the change,
  validates it with the repo's own build tooling, and opens a pull
  request for human review via the create-pull-request safe-output.

on:
  issues:
    types: [labeled]

if: github.event.label.name == 'agent/code'

permissions:
  contents: read
  issues: read

engine:
  id: claude
  model: claude-sonnet-4-5-20250929

tools:
  bash: ["*"]
  github:
    toolsets: [issues]
    # Without this, content authored by our own bot (e.g. the fallback issue
    # it files when a push is rejected) defaults to `unapproved`/`none`
    # integrity on this public repo and gets filtered from the agent's view
    # before it can read it - see "Trusting the pipeline's own bot" in
    # README.md.
    min-integrity: approved
    trusted-users: ["cgwaltersbot[bot]"]

safe-outputs:
  github-app:
    client-id: ${{ vars.GH_AW_APP_CLIENT_ID }}
    private-key: ${{ secrets.GH_AW_APP_PRIVATE_KEY }}
    # Without this, the minted installation token only gets contents/issues/
    # pull-requests, and GitHub server-side rejects any push that touches
    # .github/workflows/* with "refusing to allow a GitHub App to create or
    # update workflow ... without `workflows` permission" - even though the
    # App installation itself has the Workflows permission granted.
    permissions:
      workflows: write
  create-pull-request:
    max: 1
    branch-prefix: agent/
    # Protected files (README.md, workflow definitions, etc.) normally fall
    # back to `request_review`: the PR is opened but flagged for mandatory
    # human review before merge. Applying `agent/workflow-edits-allowed` to
    # the originating issue *before* it's labeled `agent/code` pre-authorizes
    # this specific run to edit them without that gate. This must not become
    # the default — see "Letting the agent edit protected files" in README.md.
    protected-files:
      # case(), not "cond && 'allowed' || 'request_review'": gh-aw's compiler
      # JSON-encodes this string with Go's default HTML-escaping, which turns
      # a literal && into \u0026\u0026 and produces an expression GitHub
      # Actions can't parse (silently breaking the whole workflow file at
      # push time, no job even attempts to run). case() has no &, <, or >,
      # so it survives that encoding intact.
      policy: ${{ case(contains(github.event.issue.labels.*.name, 'agent/workflow-edits-allowed'), 'allowed', 'request_review') }}

timeout-minutes: 15
---

# Autonomous Developer Agent

Issue #${{ github.event.issue.number }} has been labeled for autonomous
implementation.

## Your task

1. Retrieve the content of issue #${{ github.event.issue.number }} to
   understand exactly what change is requested.
2. Explore the repository as needed (`ls`, `cat`, `grep`, etc.) to find the
   relevant files.
3. Make the smallest reasonable change that satisfies the issue.
4. Validate your change using whatever the repository actually provides:
   a command explicitly requested by the issue, or — if none is given —
   check for a `Justfile`, `Makefile`, test suite, or other repo-native way
   to check your work (e.g. running a relevant Python module directly). If
   the repo has no such tooling, validate by inspection and, where
   reasonable, a small ad hoc check (e.g. `python3 -c '...'`) instead of
   assuming a command that may not exist.
5. Once validation passes, open a pull request via the `create-pull-request`
   safe-output. The PR description should summarize the change and state
   how it was validated.

## Constraints

- Only ever propose changes via `create-pull-request` — never push directly
  to the default branch.
- Open at most one pull request.
- If the issue is not well-scoped enough to implement safely, or if the
  issue's premise doesn't match what's actually in the repository (e.g. it
  references content that doesn't exist), do not open a PR and do not
  fabricate content to match the issue; instead stop without emitting a
  `create-pull-request` safe-output (using `noop` or similar to explain why,
  if available).
