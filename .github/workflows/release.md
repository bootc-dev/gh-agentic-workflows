---
description: |
  Automated release agent for this repository. Runs weekly to create a
  release PR with release notes from git history since the last release.
  The PR requires human review and approval before merge. When merged,
  a separate workflow creates the GitHub release with the tag.

on:
  schedule: weekly on monday
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
  create-pull-request:
    max: 1
    branch-prefix: release/
    allowed-files:
      - RELEASE-NOTES.md
  noop:
  missing-data:
---

# Release Agent

This workflow runs weekly to create a release PR.

## Your task

1. **Check for existing release PRs**: Before doing anything else, run
   `gh pr list --label release --state open --json number --jq length`
   to check if a release PR is already open. If the count is non-zero,
   use `noop` to report that a release PR is already open.

2. **Fetch full history**: The checkout is shallow by default. Run
   `git fetch --unshallow --tags` so that all tags and commit history
   are available.

3. **Determine the next version**: Run `scripts/next-version.sh` to get
   the next version string (e.g., `v0.3.0`).

4. **Generate release notes**: Use GitHub's release notes generation API
   as a starting point:
   ```bash
   gh api repos/$GITHUB_REPOSITORY/releases/generate-notes \
     -f tag_name="<next-version>" \
     -f previous_tag_name="<last-tag>" \
     --jq .body
   ```
   Then refine the output: group changes by category (Features, Bug Fixes,
   Documentation, Dependencies, Other), add a brief summary at the top,
   and highlight any breaking changes.

5. **Write RELEASE-NOTES.md**: Write the final release notes to
   `RELEASE-NOTES.md` at the repository root. This file is overwritten
   each release.

6. **Create the release PR**: Use the `create-pull-request` safe-output
   with:
   - **Title**: `Release <version>` (e.g., "Release v0.3.0")
   - **Branch**: `<version>` (e.g., "v0.3.0") — the `release/` prefix
     is added automatically by the branch-prefix setting
   - **Body**: The release notes from RELEASE-NOTES.md
   - **Labels**: `release`

7. **Handle edge cases**:
   - If there are no changes since the last release, use `noop`
   - If you cannot determine the version or history, use `missing-data`

## Constraints

- Never push directly to the default branch
- Only modify RELEASE-NOTES.md — do not touch other files
- Always include "Generated-by: AI" in the PR body
- Require human review for all releases
