---
name: onboard-repo
description: Roll out this repo's drafter/review/fix/merge agentic pipeline to a new consumer repo via `gh aw add`. Use when asked to onboard, pilot, or roll out gh-agentic-workflows (or "the agent pipeline") to a specific repo, e.g. "roll out gh-agentic-workflows to bcvk".
---

# Onboarding a repo onto gh-agentic-workflows

This is the operational runbook for piloting this package's drafter -> review
-> fix -> merge pipeline on a new consumer repo. It assumes you have a local
checkout of `gh-agentic-workflows` (for its README/aw.yml/scripts) and can
clone the target repo separately.

Read `README.md`'s "Repository setup checklist" and "Roadmap" sections first
— they're the source of truth for *what* each step requires and *why*. This
skill is the *sequence* to follow and the adaptations that tend to be needed
in practice; don't duplicate their content here, link back to them.

## 0. Don't skip the survey

Before touching any files, inspect the target repo and record what you find
— it drives every decision below:

```bash
gh repo view OWNER/REPO --json primaryLanguage,defaultBranchRef,pushedAt,isArchived
gh label list --repo OWNER/REPO --json name
gh api repos/OWNER/REPO/contents/.github/workflows --jq '.[].name'
gh api repos/OWNER/REPO/rules/branches/<default-branch>   # branch protection + merge queue
```

Specifically check:
- **Language/build tooling** — determines the `network:` block (step 4).
- **Existing `agent/*` labels** — if present, this repo may already be
  partway onboarded; don't blindly re-run `install-labels`.
- **A `merge_queue` rule type** in the branch-protection output — changes
  how `merge.yml` behaves (it enqueues instead of merging directly) and
  means "Allow auto-merge" must be enabled in repo settings.
- **`required_approving_review_count` on a `pull_request` rule** — if this
  is nonzero, don't treat it as a blocker: `review.md` deliberately never
  submits `APPROVE` (GitHub downgrades self-review from the same bot
  identity to `COMMENT` anyway), so a human providing the real approval is
  already the expected gate before `merge.yml` can merge. This is
  by-design, not a gap to fix.

## 1. Make sure there's a real version to pin to

Consumers must pin `gh aw add OWNER/gh-agentic-workflows@vX.Y.Z` to an exact
tag (see README Roadmap, "Keep cutting v0.x.0 releases") — never `@main`.
Check `git tag -l` and `gh release list --repo bootc-dev/gh-agentic-workflows`.
If the latest tag is stale relative to `main` (check `git log vX.Y.Z..main
--oneline`), cut a new one first: draft an annotated tag message summarizing
the commits since the last tag, and hand off the `git tag -a` / `git push
origin vX.Y.Z` / `gh release create` commands (see "push access" note below
— you likely can't push this yourself).

You can start the install work immediately against the target commit's SHA
without waiting (`gh aw add` accepts tag, branch, or SHA) — just remember to
swap the pin string to the real tag name before the PR is reviewed/merged.

## 2. Confirm the gh-aw CLI version matches

```bash
cat .github/aw/gh-aw-version   # in gh-agentic-workflows
gh aw version                  # in your environment
```
If they differ, `gh extension remove gh-aw && gh extension install github/gh-aw --pin <version>` before compiling anything, or lock files will drift.

## 3. Install the package into the target repo

```bash
git -C /path/to/target checkout -b agent-pipeline-rollout
gh aw add OWNER/gh-agentic-workflows@vX.Y.Z --dir .github/workflows
```

This adds `drafter.md`/`review.md`/`fix.md` (recompiled fresh against the
target repo) plus `merge.yml`/`install-labels.yml`/`upgrade.yml` (copied
verbatim, per `aw.yml`'s `includes:`). Commit this raw output as its own
commit before making any adaptations — it makes the diff of your
adaptations reviewable on its own.

## 4. Adapt for the target repo's ecosystem

If the target's own build/test validation needs network access beyond
gh-aw's default egress firewall (basically anything except npm), add a
`network:` block to **both** `drafter.md` and `fix.md`'s frontmatter (not
`review.md` — it doesn't build/run anything):

```yaml
network:
  allowed:
    - defaults
    - rust   # or: go, python, ... — see gh-aw's network docs for identifiers
```

Then recompile to fold this into the lock files, and check the diff is
exactly your `network:` addition plus its corresponding lock-file change —
nothing else:

```bash
gh aw compile drafter fix review --approve
git diff --stat
```

## 5. Start with auto-merge disabled

Per the Roadmap's rollout ladder, keep `merge.yml` from actually merging
anything for the first pilot window. Don't rename or remove the file (that
breaks `gh aw upgrade`'s ability to track/update it later) — instead
short-circuit the job condition with an obvious, one-line-revert guard:

```yaml
    if: |
      false &&
      github.event.label.name == 'agent/lgtm' &&
      ...
    # Pilot rollout: delete the `false &&` line above once reviewer/fixer
    # judgment quality has been watched for a couple of weeks.
```

Commit this (and the `network:` block) as a second commit, separate from
the raw `gh aw add` output.

## 6. Write the PR checklist

The PR body needs to carry the human follow-up steps, since none of this
can be verified or completed from a sandboxed agent session (see below):

- Cut/confirm the version tag this PR pins to actually exists.
- For a bootc-dev consumer, verify the shared App is installed on the target repository
  and the required organization settings are available; do not create repository-level
  duplicates. `GH_AW_APP_CLIENT_ID` and `GH_AW_APP_BOT_SLUG` are organization variables;
  `GH_AW_APP_PRIVATE_KEY` and `ANTHROPIC_API_KEY` are organization secrets. Their
  currently observed visibility is **All repositories**. If any are restricted to
  selected repositories, obtain an organization-owner grant for the target repository.
- If the target has a merge-queue ruleset, confirm "Allow auto-merge" is
  enabled in repo settings.
- After merging: run the `install-labels.yml` workflow once (it also
  self-heals weekly afterward).
- Try one real, low-stakes issue end-to-end with `agent/code`.
- After the pilot window, remove the `false &&` guard in `merge.yml`.

## 7. Expect zero push access

Sandboxed agent environments frequently have read/API access but cannot
`git push` to org repos even when `gh api repos/OWNER/REPO --jq
.permissions` claims write access — this is a deliberate sandbox
restriction, not a real permissions problem. Verify with a harmless
dry run before assuming you can push:

```bash
git push origin <branch> --dry-run
```

If it 403s, prepare everything locally (branches, commits, PR body as a
file) and hand off the exact `git push` / `gh pr create` commands instead
of attempting to run them yourself.

## 8. Get an independent review before handing off

Dispatch a review subagent against the prepared commits (diff scope, commit
message quality, YAML/shellcheck sanity, `gh aw compile` drift check) before
presenting the branch as ready — same bar as any other change to this
pipeline (see `AGENTS.md`/`REVIEW.md`).
