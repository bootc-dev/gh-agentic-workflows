<!--
Shared classification guidance for this repo's two CI-failure triage
workflows (queue-triage.md and ci-triage.md), pulled in via
{{#runtime-import}} so both judge failures against the same taxonomy.
Each caller supplies its own recommended-action wording and any
tracker/ledger-specific rules around this text; keep this file limited to
guidance that applies identically to both.
-->

Classify each distinct failure, from this run's own evidence alone (the
logs, the PR diff), as one of:

- `flake` — environmental, transient, or nondeterministic: simply
  re-running this would plausibly pass.
- `real` — a deterministic failure caused by *this PR's own change*.
- `unclear` — a deterministic, reproducible failure that is **not**
  attributable to this PR (e.g. already broken on the base branch, or a
  dependency that started failing for everyone). Say plainly that the
  failure looks real but doesn't appear to be caused by this PR, and that
  a human should look — re-running won't help.

Reproducibility ("would a re-run plausibly pass?") and attribution ("did
this PR cause it?") are separate axes — don't conflate "not this PR's
fault" with `flake`. Only nondeterminism earns `flake`; a deterministic
failure that isn't this PR's fault is `unclear`.

Before concluding `real` vs. `flake`/`unclear`, use the GitHub tools to
look at the PR's changed files/diff (`gh pr diff` is not available to
you) — a PR can legitimately cause what looks like an environmental
failure (e.g. it adds a huge fixture that triggers a disk-full, or an
infinite loop that triggers a timeout). When the evidence is thin, say
`unclear` rather than guessing.
