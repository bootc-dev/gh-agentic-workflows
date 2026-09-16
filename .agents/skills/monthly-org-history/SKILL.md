---
name: monthly-org-history
description: Collect one UTC calendar month of GitHub organization activity and draft a fact-separated history/YYYY-MM.md effectiveness report. Use when asked for a monthly organization or agent-pipeline history.
---

# Monthly organization history

This is a **human-run** reporting skill. First collect facts; then write a clearly
labelled interpretation. Do not run it as an autonomous workflow or commit its JSON.

## Collect the snapshot

Confirm that `gh auth status` works and `unzip` is installed. Run:

```bash
node scripts/monthly-org-history.js ORG YYYY-MM --output /tmp/ORG-YYYY-MM-history.json --bot 'bootc-bot[bot]'
```

Use `--repo REPO` to collect one non-archived, non-fork repository within `ORG` rather
than every visible eligible repository. The snapshot records this repository filter.

The script enumerates visible, non-archived, non-fork repositories in sorted order.
It uses the visible `issues?since=` API (whose `since` is an update timestamp), with a
one-millisecond lower-bound overlap, then locally filters timestamps against
`[start, end)`. Current labels are the current state of that collected activity cohort,
not a label-event history. Workflow queries use bounded month partitions to avoid
GitHub's 1,000-result filter cap. Per-repository failures remain in `errors` and
`coverage.repositories.failed` so the report can disclose them; authentication, invalid
input, and organization listing failures stop collection. The snapshot deliberately has
no collection timestamp. The collector refuses to overwrite an existing output path.

Treat `agent/code`, `agent/fixme`, and `agent/lgtm`, `agent/*` PR branches, and
workflows whose canonical path ends in `.lock.yml` as pipeline signals. Plain `.yml`
workflows are not gh-aw workflow signals.
They are not evidence of AI authorship. `Assisted-by: AI` and `Generated-by: AI` are
counted only when explicitly retained in bodies of items **created in the month**.
AIC is reported from retained gh-aw usage artifacts attached to AIC-eligible
(non-skipped) relevant in-window runs, with bot-comment metadata as a fallback. A run's
total means **agent plus threat-detection AIC**. The root `agent_usage.json` aggregate
is authoritative for agent AIC; `agent/token_usage.jsonl` is only a fallback. The
maximum cumulative total in exact `detection/token_usage.jsonl` is added once. With
`--bot LOGIN`, generated issue/PR
conversation-comment footers provide a human-formatted agent-plus-threat AIC fallback
only after artifact lookup fails; verified gh-aw hidden metadata only verifies the run
identity and cannot supply AIC alone. A separate `⌖` value is added when present; without
a breakdown, the footer's sole AIC value is the generated run total rather than an
inferred zero-valued component. Artifacts remain authoritative. Submitted PR review
bodies currently have no metadata, so they remain unknown rather than zero. Bot
visibility and comment/artifact retention can limit this coverage. Missing, expired,
malformed, conflicting, or schema-unrecognized required data mean **unknown**, never
zero. Include eligible/skipped run coverage plus per-run provenance
(`aicSource`/`aicRecords`) and the retention limitation. Commit-message markers are
intentionally out of scope to avoid an API request per PR.

## Draft `history/YYYY-MM.md`

Read the JSON and, if present, `history/<previous-month>.md`. Before creating the
report, check whether the target exists. Refuse to overwrite it unless the human gives
explicit approval. Create the `history/` directory only after that confirmation.

Use these sections:

1. **Scope and data quality** — interval, visible-repository scope, coverage errors,
   AIC artifact retention/schema limits.
2. **Facts** — counts and linked examples from the snapshot: issue/PR creation and
   merges, labels/branches (as current-state signals), workflow conclusion counts,
   explicit attribution markers for the created-item cohort, and AIC only when coverage
   supports it.
3. **Interpretation** — assess conversion from `agent/code` issues to agent PRs or
   merges only where links/evidence support it; workflow reliability; review/fix loops;
   stuck or human-intervention evidence; and AIC efficiency only with sufficient
   coverage. Raw volume is not effectiveness. Do not claim causation from correlation.
4. **Comparison and recommendations** — compare the preceding month when available,
   noting changed coverage, then give actionable, bounded recommendations.
5. **Limitations** — state unavailable linkage, partial visibility, updated-since
   enumeration, artifact retention, and any collection failures.

For qualitative analysis, inspect a small, explicitly identified set of linked items
from the snapshot with `gh issue view` or `gh pr view`. Prioritize failed/cancelled
workflows, repeated review/fix runs, agent PRs that did not merge, and unusually high-AIC
runs. Record the selection criterion and links. This follow-up may explain outcomes, but
must not change the deterministic counts or be presented as a complete sample. If the
available issue, PR, review, comment, or commit evidence does not establish linkage or
human intervention, say that it is unknown.

Keep facts and interpretation visibly separate. Ask the human to review the prose and
facts before any commit; do not commit on their behalf.
