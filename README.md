# gh-agentic-workflows

[GitHub Agentic Workflows](https://github.com/github/gh-aw) is generic tooling
that compiles markdown defining agent tasks into GitHub Actions. It is very flexible,
not defining any specific workflow (though there are reference examples upstream).

This repository serves as a place for workflows deployed in the bootc-dev GitHub
organization.

There is a collection of things like CI failure analysis, as well as a full
"issue to PR" style flow.

## Reusing this pipeline in your own repo

Rather than forking this whole repo (see "Adapting to your project" below), you can
install it as a gh-aw package: `gh aw add bootc-dev/gh-agentic-workflows@v0.1.0` reads
this repo's `aw.yml` manifest and pulls in `drafter.md`, `review.md`, and `fix.md`,
compiling them fresh against your repo, and copies `merge.yml`, `install-labels.yml`,
and `upgrade.yml` over verbatim. `queue-triage.md` and `ci-triage.md` are deliberately
*not* in that manifest's `includes:` list — they're optional add-ons, not part of the
core pipeline — so add either one explicitly by its full path, e.g.
`gh aw add bootc-dev/gh-agentic-workflows/.github/workflows/ci-triage.md`. The installed
`.md` files reference the pipeline's bot identity through repo variables/secrets rather
than hardcoding it, so before anything will actually trigger you still need to:

- Register your own GitHub App and configure `GH_AW_APP_CLIENT_ID`, `GH_AW_APP_PRIVATE_KEY`,
  and `GH_AW_APP_BOT_SLUG` (see "Repository setup checklist" below).
- Run the `install-labels.yml` workflow (or `scripts/install-labels.js`) to create the
  required labels.

See "Repository setup checklist" below for the full details on each of these steps.

### Updating an installed pipeline

Cutting a `gh-agentic-workflows` release should normally result in a separate PR for
each consumer that adopts the release, including `bootc-dev/bcvk`. This is a **package
update**, not the consumer's weekly `upgrade.yml` PR: `upgrade.yml` maintains that
repository's action lock and generated lock files using the `gh-aw` compiler selected by
the package release, and may also apply
dispatcher updates and codemods to its authored Markdown workflows. Review the full
compiler-upgrade diff and retain consumer frontmatter customizations. A package update,
by contrast, takes changed authored workflows and shipped plain YAML files from this
repository.

Do not re-run `gh aw add ... --force` over a consumer: it overwrites local frontmatter
customizations such as bcvk's Rust network allowance and pilot auto-merge guard. Apply
the diff between exact package release tags manually to the consumer, retaining its
customizations, then apply the release's changes to copied `merge.yml`,
`install-labels.yml`, and `upgrade.yml`. Recompile and review the complete diff before
opening the PR.

`gh aw add` currently records a resolved commit SHA in each Markdown workflow's
`source:` field, even when installed from a tag. Consequently, a later `gh aw update`
tracks the source repository's default branch rather than release tags. Before updating,
replace each source ref with the currently installed release tag; after a successful
update, replace its newly resolved SHA with the target release tag again. This keeps the
next update release-driven. Treat this as a gh-aw limitation: source-aware updates do
not cover the plain YAML files in this package. More importantly, `gh aw update` expands
the package manifest and can replace locally customized sibling Markdown workflows even
when invoked for one workflow; a bcvk trial dropped both Rust `network:` blocks. Do not
use it (including `--no-merge`) for a customized consumer until that behavior is fixed
upstream.

## Overview

This repository provides reusable workflows. Its issue-to-PR pipeline drafts changes from
an issue, iterates through review and fixes, and mechanically merges approved pull
requests:

```text
issue --agent/code--> drafter.md --> draft PR (agent/*, same repository)
                                        |
                     opened/synchronized; gh-aw activated and authorized
                                        v
                                   review.md
                                  /         \
                    agent/fixme v           v agent/lgtm
                              fix.md      merge.yml --> merge
                                |
                       successful fix push
                                |
                                +-----------> review.md
```

`review.md` does not review every PR: it handles only opened or synchronized,
same-repository PRs whose head branch starts with `agent/`, after gh-aw's activation and
authorization gates pass. `agent/fixme` sends the PR to `fix.md`; a successful fix push
causes a synchronize event and another review. `agent/lgtm` sends it to `merge.yml` for
mechanical merging. Its CI failure analysis covers normal pull-request and merge-queue
runs. The canonical authored workflow definitions are
[`drafter.md`](.github/workflows/drafter.md),
[`review.md`](.github/workflows/review.md), [`fix.md`](.github/workflows/fix.md),
[`merge.yml`](.github/workflows/merge.yml), [`ci-triage.md`](.github/workflows/ci-triage.md),
and [`queue-triage.md`](.github/workflows/queue-triage.md). The `.md` files are the
canonical gh-aw sources; their matching `.lock.yml` files are generated artifacts.

## Retrospective analyzer

`retro.md` is a host-only scheduled workflow for this repository. It is deliberately
excluded from `aw.yml`, so `gh aw add` consumers do not install or run it. Every six
hours it runs from `bootc-dev/gh-agentic-workflows`, discovers active, non-archived,
non-fork repositories in its organization, and analyzes their recent workflow runs.
The host repository is excluded from the default target set because the intended scope
is the other organization repositories; a manual `target_repos` dispatch override may
include it. Duplicate searches and any new `agent/retro` improvement issues are always
performed in the host repository, not target repositories.

Retro persists one small JSON checkpoint per target repository on its dedicated
`memory/retro-checkpoints` branch. A first scan starts seven days back; later scans use
the checkpoint with a one-hour overlap and deduplicate run IDs. A checkpoint advances
only after useful processing succeeds, so an API failure remains retryable rather than
skipping data. A dispatch `lookback_days` value is validated from 1 through 90 and can
request a wider window.

The workflow's `GITHUB_TOKEN` can only discover and analyze repositories it can read.
It reports this limitation in its pre-fetch data and does not claim coverage of private
or internal repositories that are inaccessible to that token. A manual dispatch accepts
comma-separated, whitespace-trimmed `owner/repo` targets from the host organization and
validates that each is active and not a fork; `lookback_days` must be an integer from 1
through 90.

## Design notes and gotchas

A few things here are non-obvious and were hard-won getting this to actually work:

- **`github-app:` is safe at the `safe-outputs:` root — that's specific to how gh-aw
  handles App auth.** gh-aw mints the App installation token only inside the trusted
  safe-outputs job (after the untrusted agent job has already finished), so declaring
  `github-app:` once at the `safe-outputs:` root applies to every handler below it
  without ever reaching the agent job's sandbox. This is *not* generally true of a raw
  token string: the earlier version of this repo used a PAT
  (`GH_AW_CI_TRIGGER_TOKEN` via `github-token: ...`), which had to be nested under each
  individual safe-output key (e.g. `add-labels: github-token: ...`) instead of the root,
  precisely because a root-level plain `github-token:` leaks into the untrusted agent
  job's environment. `github-app:` doesn't have that problem, so it belongs at the root.
- **`label_command:` plus a custom top-level `if:` drops the label match.** gh-aw's
  `label_command:` trigger is the natural-looking choice for "run when label X is
  applied," but combining it with a custom top-level `if:` (needed here to also check
  the `agent/*` branch prefix) silently drops the trigger's own label-name condition —
  the workflow ends up firing on *any* label change. `fix.md` works around this with a
  plain `pull_request: types: [labeled]` trigger and an explicit
  `if: github.event.label.name == 'agent/fixme'` check instead.
- **Draft PRs need an explicit "ready" step.** `drafter.md` opens PRs as drafts, and
  `gh pr merge` refuses drafts outright. `merge.yml` calls `gh pr ready` before
  `gh pr merge`.
- **Plain workflows don't get gh-aw's fork guard for free.** gh-aw workflows come with
  an automatic fork-origin guard; a plain Actions workflow like `merge.yml` does not.
  If your repository could ever receive fork pull requests — which matters even for
  private repos, since GitHub still hands secrets to fork-originated `pull_request` runs
  — add an explicit check yourself, e.g.
  `github.event.pull_request.head.repo.id == github.repository_id`. `merge.yml` in this
  repo already includes it; keep it if you adapt the file.
- **A GitHub App bot actor always fails gh-aw's default role check.** gh-aw's
  `pre_activation` job gates every run on `on.roles` (default `admin`, `maintainer`,
  `write`), checked via `GET /repos/{owner}/{repo}/collaborators/{username}/permission`.
  A GitHub App installation isn't a collaborator in that ACL model — its access comes
  from the installation grant, not collaborator status — so that endpoint always reports
  `none` for an App bot actor, and the check always fails. Since `review.md` and
  `fix.md` trigger on `pull_request` events that can be authored or labeled by the
  shared App bot itself (drafter.md's PR, or fix.md's own labeling via review.md's
  `add-labels`), both need `on.bots: ["${{ vars.GH_AW_APP_BOT_SLUG }}"]` to bypass the
  role check for that specific identity — `bots:`/`trusted-users:` values are passed
  through into the compiled workflow verbatim, so a GitHub Actions expression there
  resolves at runtime just like it would in any other field, letting the bot identity
  live entirely in a repo variable instead of being hardcoded in the `.md` sources. The
  failure mode when this is misconfigured is deceptive: the `pre_activation` job
  reports success (it did its job, correctly gating the run off) while everything
  downstream silently never runs — the overall run conclusion looks fine, so you have to
  check job-level status, not run-level status, to notice it.
- **Pin the gh-aw compiler and select models through aliases.** gh-aw's CLI auto-upgrades
  by default, and an upgrade once shipped a compiler whose AI-credits pricing table had
  fallen out of sync with Anthropic's current model line — agents started failing with
  errors like `<model> has no AI credits pricing`. Pin the extension to a known-good
  version (the pin lives in `.github/aw/gh-aw-version`, used by both `ci.yml` and `just
  setup` — run `just setup` locally to install it). Set `model: sonnet` in authored
  workflow frontmatter rather than a dated provider model ID, so gh-aw centrally maps the
  supported alias; then recompile. If workflows that were working suddenly start failing
  with a pricing-lookup error, update the pinned compiler and regenerate the lockfiles.
- **A per-workflow `agent/*-working` label is added and removed via frontmatter
  `jobs:`, not safe-outputs.** Each workflow carries its own working label on the
  issue/PR for the duration of a run — `agent/drafter-working` (drafter.md),
  `agent/review-working` (review.md), `agent/fix-working` (fix.md) — using two custom
  jobs declared directly in each `.md` file's `jobs:` block: `add_working_label`
  (depends on `pre_activation`, which gh-aw's compiler automatically threads into
  `activation`'s own dependencies, so `agent` transitively waits for it) adds the
  label, and `remove_working_label` removes it, gated on `needs.pre_activation.outputs.activated
  == 'true'` so a run only clears the label it actually set (not another workflow's,
  and not one it never added because its own activation gate failed). The labels are
  per-workflow rather than shared: `review.md` and `fix.md` both used to add/remove a
  single `agent/working` label on the same PR, and a run whose real work was skipped
  could still unconditionally strip the *other* workflow's still-in-progress signal —
  confirmed live, where `fix.md`'s cleanup removed the label 11 seconds after
  `review.md` set it, while `review.md`'s agent job kept running several more minutes.
  safe-outputs handlers only run when the agent job succeeds, which can't guarantee
  cleanup on failure or timeout — a plain job with `if: always()` (further gated as
  above) can.

### Letting the agent edit protected files

`drafter.md` and `fix.md` both default to gh-aw's `request_review` policy for protected
files (`README.md`, the workflow definitions themselves, `.github/aw/actions-lock.json`,
etc.): the PR still gets opened, but with a mandatory `REQUEST_CHANGES` review blocking
merge until a human looks at those specific files. This is what issue-driven runs hit if
the requested change happens to touch, say, `README.md` — see e.g.
[#19](https://github.com/bootc-dev/gh-agentic-workflows/issues/19).

Sometimes you *know* a task legitimately needs to touch protected files — renaming a
label consistently across `README.md` and the `.md`/`.lock.yml` workflow sources is a
good example. For that, both files' `protected-files.policy` is a [GitHub Actions
expression string](https://github.github.io/gh-aw/reference/safe-outputs-pull-requests/#parameterizing-policy-fields-in-reusable-workflows)
rather than a bare literal:

```yaml
protected-files:
  policy: ${{ case(contains(github.event.issue.labels.*.name, 'agent/workflow-edits-allowed'), 'allowed', 'request_review') }}
```

Note this uses `case()` rather than the more common `cond && 'allowed' || 'request_review'`
ternary idiom: gh-aw's compiler JSON-encodes this policy string with Go's default
HTML-escaping, which turns a literal `&&` into `\u0026\u0026` inside the heredoc-embedded
config blob. GitHub Actions' expression parser can't parse that, so the whole compiled
workflow gets rejected as invalid on push — see
[the fix for #21](https://github.com/bootc-dev/gh-agentic-workflows/commit/0735a1c).
`case()` avoids `&`, `<`, and `>` entirely, so it survives serialization intact.

Applying the `agent/workflow-edits-allowed` label to the *issue* — before or alongside
`agent/code` — pre-authorizes that specific `drafter.md` run to write protected files
without the review gate; `fix.md` checks the same label on the *pull request* instead, so
either the drafter PR needs to carry it too (a human can add it after the fact) for
follow-up fix commits to get the same treatment. Crucially, this is a human decision made
*before* the agent runs, not something the agent can grant itself: the label has to
already be present on the triggering issue/PR when the event fires, so a prompt-injected
or misbehaving agent can't unlock this on its own mid-run. The expression falls back to
`request_review` whenever the label is absent, which keeps that the default for every
ordinary run.

### The App token also needs an explicit `workflows` permission

Separately from the protected-files policy above, GitHub enforces a hard server-side rule:
a GitHub App-authenticated push that touches anything under `.github/workflows/` is
rejected outright unless the token minting the push was granted the `workflows`
permission — *even if the App installation itself has that permission enabled*. gh-aw's
`create-github-app-token` step only requests `contents`/`issues`/`pull-requests` by
default, so any run that legitimately edits workflow files (like the label rename above)
fails at the `git push` step with `refusing to allow a GitHub App to create or update
workflow ... without \`workflows\` permission`, and falls back to filing an issue instead
of opening a PR — see [#21](https://github.com/bootc-dev/gh-agentic-workflows/issues/21).

Both `drafter.md` and `fix.md` request the extra scope explicitly via `safe-outputs.github-app.permissions`:

```yaml
github-app:
  client-id: ${{ vars.GH_AW_APP_CLIENT_ID }}
  private-key: ${{ secrets.GH_AW_APP_PRIVATE_KEY }}
  permissions:
    workflows: write
```

### Trusting the pipeline's own bot

gh-aw filters GitHub content an agent reads by *integrity*: on a public repo, anything
not authored by an `OWNER`/`MEMBER`/`COLLABORATOR` (or a first-party bot like Dependabot)
defaults to below the `approved` threshold and is silently dropped before the agent sees
it — see [gh-aw's integrity filtering docs](https://github.github.io/gh-aw/reference/integrity/).
Pull requests get a pass (any non-fork PR on a public repo counts as `approved`
regardless of author), but plain *issues* don't — including the fallback issues our own
App bot files when a safe-output push is rejected (e.g.
[#26](https://github.com/bootc-dev/gh-agentic-workflows/issues/26)).

That means relabeling one of those fallback issues to retry a task doesn't work: the
agent can see the label but gets a filtered, empty view of the issue body describing
what to actually do, and correctly no-ops. All three workflows list the bot in
`tools.github.trusted-users` so its own output is treated as trusted input:

```yaml
tools:
  github:
    min-integrity: approved
    trusted-users: ["${{ vars.GH_AW_APP_BOT_SLUG }}"]
```

The right way to retry a rejected task is still to fix the label order (see above) or
apply the bundle manually on the *original* issue/PR — relabeling the fallback issue is
now at least readable by the agent, but it was never the intended recovery path.

## Repository setup checklist

1. Create the required labels: `agent/code`, `agent/fixme`, `agent/lgtm`, `agent/drafter-working`,
   `agent/review-working`, `agent/fix-working`, `agent/workflow-edits-allowed`,
   `agent/flake-tracker`, `agent/retro` (see "Letting the agent edit protected files"
   above). The three
   `agent/*-working` labels just need to exist; their color is cosmetic (see "a per-workflow
   `agent/*-working` label is added and removed via frontmatter `jobs:`" above).
   `agent/flake-tracker` is only needed for merge-queue CI failure analysis (see
   "Overview" above).

   The easiest way is to run the included install script via the **Install Labels** workflow
   in the Actions tab, or manually via:

   ```bash
   gh label create "agent/code" --color 0E8A16 \
     --description "Triggers the drafter agent"
   gh label create "agent/fixme" --color D93F0B \
     --description "Reviewer agent found issues that need fixing"
   gh label create "agent/lgtm" --color 0E8A16 \
     --description "Reviewer agent approved; ready to auto-merge"
   gh label create "agent/drafter-working" --color FBCA04 \
     --description "The drafter agent is actively working on this issue"
   gh label create "agent/review-working" --color FBCA04 \
     --description "The review agent is actively working on this PR"
   gh label create "agent/fix-working" --color FBCA04 \
     --description "The fix agent is actively working on this PR"
   gh label create "agent/workflow-edits-allowed" --color 5319E7 \
     --description "Pre-authorizes agent runs to edit protected files without the request_review gate"
   gh label create "agent/flake-tracker" --color 1D76DB \
     --description "Marks the CI flake tracker issue the merge queue analyzer maintains"
   gh label create "agent/retro" --color 1D76DB \
     --description "Marks improvement issues filed by the retrospective analyzer"
   ```

   See [`scripts/README.md`](scripts/README.md) for more installation options.
2. Register a GitHub App to act as the pipeline's bot identity (this must be a real App,
   not the default `GITHUB_TOKEN`, which cannot trigger subsequent workflows):
   - Go to Settings → Developer settings → GitHub Apps → New GitHub App.
   - Grant repository permissions: Contents (Read & Write), Issues (Read & Write), Pull
     requests (Read & Write), Workflows (Read & Write). Metadata (Read) is auto-granted.
     Workflows is easy to miss since nothing in this repo's own `permissions:` blocks
     needs it — it's only required because `drafter.md`/`fix.md`/`upgrade.yml` push
     commits that touch `.github/workflows/*` (see "The App token also needs an
     explicit `workflows` permission" above).
   - Set the webhook to inactive — it isn't needed, since this App is only used to mint
     API tokens for Actions, not to receive events.
   - Set installability to "Only on this account".
   - After creating it, capture the **Client ID** (not the numeric App ID) from the
     App's General settings page.
   - Generate and download a private key from the same page.
   - Install the App on this specific repository.
   - Store the credentials on the repo: `gh variable set GH_AW_APP_CLIENT_ID --body
     "<client-id>"` (a non-secret repo variable) and `gh secret set
     GH_AW_APP_PRIVATE_KEY < path/to/key.pem` (a secret).
   - Also set `gh variable set GH_AW_APP_BOT_SLUG --body "<your-app-slug>[bot]"` to the
     App's actual bot actor name. All three `.md` files read this variable (via
     `bots:`/`trusted-users:` fields set to `${{ vars.GH_AW_APP_BOT_SLUG }}`) instead of
     hardcoding an identity, so swapping bots later is just a variable update — no
     workflow edits or recompiling required. Without it, `review.md`/`fix.md`'s
     `pre_activation` job will always reject the shared App bot's role check and
     silently no-op forever (see "Design notes and gotchas" above), and agents won't be
     able to read content the bot itself files, like fallback issues (see "Trusting the
     pipeline's own bot" above).

   (The App used for this specific demo instance is `bootc-bot`; the steps above are
   written generically so you can register your own App if adapting this repo.)
3. Make sure the workflows compile cleanly from the `.md` files (see below) — run `just
   setup && just compile` after any workflow edit (see "Design notes and gotchas" above
   for why the extension version must stay pinned).
4. If validating your project needs network access beyond gh-aw's engine defaults —
   e.g. `cargo test`/`cargo check` reaching a crate registry, or any other compiled
   language's package manager — add a `network:` block to `drafter.md`'s and `fix.md`'s
   frontmatter. gh-aw's agent jobs run behind an egress firewall whose defaults don't
   include most non-npm package registries; without this, an agent's own build/test
   commands can silently stall or fail (they may still open a PR anyway, having punted
   verification to CI). See gh-aw's network documentation for the exact syntax, e.g.:
   ```yaml
   network:
     allowed:
       - defaults
       - rust  # or your ecosystem's identifier, or explicit domains
   ```
5. If the target branch has a GitHub merge-queue ruleset, enable "Allow auto-merge" in
   the repo's settings. `merge.yml` enqueues PRs via `gh pr merge` rather than merging
   them directly on such branches (merging becomes async: the queue runs its own checks
   and merges later, possibly batched with other PRs), and `gh` refuses to do that at
   all unless auto-merge is allowed. Note the queue also always uses its own configured
   merge method and generates its own commit message once it actually merges — the
   `--squash`/custom-subject handling in `merge.yml` only takes effect on branches
   without a merge queue.

## Troubleshooting and operations

**How to tell if a PR is stuck.** `fix.md`'s iteration cap (3, i.e. 2 automated fix
attempts) is enforced by counting commits on the PR via `gh pr view --json commits`. When
that cap is hit, `fix.md` removes `agent/fixme` (so it can't retrigger) and posts a PR
comment explaining that automated fixing has stopped, but does **not** apply any label. A
PR that has neither `agent/fixme` nor `agent/lgtm`, but does have a bot comment about the
iteration cap, is stuck and waiting on a human — it is not "in progress," and nothing
will move it forward on its own.

**What not to do.** Toggling the originating issue's `agent/code` label off and back on
does *not* resume work on the stuck PR — `drafter.md` triggers on that label and will
open a brand-new, separate PR for the same issue, leaving the original stuck PR untouched
and orphaned. Don't do this; it just produces a duplicate.

**How to actually rescue a stuck PR.** Because the iteration cap is a running commit
count on the branch that only ever grows, re-applying `agent/fixme` to a capped PR does
**not** give the loop a clean extra attempt: `fix.md` will immediately see the same (or
higher) commit count, hit the cap again, and post another comment without ever touching
the code. The reliable options are:

- Push a fix commit to the branch yourself, then apply `agent/lgtm` directly once you're
  confident it's ready — this bypasses `fix.md`/`review.md` entirely and goes straight to
  `merge.yml`.
- Or just close the PR if it's not worth pursuing further.

Note that the first option isn't just the *preferred* way to get a fresh judgment on a
manually-pushed commit — it's the *only* way. `review.md` (like `fix.md`) refuses to
activate unless the actor that triggered its `synchronize`/`labeled` event matches the
PR's original author, even for a repo admin; this is deliberate (it stops a human from
smuggling commits onto a bot-authored branch to inherit the bot's `min-integrity:
approved`/`trusted-users` treatment — see "Trusting the pipeline's own bot" above). So a
human push to an `agent/*` branch will never cause `review.md` to re-review it, no matter
who pushes it or what role they have; `merge.yml` has no such check (it's a plain
mechanical workflow gated only by the `agent/lgtm` label, not an agent job), which is
exactly why applying that label by hand is the supported rescue path, not a workaround.

(If you really want the automated fix loop itself to run again rather than finishing by
hand, you'd need to reduce the branch's commit count back below the cap first, e.g. by
squashing the existing commits, before re-applying `agent/fixme` — at that point you're
almost as far along as just finishing the fix yourself, so this is rarely worth it.)

**Verifying the pipeline end to end.** `tests/e2e.sh` scripts the manual procedure for
exercising the full loop against a live repository: it files a fresh issue, then polls
the real GitHub API and reports each stage — PR opened, review posted, `agent/fixme`/
`agent/lgtm` applied, fix commit pushed, re-review, merge — as it happens.

```
./tests/e2e.sh --repo bootc-dev/gh-agentic-workflows --scenario needs-fix
```

This is **not** a unit test: it burns real Anthropic API credits against the live
workflows, and a full `needs-fix` round trip (drafter, review, fix, re-review, merge) has
been observed to take 20 minutes or more. It's a manual tool for a human — or an agent, on
explicit request — to run deliberately; it is not wired into any Actions trigger. See
`./tests/e2e.sh --help` for the full set of flags and the `clean` scenario (no deliberate
gap, expected to reach `agent/lgtm` on the first review).

## Adapting to your project

Copy `.github/workflows/{drafter,review,fix}.md` and `merge.yml`. Recompile the Markdown
sources to generate their `.lock.yml` counterparts.

Safe to edit: the prompt bodies under each `---` frontmatter block — the task
description, validation instructions, and review criteria are all plain English and
should be tailored to your repo's conventions and tooling.

Leave alone unless you know what you're changing: the `on:`/`if:` triggers, the
`safe-outputs:` blocks and their token scoping, and the `agent/fixme`/`agent/lgtm`/
`agent/code` label names. If you do rename a label, update it consistently across
`review.md`, `fix.md`, and `merge.yml` — the pipeline depends on all three agreeing on
the same names.

After editing any `.md` file, recompile with:

```
just setup && just compile
```

(see the `justfile` at the repo root).

## Roadmap

This repo is proven as a single-repo demo; the next phase is rolling it out as the
standard pipeline across `bootc-dev`'s other active repos. Roughly in order:

- [x] **Stop Renovate from bumping compiled `.lock.yml` files directly.** Renovate's
      `github-actions` manager currently treats `*.lock.yml` like a hand-authored
      workflow and rewrites action SHAs in place (see
      [#50](https://github.com/bootc-dev/gh-agentic-workflows/pull/50)) — including
      bumping `github/gh-aw-actions` straight past the version pinned in
      `.github/aw/gh-aw-version`, which desyncs the lock files from what `gh aw compile`
      would actually produce and fails `check-drift`. Fixed in two parts: Renovate gets
      `ignorePaths` for `.github/workflows/*.lock.yml` (and, preemptively, the other
      compiler-owned pin file, `.github/aw/actions-lock.json`, even though no manager
      currently targets it) so it stops touching compiler output entirely, and
       [`upgrade.yml`](.github/workflows/upgrade.yml) — shipped as part of this same
       package, like `merge.yml` — takes over that job instead: weekly, it installs the
       package-selected `gh-aw` CLI version, writes `.github/aw/gh-aw-version` in the
       consumer, refreshes `.github/aw/actions-lock.json`, runs gh-aw's dispatcher/codemod updates,
       recompiles everything, and opens a PR. This runs as a plain, non-agentic scheduled
       workflow (no LLM involved), but the complete diff still needs review because
       codemods can alter authored Markdown workflow frontmatter — deliberately not routed through Renovate's
      `postUpgradeTasks`, since that would need org-wide admin config for a single
      repo's need and `gh`/`gh aw` aren't available in Renovate's runner anyway. (`gh aw
      upgrade` also has a `--org` mode to trigger this fleet-wide from one place; not
      needed yet since every consumer gets its own `upgrade.yml` on install, but worth
      knowing about for a one-off global sweep, e.g. reacting to a security advisory.)
- [ ] **Keep cutting `v0.x.0` releases for now rather than committing to a `v1`
      stability contract.** Per semver's pre-1.0 convention, a `0.x` minor bump is where
      breaking changes are expected to land, so each notable change to this pipeline
      gets its own `v0.x.0` tag rather than piling up as `v0.1.x` patches. Consumers pin
      `gh aw add bootc-dev/gh-agentic-workflows@v0.x.0` to an exact tag (frozen forever
      per gh-aw's versioning model, so this is safe even without a stability guarantee)
      instead of tracking a moving major ref. Revisit cutting `v1` — and documenting,
      ideally in "Adapting to your project" above, exactly which frontmatter/label
      surface is load-bearing versus safe to diverge on — once the pipeline has proven
      itself across a couple of real consumers.
- [ ] **Decide the bot-identity model org-wide**: one GitHub App installed into every
      consuming repo, versus one App registration per repo. The former means less
      operational toil (one set of credentials to rotate) but a more centralized blast
      radius if compromised.
- [ ] **Pilot on one low-traffic repo** via `gh aw add` (not copy-paste), with
      `merge.yml` initially disabled or manual, watching reviewer/fixer judgment quality
      for a couple of weeks before enabling auto-merge — following gh-aw's own "safe
      rollout" ladder (report-only → staged → full writes). See the
      [`onboard-repo`](.agents/skills/onboard-repo/SKILL.md) skill for the concrete
      step-by-step.
- [ ] **Fold the Renovate fixes into the shared `bootc-dev/infra` config** once proven on
      a second repo, so every future consumer inherits the `.lock.yml`/`gh-aw-version`
      handling for free instead of rediscovering it.
- [ ] **Wider rollout** to the rest of the active `bootc-dev` repos (`bootc`, `bcvk`,
      `bink`, `bootc-operator`, …), each getting its own pilot window. Metadata-only
      repos (`.project`, `community`) are out of scope — the pipeline assumes a code+CI
      repo shape.
- [ ] **Revisit `queue-triage.md`** for repos with a real merge queue and real flake
      history — `bootc` is the most likely candidate.

## Files

Workflow sources live under `.github/workflows/`; see "Overview" above for the canonical
definitions. Matching `*.lock.yml` files are generated artifacts checked into the repo.
[`retro.md`](.github/workflows/retro.md) is a host-only retrospective analyzer, excluded
from `aw.yml`; it scans accessible organization repositories but centralizes issues in
this repository — see "Retrospective analyzer" above.
[`upgrade.yml`](.github/workflows/upgrade.yml) is a separate, plain maintenance workflow:
weekly, it installs this package release's pinned `gh-aw` CLI, writes the consumer's
`.github/aw/gh-aw-version`, refreshes `.github/aw/actions-lock.json`, applies gh-aw dispatcher/codemod updates, recompiles every
`.md` workflow, and opens a PR. Review the complete PR, including authored Markdown
workflows and any consumer-specific frontmatter customizations — see the Roadmap entry
below for why this exists.
[`.agents/skills/onboard-repo/`](.agents/skills/onboard-repo/SKILL.md) is an
opencode-compatible agent skill: the operational runbook for piloting this pipeline on a
new consumer repo, referenced from the Roadmap items below.

## Prior art

This is a sibling demo to [cgwalters/merge-queue-like-bors](https://github.com/cgwalters/merge-queue-like-bors):
same spirit of solving a real GitHub Actions automation gap with a minimal,
well-documented, standalone workflow instead of reaching for a heavyweight external tool.

It builds directly on [gh-aw](https://github.com/github/gh-aw) (GitHub Agentic
Workflows), which provides the underlying agent execution model, sandboxing, and
safe-outputs used by `drafter.md`, `review.md`, and `fix.md`.

It's also an exploration of the same category of problem that
[fullsend](https://github.com/fullsend-ai/fullsend) addresses — autonomous
triage/implement/review/merge pipelines for Git-hosted projects — using a much smaller
surface area: a few gh-aw Markdown workflows and one plain Actions workflow, rather than
a dedicated platform. It's not a replacement for fullsend; it's a worked example of how
far you can get with the primitives GitHub already gives you, and the platform quirks you
run into along the way.

This is a demo/reference implementation, not a hardened product. There's no dashboard,
no multi-repo support, and the iteration cap and validation steps are intentionally
simple.

## Side note on AI

This repository was built and tested with [OpenCode](https://opencode.ai)-coordinated
agents: one drafting the workflows, another reviewing the first's work, and the pipeline
itself then exercised end to end against real issues and PRs. It's a fittingly
self-referential demo — the artifact is a pipeline of AI agents drafting, reviewing, and
fixing code, and it was built the same way.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.
