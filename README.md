# gh-agentic-workflows

A minimal, standalone demonstration of a fully autonomous issue → draft PR → review →
fix → merge pipeline, built on [gh-aw](https://github.com/github/gh-aw) (GitHub Agentic
Workflows). gh-aw is flexible; this is one possible pipeline built on it.

## Reusing this pipeline in your own repo

Instead of forking this repo, install it as a gh-aw package:

```
gh aw add cgwalters/gh-agentic-workflows@v0.1.0
```

This pulls in `drafter.md`, `review.md`, and `fix.md` (compiled fresh against your repo)
and copies `merge.yml`/`install-labels.yml` verbatim. The installed `.md` files arrive
hardcoded to this repo's bot identity, so nothing will trigger until you work through the
"Repository setup checklist" below: point the `bots:`/`trusted-users:` fields at your own
GitHub App's bot slug, register that App with `GH_AW_APP_CLIENT_ID`/
`GH_AW_APP_PRIVATE_KEY`, and run `install-labels.yml`.

## How it works

Four stages, each a separate workflow:

```
issue labeled            pull_request              label: agent/fixme          label: agent/lgtm
  'agent/code'          opened/synchronize        (pull_request labeled)   (pull_request labeled)
       │                       │                          │                        │
       ▼                       ▼                          ▼                        ▼
  drafter.md   ──opens PR──▶ review.md   ──labels──▶   fix.md   ──pushes──▶  (back to review.md)
 (gh-aw agent)            (gh-aw agent)              (gh-aw agent)
                                │
                                └──labels 'agent/lgtm'──▶  merge.yml
                                                      (plain Actions workflow)
```

- **`drafter.md`** — triggers on the `agent/code` issue label. Implements the requested
  change, validates it, and opens a **draft** PR on an `agent/*` branch via gh-aw's
  `create-pull-request` safe-output.
- **`review.md`** — triggers on `pull_request: [opened, synchronize]` for `agent/*`
  branches. Posts a `COMMENT` review with concrete feedback and applies exactly one of
  `agent/fixme` (needs work) or `agent/lgtm` (ready to merge), removing the other.
- **`fix.md`** — triggers on `agent/fixme`. Removes the label (so it can't retrigger
  itself), reads the reviewer's feedback, and pushes a fix commit via
  `push-to-pull-request-branch`, which fires `review.md` again, closing the loop. A cap
  of 2 automated fix attempts stops the loop and asks a human to take over — see
  "Troubleshooting and operations" below.
- **`merge.yml`** — triggers on `agent/lgtm`. A deliberately plain, non-gh-aw Actions
  workflow (merging is mechanical once a reviewer has judged the PR, so no LLM is
  involved): marks the draft ready, squash-merges, deletes the branch.

## Design notes and gotchas

Non-obvious things that were hard-won getting this to actually work:

- **`safe-outputs.github-app` is safe at the root**, unlike a raw `github-token:`
  string. gh-aw mints the App token only inside the trusted safe-outputs job, after the
  untrusted agent job has finished, so declaring it once at the root reaches every
  handler without exposing it to the agent's sandbox. A plain `github-token:` has to be
  nested under each individual safe-output key instead, or it leaks into that sandbox.
- **`label_command:` plus a custom top-level `if:` drops the trigger's own label match**,
  so the workflow fires on *any* label change. `fix.md` works around this with a plain
  `pull_request: types: [labeled]` trigger and an explicit
  `if: github.event.label.name == 'agent/fixme'`.
- **Draft PRs need an explicit "ready" step** — `gh pr merge` refuses drafts, so
  `merge.yml` calls `gh pr ready` first.
- **Plain workflows don't get gh-aw's fork guard for free.** `merge.yml` adds its own
  check (`github.event.pull_request.head.repo.id == github.repository_id`) since GitHub
  hands secrets to fork-originated `pull_request` runs even on private repos.
- **A GitHub App bot actor always fails gh-aw's default role check**, since
  `pre_activation`'s collaborator-permission lookup always reports `none` for an App
  installation. `review.md`/`fix.md` can be triggered by the shared App bot itself, so
  both need `on.bots: ["cgwaltersbot[bot]"]` to bypass the check for that identity. The
  failure is easy to miss: `pre_activation` reports success (it correctly gated the run
  off) while everything downstream silently never runs — check job-level status, not
  run-level.
- **Pin the gh-aw compiler and the agent's model.** gh-aw auto-upgrades by default, and
  an upgrade once shipped a pricing table out of sync with Anthropic's model line,
  breaking agents with `<model> has no AI credits pricing`. Pin the extension
  (`gh extension install github/gh-aw --pin v0.81.6`, as `ci.yml` does) and set
  `engine.model` to an exact dated model ID rather than a floating alias.
- **Per-workflow `agent/*-working` labels are managed via frontmatter `jobs:`, not
  safe-outputs.** Each workflow adds/removes its own label
  (`agent/draft-working`/`agent/review-working`/`agent/fix-working`) via custom
  `add_working_label`/`remove_working_label` jobs gated on
  `needs.pre_activation.outputs.activated == 'true'`, so a run only clears the label it
  set. They're per-workflow, not shared, because a skipped run could otherwise strip
  *another* workflow's still-in-progress signal — and `if: always()` is used so cleanup
  still runs on failure/timeout, unlike safe-outputs handlers.

### Letting the agent edit protected files

`drafter.md`/`fix.md` default to gh-aw's `request_review` policy for protected files
(`README.md`, the workflow definitions, `.github/aw/actions-lock.json`): the PR still
opens, but with a mandatory `REQUEST_CHANGES` review blocking merge until a human looks —
see e.g. [#19](https://github.com/cgwalters/gh-agentic-workflows/issues/19).

To pre-authorize a specific run, apply the `agent/workflow-edits-allowed` label to the
*issue* (for `drafter.md`) or *PR* (for `fix.md`) before it runs — a human decision made
before the agent runs, so an agent can't grant itself the exemption mid-run. Both files'
`protected-files.policy` is a [GitHub Actions expression
string](https://github.github.io/gh-aw/reference/safe-outputs-pull-requests/#parameterizing-policy-fields-in-reusable-workflows):

```yaml
protected-files:
  policy: ${{ case(contains(github.event.issue.labels.*.name, 'agent/workflow-edits-allowed'), 'allowed', 'request_review') }}
```

Note the `case()` function rather than a `cond && 'x' || 'y'` ternary: gh-aw's compiler
HTML-escapes this string, turning `&&` into `\u0026\u0026`, which breaks GitHub Actions'
expression parser and fails compilation — see the fix for issue #21, [commit
0735a1c](https://github.com/cgwalters/gh-agentic-workflows/commit/0735a1c). `case()`
avoids `&`, `<`, and `>` entirely.

### The App token also needs an explicit `workflows` permission

GitHub rejects a GitHub App-authenticated push touching `.github/workflows/` unless the
*token* was minted with `workflows` permission, even if the App installation has it
enabled. gh-aw's `create-github-app-token` only requests
`contents`/`issues`/`pull-requests` by default, so a run that edits workflow files fails
at `git push` and falls back to filing an issue instead of opening a PR
([#21](https://github.com/cgwalters/gh-agentic-workflows/issues/21)). `drafter.md`/
`fix.md` request the extra scope via `safe-outputs.github-app.permissions`:

```yaml
github-app:
  client-id: ${{ vars.GH_AW_APP_CLIENT_ID }}
  private-key: ${{ secrets.GH_AW_APP_PRIVATE_KEY }}
  permissions:
    workflows: write
```

### Trusting the pipeline's own bot

gh-aw filters GitHub content by *integrity*: on a public repo, content not authored by an
`OWNER`/`MEMBER`/`COLLABORATOR` (or a first-party bot) is dropped before the agent sees it
([integrity filtering docs](https://github.github.io/gh-aw/reference/integrity/)). Pull
requests get a pass, but plain issues don't — including the fallback issues
`cgwaltersbot[bot]` files when a safe-output push is rejected (e.g.
[#26](https://github.com/cgwalters/gh-agentic-workflows/issues/26)). Without trust, the
agent would see such an issue's label but get a filtered, empty body, and correctly
no-op. All three workflows list the bot in `tools.github.trusted-users`:

```yaml
tools:
  github:
    min-integrity: approved
    trusted-users: ["cgwaltersbot[bot]"]
```

(Relabeling a fallback issue to retry a task is still *not* the intended recovery path —
see "Troubleshooting and operations" below.)

## Repository setup checklist

1. Create the required labels — `agent/code`, `agent/fixme`, `agent/lgtm`,
   `agent/draft-working`, `agent/review-working`, `agent/fix-working`,
   `agent/workflow-edits-allowed` — via the **Install Labels** Actions workflow, or
   manually:

   ```bash
   gh label create "agent/code" --color 0E8A16 --description "Triggers the autonomous drafter agent"
   gh label create "agent/fixme" --color D93F0B --description "Reviewer agent found issues that need fixing"
   gh label create "agent/lgtm" --color 0E8A16 --description "Reviewer agent approved; ready to auto-merge"
   gh label create "agent/draft-working" --color FBCA04 --description "The drafter agent is actively working on this issue"
   gh label create "agent/review-working" --color FBCA04 --description "The review agent is actively working on this PR"
   gh label create "agent/fix-working" --color FBCA04 --description "The fix agent is actively working on this PR"
   gh label create "agent/workflow-edits-allowed" --color 5319E7 --description "Pre-authorizes agent runs to edit protected files without the request_review gate"
   ```

   The three `agent/*-working` labels just need to exist; their color is cosmetic. See
   [`scripts/README.md`](scripts/README.md) for more installation options.
2. Register a GitHub App as the pipeline's bot identity — the default `GITHUB_TOKEN`
   won't retrigger workflows, so it must be a real App:
   - Settings → Developer settings → GitHub Apps → New GitHub App.
   - Grant Contents, Issues, and Pull requests (Read & Write), plus Workflows (Read &
     Write) — easy to miss, but needed since `drafter.md`/`fix.md` push commits touching
     `.github/workflows/*` (see "The App token also needs an explicit `workflows`
     permission" above).
   - Set the webhook to inactive (this App only mints API tokens) and installability to
     "Only on this account", then install it on this repo.
   - Capture the **Client ID** (not the numeric App ID) and a private key from the App's
     General settings page.
   - `gh variable set GH_AW_APP_CLIENT_ID --body "<client-id>"` and
     `gh secret set GH_AW_APP_PRIVATE_KEY < path/to/key.pem`.

   (This demo instance uses the `cgwaltersbot` App; register your own if adapting this
   repo.)
3. Add `bots: ["<your-app-slug>[bot]"]` to `review.md` and `fix.md`'s `on:` blocks (not
   `drafter.md`) — without it, both workflows' role check always rejects the shared App
   bot and silently no-ops forever.
4. Add the same `<your-app-slug>[bot]` to `tools.github.trusted-users` in all three
   `.md` files.
5. Run `gh aw compile drafter review fix --approve` after any workflow edit, with the
   gh-aw extension pinned (see "Design notes and gotchas" above).
6. If validation needs network access beyond gh-aw's defaults (e.g. `cargo test` reaching
   a crate registry), add a `network:` block to `drafter.md`'s and `fix.md`'s
   frontmatter — gh-aw's agent jobs run behind an egress firewall that doesn't allow most
   non-npm registries by default:

   ```yaml
   network:
     allowed:
       - defaults
       - rust  # or your ecosystem's identifier, or explicit domains
   ```

## Troubleshooting and operations

**Is a PR stuck?** `fix.md`'s iteration cap (2 automated fix attempts) is enforced by
counting commits on the PR. Past the cap, `fix.md` removes `agent/fixme` and posts a
comment, but applies no label. A PR with neither `agent/fixme` nor `agent/lgtm`, plus a
bot comment about the cap, is stuck waiting on a human.

**What not to do:** toggling the issue's `agent/code` label off and back on does *not*
resume the stuck PR — it opens a brand-new PR for the same issue, leaving the original
orphaned.

**How to rescue a stuck PR.** The commit-count cap only grows, so re-applying
`agent/fixme` just hits it again immediately. Instead:

- Push a fix commit yourself, then apply `agent/lgtm` directly — this bypasses
  `fix.md`/`review.md` entirely and goes straight to `merge.yml`.
- Or close the PR.

This is also the *only* way to get a fresh review of a manual commit: `review.md`/
`fix.md` refuse to activate unless the triggering actor matches the PR's original
author, even for a repo admin — deliberately, to stop a human push from inheriting the
bot's trusted-content treatment. `merge.yml` has no such check, which is exactly why
hand-applying `agent/lgtm` is the supported rescue path.

**Verifying end to end.** `tests/e2e.sh` files a fresh issue and polls the GitHub API,
reporting each stage as it happens:

```
./tests/e2e.sh --repo cgwalters/gh-agentic-workflows --scenario needs-fix
```

This burns real Anthropic API credits and a `needs-fix` round trip can take 20+ minutes;
it's a manual tool, not wired into any Actions trigger. See `./tests/e2e.sh --help` for
flags and the `clean` scenario (expected to reach `agent/lgtm` on the first review).

## Adapting to your project

Copy `.github/workflows/{drafter,review,fix}.md` (+ their compiled `.lock.yml`) and
`merge.yml`.

Safe to edit: the prompt bodies under each `---` frontmatter block (task description,
validation instructions, review criteria) — tailor these to your repo's conventions.

Leave alone unless you know what you're changing: the `on:`/`if:` triggers, the
`safe-outputs:` blocks and their token scoping, and the `agent/fixme`/`agent/lgtm`/
`agent/code` label names. If you rename a label, update it consistently across
`review.md`, `fix.md`, and `merge.yml`.

Recompile after editing any `.md` file:

```
gh aw compile drafter review fix --approve
```

## Files

The pipeline lives in
[`.github/workflows/drafter.md`](.github/workflows/drafter.md),
[`review.md`](.github/workflows/review.md), [`fix.md`](.github/workflows/fix.md), and
[`merge.yml`](.github/workflows/merge.yml) — see "How it works" above. The matching
`*.lock.yml` files are gh-aw's compiled output, checked in as generated artifacts.

## Prior art

A sibling demo to
[cgwalters/merge-queue-like-bors](https://github.com/cgwalters/merge-queue-like-bors):
solving a real GitHub Actions automation gap with a minimal, well-documented, standalone
workflow instead of a heavyweight external tool. It builds directly on
[gh-aw](https://github.com/github/gh-aw) for the agent execution model, sandboxing, and
safe-outputs. It also explores the same category of problem as
[fullsend](https://github.com/fullsend-ai/fullsend) — autonomous
triage/implement/review/merge pipelines — with a much smaller surface area: a few gh-aw
Markdown workflows and one plain Actions workflow, rather than a dedicated platform.

This is a demo/reference implementation, not a hardened product: no dashboard, no
multi-repo support, and an intentionally simple iteration cap and validation model.

## Side note on AI

This repository was built and tested with [OpenCode](https://opencode.ai)-coordinated
agents — one drafting the workflows, another reviewing, the pipeline itself then
exercised end to end against real issues and PRs.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.
</content>
