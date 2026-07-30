# gh-aw-fullsend-mini

A minimal, standalone demonstration of a fully autonomous issue → draft PR → review →
fix → merge pipeline built on [gh-aw](https://github.com/github/gh-aw) (GitHub Agentic
Workflows).

GH-AW, like the underlying raw Github Actions is a very flexible system, this
demonstrates one possible pipeline.

## How it works

Four stages, each a separate workflow:

```
issue labeled            pull_request              label: ai/fixme          label: ai/lgtm
  'agent-code'          opened/synchronize        (pull_request labeled)   (pull_request labeled)
       │                       │                          │                        │
       ▼                       ▼                          ▼                        ▼
  drafter.md   ──opens PR──▶ review.md   ──labels──▶   fix.md   ──pushes──▶  (back to review.md)
 (gh-aw agent)            (gh-aw agent)              (gh-aw agent)
                                │
                                └──labels 'ai/lgtm'──▶  merge.yml
                                                      (plain Actions workflow)
```

- **`drafter.md`** — triggers when an issue is labeled `agent-code`. Reads the issue,
  implements the change, validates it with whatever the repo provides, and opens a
  **draft** pull request on an `agent/*` branch via gh-aw's `create-pull-request`
  safe-output.
- **`review.md`** — triggers on `pull_request: [opened, synchronize]` for `agent/*`
  branches. Reviews the diff, posts a `COMMENT` review with concrete feedback, and
  applies exactly one of `ai/fixme` (needs work) or `ai/lgtm` (ready to merge), removing
  the other if present.
- **`fix.md`** — triggers on the `ai/fixme` label. Consumes the label (removes it so it
  can't retrigger itself), reads the reviewer's feedback from the PR's reviews, pushes a
  fix commit to the same branch via `push-to-pull-request-branch`, and stops. Pushing a
  new commit fires `review.md` again, closing the loop. An iteration cap stops the loop
  after 2 automated fix attempts and posts a PR comment asking a human to take over
  instead of silently doing nothing — see "Troubleshooting and operations" below.
- **`merge.yml`** — triggers on the `ai/lgtm` label. A deliberately plain, non-gh-aw
  Actions workflow: merging is mechanical once the reviewer has already made the
  judgment call, so no LLM is involved. Marks the draft PR ready, squash-merges it, and
  deletes the branch.

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
  `if: github.event.label.name == 'ai/fixme'` check instead.
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
  `add-labels`), both need `on.bots: ["cgwaltersbot[bot]"]` to bypass the role check for
  that specific identity. The failure mode is deceptive: the `pre_activation` job
  reports success (it did its job, correctly gating the run off) while everything
  downstream silently never runs — the overall run conclusion looks fine, so you have to
  check job-level status, not run-level status, to notice it.
- **Pin the gh-aw compiler and the agent's model.** gh-aw's CLI auto-upgrades by default,
  and an upgrade once shipped a compiler whose AI-credits pricing table had fallen out of
  sync with Anthropic's current model line — agents started failing with errors like
  `<model> has no AI credits pricing`. The fix: pin the extension to a known-good version
  (`gh extension install github/gh-aw --pin v0.81.6`, as `ci.yml` does) and set
  `engine.model` explicitly in each `.md` file's frontmatter to an exact dated model ID
  (e.g. `claude-sonnet-4-5-20250929`) instead of a floating alias, then recompile. If
  workflows that were working suddenly start failing with a pricing-lookup error, this is
  almost certainly why.

### Letting the agent edit protected files

`drafter.md` and `fix.md` both default to gh-aw's `request_review` policy for protected
files (`README.md`, the workflow definitions themselves, `.github/aw/actions-lock.json`,
etc.): the PR still gets opened, but with a mandatory `REQUEST_CHANGES` review blocking
merge until a human looks at those specific files. This is what issue-driven runs hit if
the requested change happens to touch, say, `README.md` — see e.g.
[#19](https://github.com/cgwalters/gh-aw-fullsend-mini/issues/19).

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
[the fix for #21](https://github.com/cgwalters/gh-aw-fullsend-mini/commit/0735a1c).
`case()` avoids `&`, `<`, and `>` entirely, so it survives serialization intact.

Applying the `agent/workflow-edits-allowed` label to the *issue* — before or alongside
`agent-code` — pre-authorizes that specific `drafter.md` run to write protected files
without the review gate; `fix.md` checks the same label on the *pull request* instead, so
either the drafter PR needs to carry it too (a human can add it after the fact) for
follow-up fix commits to get the same treatment. Crucially, this is a human decision made
*before* the agent runs, not something the agent can grant itself: the label has to
already be present on the triggering issue/PR when the event fires, so a prompt-injected
or misbehaving agent can't unlock this on its own mid-run. The expression falls back to
`request_review` whenever the label is absent, which keeps that the default for every
ordinary run.

## Repository setup checklist

1. Create four labels: `agent-code`, `ai/fixme`, `ai/lgtm`,
   `agent/workflow-edits-allowed` (see "Letting the agent edit protected files" above).
2. Register a GitHub App to act as the pipeline's bot identity (this must be a real App,
   not the default `GITHUB_TOKEN` — see "GITHUB_TOKEN doesn't retrigger workflows"
   above):
   - Go to Settings → Developer settings → GitHub Apps → New GitHub App.
   - Grant repository permissions: Contents (Read & Write), Issues (Read & Write), Pull
     requests (Read & Write). Metadata (Read) is auto-granted.
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

   (The App used for this specific demo instance is `cgwaltersbot`; the steps above are
   written generically so you can register your own App if adapting this repo.)
3. Add `bots: ["<your-app-slug>[bot]"]` to the `on:` blocks of `review.md` and `fix.md`
   (not `drafter.md` — see "Design notes and gotchas" above), matching your App's
   actual bot slug. Without this, both workflows' `pre_activation` job will always
   reject the shared App bot's role check and silently no-op forever.
4. Make sure `gh aw compile` runs cleanly against the `.md` files (see below) — run `gh
   aw compile drafter review fix --approve` after any workflow edit. Pin the gh-aw
   extension version when you do (see "Design notes and gotchas" above).

## Troubleshooting and operations

**How to tell if a PR is stuck.** `fix.md`'s iteration cap (3, i.e. 2 automated fix
attempts) is enforced by counting commits on the PR via `gh pr view --json commits`. When
that cap is hit, `fix.md` removes `ai/fixme` (so it can't retrigger) and posts a PR
comment explaining that automated fixing has stopped, but does **not** apply any label. A
PR that has neither `ai/fixme` nor `ai/lgtm`, but does have a bot comment about the
iteration cap, is stuck and waiting on a human — it is not "in progress," and nothing
will move it forward on its own.

**What not to do.** Toggling the originating issue's `agent-code` label off and back on
does *not* resume work on the stuck PR — `drafter.md` triggers on that label and will
open a brand-new, separate PR for the same issue, leaving the original stuck PR untouched
and orphaned. Don't do this; it just produces a duplicate.

**How to actually rescue a stuck PR.** Because the iteration cap is a running commit
count on the branch that only ever grows, re-applying `ai/fixme` to a capped PR does
**not** give the loop a clean extra attempt: `fix.md` will immediately see the same (or
higher) commit count, hit the cap again, and post another comment without ever touching
the code. The reliable options are:

- Push a fix commit to the branch yourself, then apply `ai/lgtm` directly once you're
  confident it's ready — this bypasses `fix.md`/`review.md` entirely and goes straight to
  `merge.yml`.
- Or just close the PR if it's not worth pursuing further.

(If you really want the automated fix loop itself to run again rather than finishing by
hand, you'd need to reduce the branch's commit count back below the cap first, e.g. by
squashing the existing commits, before re-applying `ai/fixme` — at that point you're
almost as far along as just finishing the fix yourself, so this is rarely worth it.)

**Verifying the pipeline end to end.** `tests/e2e.sh` scripts the manual procedure for
exercising the full loop against a live repository: it files a fresh issue, then polls
the real GitHub API and reports each stage — PR opened, review posted, `ai/fixme`/
`ai/lgtm` applied, fix commit pushed, re-review, merge — as it happens.

```
./tests/e2e.sh --repo cgwalters/gh-aw-fullsend-mini --scenario needs-fix
```

This is **not** a unit test: it burns real Anthropic API credits against the live
workflows, and a full `needs-fix` round trip (drafter, review, fix, re-review, merge) has
been observed to take 20 minutes or more. It's a manual tool for a human — or an agent, on
explicit request — to run deliberately; it is not wired into any Actions trigger. See
`./tests/e2e.sh --help` for the full set of flags and the `clean` scenario (no deliberate
gap, expected to reach `ai/lgtm` on the first review).

## Adapting to your project

Copy `.github/workflows/{drafter,review,fix}.md` (+ their compiled `.lock.yml`
counterparts) and `merge.yml`.

Safe to edit: the prompt bodies under each `---` frontmatter block — the task
description, validation instructions, and review criteria are all plain English and
should be tailored to your repo's conventions and tooling.

Leave alone unless you know what you're changing: the `on:`/`if:` triggers, the
`safe-outputs:` blocks and their token scoping, and the `ai/fixme`/`ai/lgtm`/
`agent-code` label names. If you do rename a label, update it consistently across
`review.md`, `fix.md`, and `merge.yml` — the pipeline depends on all three agreeing on
the same names.

After editing any `.md` file, recompile with:

```
gh aw compile drafter review fix --approve
```

## Files

The pipeline lives entirely in
[`.github/workflows/drafter.md`](.github/workflows/drafter.md),
[`review.md`](.github/workflows/review.md), [`fix.md`](.github/workflows/fix.md), and
[`merge.yml`](.github/workflows/merge.yml) — see "How it works" above for what each does.
The matching `*.lock.yml` files are gh-aw's compiled output, checked in as generated
artifacts.

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
