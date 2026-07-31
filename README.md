# gh-agentic-workflows

A minimal, standalone demonstration of a fully autonomous issue → draft PR → review →
fix → merge pipeline, built on [gh-aw](https://github.com/github/gh-aw) (GitHub Agentic
Workflows). gh-aw is flexible; this is one possible pipeline built on it.

## Reusing this pipeline in your own repo

Instead of forking this repo, install it as a gh-aw package:

```
gh aw add cgwalters/gh-agentic-workflows@v0.1.0
```

This pulls in `drafter.md`, `review.md`, `fix.md`, and `queue-triage.md` (compiled fresh
against your repo) and copies `merge.yml`/`install-labels.yml` verbatim. The installed
`.md` files arrive hardcoded to this repo's bot identity, so nothing will trigger until
you work through the "Repository setup checklist" below: point the
`bots:`/`trusted-users:` fields at your own GitHub App's bot slug, register that App with
`GH_AW_APP_CLIENT_ID`/`GH_AW_APP_PRIVATE_KEY`, and run `install-labels.yml`.

`queue-triage.md` is independent of the four-stage pipeline below — see "Merge queue
failure analyzer" — and needs its own extra setup step before it does anything either.

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

## Merge queue failure analyzer

`queue-triage.md` is a fifth workflow, unrelated to the pipeline above: it's for repos
that use GitHub's merge queue (this repo's own `merge.yml` doesn't) and want a triage
agent instead of a human reading merge-group CI logs every time a flaky test kicks a PR
out of the queue. It ships in this package but is inert until you name your CI workflow
and create a tracker issue — see "Optional: setting up the merge queue failure analyzer"
below.

- Triggers on `workflow_run` completion of a named CI workflow (default: `"CI"`) whose
  `head_branch` matches `gh-readonly-queue/**`, gated to runs whose conclusion was
  `failure` and whose own event was genuinely `merge_group`. Also accepts
  `workflow_dispatch` with a `run_id` input, for manual runs and testing.
- A deterministic pre-fetch step downloads the failed job(s)' logs, greps them for
  error-indicator lines, and resolves + verifies the affected PR(s) from the queue
  branch name — all before the agent starts, so it works from small hint files instead
  of raw logs.
- Classifies the failure as `flake` (environmental/transient/nondeterministic — a re-run
  would plausibly pass), `real` (this PR's own change broke it deterministically), or
  `unclear` (everything else, including a deterministic failure — a fuzzer crash, a
  pre-existing base-branch break — that just isn't this PR's fault; re-queueing won't
  help there either) by cross-checking evidence (transient network/registry errors,
  disk/OOM exhaustion, rate limiting, a test that fails on one matrix leg but not an
  equivalent one, etc.) against what the PR actually changed, then comments on each
  verified affected PR with the verdict and a recommendation.
- Maintains a deduplicated ledger of known flake signatures inside a human-created
  tracker issue (labeled `agent/flake-tracker`), and posts a one-off narrative comment
  only the first time a given flake signature shows up.
- Never re-queues a PR, and never creates the tracker issue itself — both are
  deliberately left to a human. See "Design notes and gotchas" below for why.

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
- **`set -o pipefail` plus `cmd | grep -q ...` is a latent flake, not just a style nit.**
  `grep -q` exits as soon as it sees a match, and if the upstream command still has more
  to write at that point it gets SIGPIPE'd; under `pipefail` that non-zero exit becomes
  the pipeline's status, so an `if cmd | grep -q pattern; then` can silently take the
  false branch even though `pattern` was genuinely there. It's data-dependent — it only
  bites once the upstream output is large enough to still be mid-write when `grep`
  stops reading — so it can pass in quick manual testing and only show up later against
  a real, larger payload. `queue-triage.md`'s dequeue-detection step hit exactly this
  against `gh api --paginate ... | grep -qx removed_from_merge_queue`; the fix is to
  capture the command's output into a variable first and `grep` that instead of piping
  straight into `-q`.

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

### Why `queue-triage.md` uses `workflow_run`, not something more obvious

Three other candidates don't actually work:

- `pull_request: types: [dequeued]` exists, but its payload carries neither a dequeue
  reason nor the ID of the CI run that failed — there'd be nothing for the agent to
  analyze.
- `check_suite` is suppressed for GitHub Actions-produced check suites, so the whole
  category of event this needs never fires for Actions-based CI.
- `merge_group` only fires on `checks_requested` — queue *entry*, not the eventual
  success or failure of the checks that entry requested.

`workflow_run` on the monitored CI workflow, filtered to
`branches: ["gh-readonly-queue/**"]`, is the only trigger that actually carries a
completed run with a conclusion and a `head_branch` naming the queue entry.

### Why `conclusion: [failure]` excludes `cancelled`, and why the `event == 'merge_group'` guard exists

Merge-group runs are routinely *cancelled*, not failed, when the queue reshuffles out
from under a PR (e.g. a batch ahead of it gets dequeued) — expected churn, not something
worth an agent's attention. Only `failure` triggers analysis.

`workflow_run` fires for *any* completed run of the named workflow whose `head_branch`
matches the `branches:` filter, regardless of what triggered that run — including, in
principle, a plain `push` to a branch someone names `gh-readonly-queue/...` by accident
or on purpose. `queue-triage.md`'s top-level `if:` additionally requires
`github.event.workflow_run.event == 'merge_group'`, so only a run that was genuinely
queue-triggered gets analyzed. `workflow_dispatch` (manual/testing runs) has no
`github.event.workflow_run` at all and is let through unconditionally by the same `if:`.

Adopters on a newer gh-aw than the v0.81.6 this repo pins: a native
`on.workflow_run.conclusion:` filter exists upstream and compiles to exactly this kind
of guarded `if:`. v0.81.6's `workflow_run` schema is stricter
(`additionalProperties: false`, only `workflows`/`types`/`branches`/`branches-ignore`)
and rejects `conclusion:` at compile time with "Unknown property: conclusion" — so this
workflow folds the conclusion check into its own `if:` by hand instead. Worth
retrying `on.workflow_run.conclusion:` after upgrading the pin.

### Why the flake ledger lives in an issue-body island, not a comment

gh-aw can create comments but has no safe-output that edits an existing one. An
`update-issue` island (`operation: replace-island`) in the tracker issue's *body* is the
only surface the agent can both read back and overwrite in place, which is what
deduplicating occurrence counts across runs requires. A brand-new flake signature still
gets a one-off `add-comment` for visibility, but a recurring one just bumps the ledger's
count — otherwise the tracker would accumulate one comment per occurrence of an
already-known flake.

### Why the flake tracker is resolved in pre-fetch, not by agent search

An earlier version of `queue-triage.md` had the agent search for the single open
`agent/flake-tracker`-labeled issue itself, as its first task step, with the
classification step's prose telling it to reach a flake/real/unclear verdict before
consulting the ledger. That didn't hold: the agent's own `search_issues` call to locate
the tracker returns the issue's full body — ledger included — and that call is
structurally the first thing the agent does, regardless of what order the prompt's prose
asks for later steps in. A fuzzer-found crash kept coming back `flake` because a stale
`test-flake/differential` ledger section was already sitting in the agent's context by
the time it classified anything; no rewording of "judge this independently of the
ledger" changed that, because the ledger was never actually absent to judge independently
of.

The fix moves tracker discovery into the deterministic pre-fetch `steps:` block: it
queries open `agent/flake-tracker`-labeled issues (filtering out pull requests, which the
same label-search endpoint also returns) and writes `tracker.json` with the count and,
for the single-match case, the issue's number and title — deliberately not its body. The
prompt reads the number from that file and doesn't fetch the tracker's body until step 5
(naming an already-settled verdict), by which point step 4's classification is done. This
also happens to be a strictly stronger version of the `issue_number`-provenance guard
described above: the number now comes from a bash step the agent doesn't run and can't
influence, not from a search call the agent itself makes and could in principle be
steered by a sufficiently well-crafted prompt injection in a log.

**This did not fully close the anchoring problem.** Live-tested against
`bootc-dev/agentic-sandbox`'s fixture (a `workflow_dispatch` re-run of the same failed
CI run, dispatch [30655448759]), the agent's step 4 verdict on the fuzz crash was
correctly `unclear`, in isolation, before it ever looked at the tracker. But step 5 still
fetches the ledger before the run finishes, and on seeing an existing `test-flake/
differential` section, the agent talked itself back into `flake` mid-run: "the crash
itself is reproducible given the input, but the fuzzer's discovery of it is randomized
... a subsequent run might not trigger the same failure... That makes it a flake from the
system's perspective." That's a new-sounding argument, not the one the prompt's fuzzer
paragraph preempts, and it flipped an already-reached, independently-correct verdict back
to match what the ledger already said. Pre-fetching the *number* closed the
`issue_number`-provenance hole; it didn't stop the model from re-litigating its own
verdict once the ledger content is in context at all, however late. In other words: an
agent-maintained ledger can reinforce its own past misclassifications, and there's no
purely prompt-side fix left to try here that hasn't already failed twice. Treat the
ledger the way you'd treat any other cache with no eviction policy — periodically review
it (particularly `test-flake/*` entries) and prune or downgrade entries by hand; don't
assume repetition in the ledger is evidence of anything, including to the agent
maintaining it.

The structural fix, if this ever becomes more than an annoyance, is to stop having the
agent re-emit the ledger at all: have it emit only a verdict plus a signature, and do the
merge in a deterministic handler (a custom safe-output `jobs:` entry) whose output the
agent never reads back. That's a bigger change than this workflow currently warrants, but
it's the direction — the anchoring is a consequence of asking a model to rewrite a
document it must first read, not of any particular wording in the prompt.

[30655448759]: https://github.com/bootc-dev/agentic-sandbox/actions/runs/30655448759

### Why no `hide-older-comments`, and why no single-slot `concurrency:`

`add-comment`'s `hide-older-comments` applies per *handler*, not per target. With
`target: "*"` it would collapse the tracker issue's own earlier flake write-ups
alongside genuinely stale PR comments, since both go through the same `add-comment`
safe-output on this workflow.

Two analyses racing on the same signature can clobber each other's island edit (last
writer wins, one occurrence count lost) — annoying, but self-healing on the next
occurrence. A single-slot concurrency group would be worse: GitHub only queues one
pending run per group, so a third failure landing during a burst would silently evict
the second and its analysis would never run at all — a lost count beats a lost analysis.

Getting "no restriction" still needed an explicit `concurrency:` override, though, not
just omitting the block: gh-aw always synthesizes *some* default group, even for
workflows whose frontmatter has none at all (see `drafter.md`/`review.md`, which get one
keyed on the issue/PR number with an `|| github.run_id` fallback so unrelated
issues/PRs don't collide). `workflow_run` has no natural per-entity field for gh-aw to
key on, so its fallback here degenerates to a single group shared by *every* run of the
workflow — exactly the single-slot trap described above, not "no restriction" at all.
`queue-triage.md` overrides it with
`group: "gh-aw-${{ github.workflow }}-${{ github.run_id }}"`, putting every run in its
own group so none of them ever block or evict another.

### Batched merge groups, and the auto-requeue non-goal

PR association comes entirely from parsing `pr-<n>` candidates out of `head_branch`,
each verified against `gh api .../pulls/<n>` (open, correct base branch) before anything
is posted to it. An exotic batch-naming scheme (or a queue provider that doesn't embed
PR numbers in the branch name at all) can yield zero verified PRs; the workflow still
updates the tracker ledger in that case, just without a PR comment.

`queue-triage.md` never re-queues a PR. Doing so safely would need its own retry cap (to
avoid burning CI forever on a genuinely broken PR), and "is this really a flake" is a
judgment call a human should still ratify before more CI time is spent on it — leaving
the actual re-queue to a human is one review away, not zero.

### Two more pinned-version (v0.81.6) quirks found building this workflow

- `safe-outputs.update-issue.required-labels` compiles without error or warning but is
  silently dropped from the runtime handler config — confirmed by diffing the compiled
  `GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG` for `update-issue` with and without it present in
  the frontmatter (the field's Go struct supports it; the serialization path for this
  handler just doesn't emit it in this version). The identical field works correctly on
  `add-comment`. `queue-triage.md` still declares
  `required-labels: ["agent/flake-tracker"]` on its `update-issue` block — free once
  gh-aw fixes this — but until then the actual guard against the agent targeting the
  wrong issue is that `issue_number` comes from `tracker.json`, a file the pre-fetch
  `steps:` block writes deterministically (from open issues labeled
  `agent/flake-tracker`, filtered to exclude pull requests) before the agent ever runs.
  That's a stronger guard than the prompt-level rule it replaced ("search for the
  tracker yourself, only trust your own search"): that version's own `search_issues`
  call still returned the tracker's full body ahead of the classification step, which is
  what let a stale ledger entry anchor a fuzzer-crash misclassification — see "Why the
  flake tracker is resolved in pre-fetch, not by agent search" below.
- `tools.github.toolsets` doesn't restrict gh-aw's read-only GitHub MCP tool surface in
  this version: `get_job_logs`/`actions_get`/`actions_list` show up in the compiled
  `--allowed-tools` list regardless of which toolsets are requested (confirmed by
  diffing `drafter.md`'s `toolsets: [issues]` against `queue-triage.md`'s
  `toolsets: [default]` with the `actions` toolset omitted — identical `mcp__github__*`
  sets both times). The real defense against `queue-triage.md`'s agent re-fetching raw
  logs on its own, instead of working from the pre-fetched hint files, is the narrow
  `tools.bash` allowlist (which *is* enforced) plus the prompt's instructions — not the
  toolsets omission, whose comment in the frontmatter should be read as documenting
  intent for when this is fixed upstream, not a currently-effective control.

## Repository setup checklist

1. Create the required labels — `agent/code`, `agent/fixme`, `agent/lgtm`,
   `agent/draft-working`, `agent/review-working`, `agent/fix-working`,
   `agent/workflow-edits-allowed`, `agent/flake-tracker` — via the **Install Labels**
   Actions workflow, or manually:

   ```bash
   gh label create "agent/code" --color 0E8A16 --description "Triggers the autonomous drafter agent"
   gh label create "agent/fixme" --color D93F0B --description "Reviewer agent found issues that need fixing"
   gh label create "agent/lgtm" --color 0E8A16 --description "Reviewer agent approved; ready to auto-merge"
   gh label create "agent/draft-working" --color FBCA04 --description "The drafter agent is actively working on this issue"
   gh label create "agent/review-working" --color FBCA04 --description "The review agent is actively working on this PR"
   gh label create "agent/fix-working" --color FBCA04 --description "The fix agent is actively working on this PR"
   gh label create "agent/workflow-edits-allowed" --color 5319E7 --description "Pre-authorizes agent runs to edit protected files without the request_review gate"
   gh label create "agent/flake-tracker" --color 1D76DB --description "Marks the CI flake tracker issue the merge queue analyzer maintains"
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
5. Run `gh aw compile drafter review fix queue-triage --approve` after any workflow
   edit, with the gh-aw extension pinned (see "Design notes and gotchas" above).
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

### Optional: setting up the merge queue failure analyzer

`queue-triage.md` ships with the package but does nothing until:

1. Your repo actually uses GitHub's merge queue (Settings → Rules → Rulesets, with merge
   queue enabled on the branch) — this repo's own `merge.yml` doesn't use one, so
   there's nothing here for `queue-triage.md` to trigger on.
2. `queue-triage.md`'s `on.workflow_run.workflows:` names your repo's actual
   queue-gating CI workflow (default: `"CI"`).
3. If the same App bot from step 2 above can also enqueue PRs, add its slug to
   `queue-triage.md`'s `bots:` and `tools.github.trusted-users:` too (same reason as
   steps 3–4 above).
4. A tracker issue exists, carrying the `agent/flake-tracker` label from step 1.
   Creating the *issue* is deliberately not automated — see "Design notes and gotchas".

   ```bash
   gh issue create --title "CI flake tracker" --label agent/flake-tracker \
     --body "Running ledger of known flaky merge-queue CI failures, maintained by queue-triage.md."
   ```
5. Recompile: `gh aw compile drafter review fix queue-triage --approve`.

**Testing tip:** to enqueue a PR from the CLI instead of clicking "Merge when ready" in
the UI, use `gh pr merge <n> --merge --auto`. Even though the merge *queue* — not
auto-merge — is what actually dictates the eventual merge strategy, GitHub routes both
through the same `enablePullRequestAutoMerge` mutation, so the command fails with "Auto
merge is not allowed for this repository" unless Settings → General → "Allow auto-merge"
is also turned on.

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
`merge.yml`. Add `queue-triage.md` (+ its `.lock.yml`) too if your repo uses a merge
queue — it's independent of the other four, so it's fine to skip if it doesn't apply.

Safe to edit: the prompt bodies under each `---` frontmatter block (task description,
validation instructions, review criteria) — tailor these to your repo's conventions.
`queue-triage.md`'s `on.workflow_run.workflows:` (your CI workflow's name) is expected
to change per adopter.

Leave alone unless you know what you're changing: the `on:`/`if:` triggers, the
`safe-outputs:` blocks and their token scoping, and the `agent/fixme`/`agent/lgtm`/
`agent/code`/`agent/flake-tracker` label names. If you rename a label, update it
consistently across `review.md`, `fix.md`, `merge.yml`, and `queue-triage.md` as
applicable.

Recompile after editing any `.md` file:

```
gh aw compile drafter review fix queue-triage --approve
```

## Files

The pipeline lives in
[`.github/workflows/drafter.md`](.github/workflows/drafter.md),
[`review.md`](.github/workflows/review.md), [`fix.md`](.github/workflows/fix.md), and
[`merge.yml`](.github/workflows/merge.yml) — see "How it works" above.
[`queue-triage.md`](.github/workflows/queue-triage.md) is the separate, optional merge
queue failure analyzer — see "Merge queue failure analyzer" above. The matching
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
