---
# Retro — retrospective analysis of workflow runs across bootc-dev repos.
# Standalone in this host repository: deliberately excluded from aw.yml, so
# downstream gh aw add installations do not deploy or schedule it.
#
# Trigger:  schedule (every 6 hours) or workflow_dispatch
# Reads:    workflow runs from target repositories, existing issues
# Writes:   new issues with improvement suggestions (via create-issue safe-output)
# Next:     nothing automated - issue triage and implementation are left to humans
# Docs:     README.md, "Retrospective analyzer"
#
# YAML comments like this one are stripped at compile time and never reach
# the agent; the markdown body below is the prompt. See README.md,
# "Where to document a workflow".
description: |
  Retrospective analyzer. Runs in this repository on a schedule, analyzes
  workflow runs in active bootc-dev repositories, identifies patterns, and
  files improvement issues here where appropriate (avoiding duplicates).

on:
  schedule:
    # Every 6 hours at :17 past the hour — avoids the :00 stampede while
    # spreading load across the day. Runs at 00:17, 06:17, 12:17, 18:17 UTC.
    - cron: "17 */6 * * *"
  workflow_dispatch:
    inputs:
      target_repos:
        description: "Comma-separated list of repos to analyze (owner/repo format)"
        required: false
        type: string
      lookback_days:
        description: "Number of days of history to analyze"
        required: false
        type: string
        default: "7"

# A retrospective can take longer than its schedule interval. Keep one active
# run without canceling its useful analysis when the next schedule fires.
concurrency:
  group: "gh-aw-${{ github.workflow }}"
  cancel-in-progress: false

permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read

model: sonnet
engine:
  id: claude
network: defaults

tools:
  bash: ["*"]
  github:
    toolsets: [default, actions]
    min-integrity: approved
    trusted-users: ["${{ vars.GH_AW_APP_BOT_SLUG }}"]
  repo-memory:
    branch-name: memory/retro-checkpoints
    description: Per-repository workflow-run checkpoints for retro analysis
    allowed-extensions: [".json"]
    max-file-size: 102400
    max-file-count: 1
    format-json: true

safe-outputs:
  github-app:
    client-id: ${{ vars.GH_AW_APP_CLIENT_ID }}
    private-key: ${{ secrets.GH_AW_APP_PRIVATE_KEY }}
  create-issue:
    # Cap at a reasonable number per retro run — if the agent finds more than
    # this many distinct improvement opportunities in one pass, batch them or
    # prioritize the most impactful ones.
    max: 5
    labels: ["agent/retro"]
  noop:
  missing-data:

timeout-minutes: 20
---

# Retro: Workflow Retrospective Analyzer

You run from the host repository. Analyze accessible organization repositories,
but centralize duplicate searches and improvement issues in this host repository.

## Your task

1. Load `/tmp/gh-aw/repo-memory/default/checkpoints.json`.
   If absent, use `{}`. Its keys are `owner/repo`; each value records
   `last_successful_run_id` and `last_successful_run_created_at`.

2. Select targets. For a nonempty `target_repos` dispatch input, split on commas,
   trim and deduplicate entries; require `owner/repo`, require its owner to equal
   `${{ github.repository_owner }}`, and validate every entry with
   `gh api "repos/OWNER/REPO"` as active and non-fork. Otherwise discover with
   `gh api --paginate "orgs/${{ github.repository_owner }}/repos?type=all&per_page=100"`,
   retaining only visible, active, non-fork repositories and excluding
   `${{ github.repository }}`. A validation or discovery API failure means
   `missing-data` and no checkpoint update.

3. Validate `lookback_days` when supplied: an integer from 1 through 90. For a
   repository without a checkpoint, query the last seven days (or the validated
   dispatch lookback). For a checkpointed repository, start one hour before its
   saved timestamp; on dispatch, also include the requested lookback if it is
   earlier. Collect runs with
   `gh api --paginate "repos/OWNER/REPO/actions/runs?per_page=100&created=>=TIMESTAMP"`.
   Deduplicate by run ID before analysis and ignore the saved run ID or runs no
   newer than its checkpoint after accounting for the overlap.

4. Before filing anything, use `gh api --paginate` to list every open host issue
   (excluding pull requests); labels such as `agent/retro` may prioritize results
   but must not exclude unlabeled related issues. Search titles and bodies for each
   finding and do not duplicate an open issue. Analyze recurring failures, slow or
   flaky workflows, and actionable pipeline improvements. Issues need run URLs,
   evidence, and a concrete proposed change; create at most five.

5. If a repository's run query, analysis, and duplicate check completed usefully,
   update only that repository's checkpoint to the newest processed run ID and
   timestamp, then write it to `/tmp/gh-aw/repo-memory/default/checkpoints.json`.
   On any API failure, call
   `missing-data`, preserve that repository's prior checkpoint, and do not claim
   inaccessible repositories were analyzed. Call `noop` when useful processing
   found no new issue.

## Constraints

- Never create duplicate issues — always check existing open issues first
- Focus on actionable improvements with clear evidence, not vague hunches
- Each issue should stand alone and be immediately actionable by a human or
  another agent
- Respect the 5-issue-per-run cap — quality over quantity

## Context

This repository contains the gh-agentic-workflows pipeline itself (drafter →
review → fix → merge), plus ci-triage, queue-triage, and other workflows. Look
for patterns that would improve the pipeline's effectiveness, reduce noise, or
make the agents more helpful to contributors.
