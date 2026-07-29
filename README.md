# gh-aw-fullsend-mini

A minimal, standalone demonstration of a fully autonomous issue → draft PR → review →
fix → merge pipeline built on [gh-aw](https://github.com/github/gh-aw) (GitHub Agentic
Workflows).

## The problem

LLM coding agents can already draft a pull request from an issue reasonably well. The
hard part is closing the loop autonomously — having a second agent review that PR, decide
whether it's ready, and either request changes or merge it — without a human in the
middle. Two GitHub platform behaviors get in the way, and both are easy to miss until
you hit them in production:

1. **The self-review restriction.** GitHub silently downgrades a pull request review
   submitted with `REQUEST_CHANGES` or `APPROVE` to plain `COMMENT` whenever the
   reviewing identity is the same as the PR author's identity. This isn't documented as
   an error — the API call succeeds, the review just isn't the type you asked for. It
   bites immediately once your drafting agent and your reviewing agent share one bot
   account or PAT, which is exactly what most simple setups do (one bot token, used
   everywhere).
2. **`GITHUB_TOKEN` doesn't retrigger workflows.** Pull requests, pushes, and label
   events authored using the default `GITHUB_TOKEN` do not fire other Actions workflows
   (this is a deliberate anti-recursion guard). If your pipeline is a chain of workflows
   that trigger each other via PR/label events, using `GITHUB_TOKEN` anywhere in the
   chain silently breaks it — the step reports success, but nothing downstream ever runs.

## The insight

Route the reviewer's disposition through **labels** instead of native GitHub review
state. A label isn't a review object, so it isn't subject to the self-review
restriction, and — as long as it's applied using a real PAT/app token rather than
`GITHUB_TOKEN` — a label event retriggers downstream workflows normally.

That turns "the reviewer wants changes" / "the reviewer approves" into two
mutually-exclusive labels, `ai/fixme` and `ai/lgtm`, which cleanly dispatch to the next
stage of the pipeline. The reviewer still posts a normal `COMMENT` review with its actual
feedback — the label is just the machine-readable signal that drives automation.

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
  new commit fires `review.md` again, closing the loop. An iteration cap (checked via
  `git rev-list --count` against `main`) prevents runaway fix/review cycling.
- **`merge.yml`** — triggers on the `ai/lgtm` label. A deliberately plain, non-gh-aw
  Actions workflow: merging is mechanical once the reviewer has already made the
  judgment call, so no LLM is involved. Marks the draft PR ready, squash-merges it, and
  deletes the branch.

## Design notes and gotchas

A few things here are non-obvious and were hard-won getting this to actually work:

- **Token scoping matters — nest it, don't hoist it.** The PAT used to retrigger
  downstream workflows (`GH_AW_CI_TRIGGER_TOKEN`) must be set under the specific
  safe-output key that needs it (e.g. `add-labels: github-token: ...` or
  `push-to-pull-request-branch: github-token: ...`), never at the `safe-outputs:` root.
  A root-level token leaks into the untrusted agent job's sandbox and checkout steps,
  which defeats the point of gh-aw's safe-output isolation.
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

## Repository setup checklist

1. Create three labels: `agent-code`, `ai/fixme`, `ai/lgtm`.
2. Add a `GH_AW_CI_TRIGGER_TOKEN` repository secret: a PAT (or GitHub App installation
   token) for a real user/bot account with write access to the repo. It must **not** be
   the default `GITHUB_TOKEN` — see "GITHUB_TOKEN doesn't retrigger workflows" above.
3. Make sure `gh aw compile` runs cleanly against the `.md` files (see below).
4. Note that a single shared bot identity for the drafter and reviewer is *why* the
   label-based design exists in the first place. If you use two genuinely distinct
   identities instead — for example a separate GitHub App installation for the reviewer
   — you could use native `REQUEST_CHANGES`/`APPROVE` reviews and skip the label
   indirection. The label approach still works fine in that case too, and is simpler to
   set up, so it's a reasonable default either way.

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

- [`.github/workflows/drafter.md`](.github/workflows/drafter.md) — opens a draft PR from
  a labeled issue
- [`.github/workflows/review.md`](.github/workflows/review.md) — reviews the PR, applies
  `ai/fixme` or `ai/lgtm`
- [`.github/workflows/fix.md`](.github/workflows/fix.md) — pushes a fix commit in
  response to `ai/fixme`
- [`.github/workflows/merge.yml`](.github/workflows/merge.yml) — plain workflow that
  merges on `ai/lgtm`
- `*.lock.yml` — gh-aw's compiled output for each `.md` workflow, checked in as
  generated artifacts

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
