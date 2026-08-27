---
description: |
  Automated release agent. Runs weekly to create a release PR with
  LLM-generated release notes from git history since the last release.
  The PR requires human review and approval before the release is published.

on:
  schedule:
    # Weekly on Mondays at 9:00 UTC
    - cron: '0 9 * * 1'
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

model: claude-sonnet-4-5-20250929
engine:
  id: claude
tools:
  bash: ["*"]
  github:
    toolsets: [default]

safe-outputs:
  github-app:
    client-id: ${{ vars.GH_AW_APP_CLIENT_ID }}
    private-key: ${{ secrets.GH_AW_APP_PRIVATE_KEY }}
    permissions:
      workflows: write
  create-pull-request:
    max: 1
    branch-prefix: release/
  noop:
  missing-data:

timeout-minutes: 15
---

# Release Agent

This workflow runs weekly to create a release PR.

## Your task

1. **Determine the next version**: Read the git tags to find the latest release.
   If no tags exist, use `v0.1.0` as the starting version. Otherwise, increment
   the patch version (e.g., `v1.2.3` → `v1.2.4`).

2. **Gather release content**: Collect git commits since the last release using
   `git log`. Focus on meaningful changes:
   - New features
   - Bug fixes
   - Breaking changes
   - Dependency updates
   - Documentation improvements

3. **Generate release notes**: Create structured release notes that:
   - Start with a brief summary of what's new
   - Group changes by category (Features, Bug Fixes, Documentation, etc.)
   - Include commit references where helpful
   - Highlight any breaking changes or migration notes
   - Be concise but informative

4. **Create the release PR**: Use the `create-pull-request` safe-output to
   create a PR with:
   - **Title**: `Release <version>` (e.g., "Release v1.2.4")
   - **Branch**: `release/<version>` (e.g., "release/v1.2.4")
   - **Body**: The generated release notes in markdown format
   - **Labels**: `release`

   The PR body should be structured like:
   ```markdown
   # Release <version>

   ## Summary
   [Brief overview of changes]

   ## Changes

   ### Features
   - [Feature descriptions]

   ### Bug Fixes
   - [Bug fix descriptions]

   ### Documentation
   - [Documentation changes]

   ## Commits
   [List of commit references]

   ---
   Generated-by: AI
   Human review required before merge.
   ```

5. **Handle edge cases**:
   - If there are no changes since the last release, use `noop` to report
     that no release is needed
   - If you cannot determine the version or history, use `missing-data`
   - Only create one release PR per run

## Constraints

- Never push directly to the default branch
- Only create release PRs, not actual releases or tags
- Always include "Generated-by: AI" in the PR body
- Require human review for all releases
