#!/usr/bin/env bash
# End-to-end pipeline verification: files a real issue against a live
# instance of this repo's issue -> drafter -> review -> fix -> merge
# pipeline, then polls the real GitHub API and reports each stage as it
# happens.
#
# THIS IS NOT A UNIT TEST. It exercises the live gh-aw workflows and burns
# real Anthropic API credits on every run. It is a manual verification tool
# for a human (or an agent, on explicit request) to run deliberately -- it
# is intentionally NOT wired into any GitHub Actions trigger, and should
# never run automatically on push/PR/schedule.
#
# Usage: tests/e2e.sh [--repo <owner/repo>] [--scenario clean|needs-fix]
#                      [--timeout <seconds>]
#
# See --help for details.
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults and argument parsing
# ---------------------------------------------------------------------------

REPO=""
SCENARIO="needs-fix"
TIMEOUT_SECONDS=1800
POLL_INTERVAL=15
MAX_FIX_ROUNDS=3

usage() {
    cat <<'EOF'
Usage: tests/e2e.sh [OPTIONS]

Exercise the live issue -> drafter -> review -> fix -> merge pipeline
against a real repository and report progress stage-by-stage as it
happens. Costs real Anthropic API credits and takes several minutes;
run this deliberately, not from CI.

Options:
  --repo <owner/repo>     Repository to test against. Defaults to the
                          repo of the current directory (via
                          `gh repo view`).
  --scenario <name>       One of:
                            needs-fix (default) - files a task that
                              instructs the drafter to skip unit tests
                              and the reviewer to flag it, exercising
                              the full fix/re-review loop.
                            clean - files a plain task with no
                              deliberate gap, expected to sail through
                              to agent/lgtm on first review.
  --timeout <seconds>     Overall time budget across all stages. Default:
                          1800 (30 minutes) -- a full needs-fix round trip
                          (drafter, review, fix, re-review, merge) has been
                          observed to take upwards of 20 minutes end to end.
  -h, --help              Show this help and exit.

Example:
  ./tests/e2e.sh --repo bootc-dev/gh-agentic-workflows --scenario needs-fix
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo)
            REPO="$2"
            shift 2
            ;;
        --scenario)
            SCENARIO="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT_SECONDS="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

case "$SCENARIO" in
    clean|needs-fix) ;;
    *)
        echo "error: --scenario must be 'clean' or 'needs-fix', got: $SCENARIO" >&2
        exit 1
        ;;
esac

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

for cmd in gh jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "error: required command '$cmd' not found in PATH" >&2
        exit 1
    fi
done

if [[ -z "$REPO" ]]; then
    REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    if [[ -z "$REPO" ]]; then
        echo "error: --repo not given and could not infer it from the current directory (run inside a repo clone, or pass --repo owner/repo)" >&2
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Logging / timing helpers
# ---------------------------------------------------------------------------

START_EPOCH=$(date +%s)
DEADLINE=$((START_EPOCH + TIMEOUT_SECONDS))

log() {
    printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

now_epoch() {
    date +%s
}

remaining_seconds() {
    local remaining=$((DEADLINE - $(now_epoch)))
    if (( remaining < 0 )); then
        remaining=0
    fi
    echo "$remaining"
}

ISSUE_NUM=""
ISSUE_URL=""
PR_NUM=""
PR_URL=""

print_summary() {
    local result="$1"
    local reason="${2:-}"
    echo
    if [[ "$result" == "PASS" ]]; then
        log "PASS: pipeline reached merged state for issue #${ISSUE_NUM} / PR #${PR_NUM}"
    else
        log "FAIL: ${reason}"
    fi
    [[ -n "$ISSUE_URL" ]] && log "Issue: $ISSUE_URL"
    [[ -n "$PR_URL" ]] && log "PR:    $PR_URL"
}

# Aborts the script with a timeout error identifying the stage that was
# still pending, after printing the FAIL summary.
timeout_fail() {
    local stage="$1"
    log "TIMEOUT after ${TIMEOUT_SECONDS}s waiting on: ${stage}"
    print_summary "FAIL" "timeout waiting on: ${stage}"
    exit 1
}

# Sleeps for POLL_INTERVAL, or less if that would exceed the deadline.
# Calls timeout_fail (and never returns) if there is no time left.
poll_sleep_or_timeout() {
    local stage="$1"
    local remaining
    remaining=$(remaining_seconds)
    if (( remaining <= 0 )); then
        timeout_fail "$stage"
    fi
    sleep "$(( remaining < POLL_INTERVAL ? remaining : POLL_INTERVAL ))"
}

# ---------------------------------------------------------------------------
# Task generation
# ---------------------------------------------------------------------------

SUFFIX="${RANDOM}$(( RANDOM % 1000 ))"

# Candidate simple pure-function tasks, added to string_utils.py. Each
# entry sets FUNC_NAME and TASK_DESC when selected below.
TASK_CHOICES=(count_vowels char_frequency reverse_words)
TASK_BASE="${TASK_CHOICES[$(( RANDOM % ${#TASK_CHOICES[@]} ))]}"
FUNC_NAME="${TASK_BASE}_${SUFFIX}"

case "$TASK_BASE" in
    count_vowels)
        TASK_DESC="Add a function \`${FUNC_NAME}(text)\` to string_utils.py that returns the number of vowels (a, e, i, o, u, case-insensitive) in the input string, e.g. ${FUNC_NAME}(\"Hello World\") -> 3."
        ;;
    char_frequency)
        TASK_DESC="Add a function \`${FUNC_NAME}(text)\` to string_utils.py that returns a dict mapping each non-whitespace character (case-sensitive) to the number of times it appears in the input string, e.g. ${FUNC_NAME}(\"abcabc\") -> {\"a\": 2, \"b\": 2, \"c\": 2}."
        ;;
    reverse_words)
        TASK_DESC="Add a function \`${FUNC_NAME}(text)\` to string_utils.py that reverses the order of words in a sentence while keeping each word intact, e.g. ${FUNC_NAME}(\"the quick brown fox\") -> \"fox brown quick the\"."
        ;;
esac

ISSUE_TITLE="Add ${FUNC_NAME}(text) to string_utils.py"

if [[ "$SCENARIO" == "needs-fix" ]]; then
    ISSUE_BODY="${TASK_DESC}

Implementation note for the drafter agent: implement the function itself
correctly, but do NOT write any unit tests for it in this PR -- skip test
coverage entirely for this task.

Note for the reviewer agent: this PR is expected to have no test coverage.
Please flag this in your review as something that needs to be fixed
(the function should have unit tests before merge)."
else
    ISSUE_BODY="${TASK_DESC}

Please implement this function in string_utils.py, following the existing
code style and conventions in the file, including unit tests."
fi

# ---------------------------------------------------------------------------
# Stage 0: file the issue
# ---------------------------------------------------------------------------

log "Repo: $REPO"
log "Scenario: $SCENARIO"
log "Task: ${FUNC_NAME} (timeout: ${TIMEOUT_SECONDS}s)"

ISSUE_URL=$(gh issue create --repo "$REPO" --title "$ISSUE_TITLE" --label agent/code --body "$ISSUE_BODY")
ISSUE_NUM="${ISSUE_URL##*/}"
log "Filed issue #${ISSUE_NUM}: ${ISSUE_URL}"

# ---------------------------------------------------------------------------
# Stage 1: wait for the drafter to open a PR
# ---------------------------------------------------------------------------

log "Waiting for drafter.md to open a pull request for issue #${ISSUE_NUM}..."
while [[ -z "$PR_NUM" ]]; do
    PR_NUM=$(gh pr list --repo "$REPO" --state all \
        --json number,closingIssuesReferences \
        | jq --arg n "$ISSUE_NUM" \
            '[.[] | select(any(.closingIssuesReferences[]?; .number == ($n|tonumber)))][0].number // empty')
    if [[ -n "$PR_NUM" ]]; then
        break
    fi
    poll_sleep_or_timeout "waiting for drafter PR to open"
done

PR_URL="https://github.com/${REPO}/pull/${PR_NUM}"
log "PR #${PR_NUM} opened: ${PR_URL}"

PR_AUTHOR=$(gh pr view "$PR_NUM" --repo "$REPO" --json author --jq .author.login)
log "PR author: ${PR_AUTHOR}"

# ---------------------------------------------------------------------------
# Helpers used by the review/fix/merge polling loop
# ---------------------------------------------------------------------------

# Prints the most recent review's body, prefixed for readability.
print_latest_review() {
    local body
    body=$(gh api "repos/${REPO}/pulls/${PR_NUM}/reviews" --jq '.[-1].body // empty' 2>/dev/null || true)
    if [[ -n "$body" ]]; then
        log "Latest review comment:"
        echo "$body" | sed 's/^/    | /'
    fi
}

get_commit_count() {
    gh pr view "$PR_NUM" --repo "$REPO" --json commits --jq '.commits | length'
}

# Waits for one of agent/fixme / agent/lgtm to be present on the PR's labels.
# Echoes the label name found.
wait_for_review_label() {
    local stage_desc="$1"
    local found=""
    while [[ -z "$found" ]]; do
        found=$(gh pr view "$PR_NUM" --repo "$REPO" --json labels \
            --jq '[.labels[].name] | map(select(. == "agent/fixme" or . == "agent/lgtm"))[0] // empty')
        if [[ -n "$found" ]]; then
            echo "$found"
            return 0
        fi
        poll_sleep_or_timeout "$stage_desc"
    done
}

# Waits for fix.md to consume the agent/fixme label (remove it) and push a new
# commit. Reports the fix commit once observed.
wait_for_fix_commit() {
    local base_commit_count="$1"
    local label_gone=false
    local new_commit=false
    while true; do
        if ! gh pr view "$PR_NUM" --repo "$REPO" --json labels --jq '.labels[].name' | grep -qx 'agent/fixme'; then
            label_gone=true
        fi
        local current_count
        current_count=$(get_commit_count)
        if (( current_count > base_commit_count )); then
            new_commit=true
        fi
        if $label_gone && $new_commit; then
            break
        fi
        poll_sleep_or_timeout "waiting for fix.md to consume agent/fixme and push a fix commit"
    done

    local sha message
    sha=$(gh pr view "$PR_NUM" --repo "$REPO" --json commits --jq '.commits[-1].oid')
    message=$(gh pr view "$PR_NUM" --repo "$REPO" --json commits --jq '.commits[-1].messageHeadline')
    log "Fix commit pushed: ${sha:0:12} - ${message}"
    gh api "repos/${REPO}/commits/${sha}" --jq \
        '"    | +\(.stats.additions // 0) / -\(.stats.deletions // 0) across \(.files | length) file(s)"' 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Stage 2: review / fix loop, then merge
# ---------------------------------------------------------------------------

ROUND=0
while true; do
    LABEL=$(wait_for_review_label "waiting for agent/fixme or agent/lgtm on PR #${PR_NUM} (round $((ROUND + 1)))")
    log "Label applied: ${LABEL}"
    print_latest_review

    if [[ "$LABEL" == "agent/lgtm" ]]; then
        break
    fi

    ROUND=$((ROUND + 1))
    if (( ROUND > MAX_FIX_ROUNDS )); then
        print_summary "FAIL" "exceeded ${MAX_FIX_ROUNDS} agent/fixme rounds without reaching agent/lgtm"
        exit 1
    fi

    BASE_COMMITS=$(get_commit_count)
    wait_for_fix_commit "$BASE_COMMITS"
done

# ---------------------------------------------------------------------------
# Stage 3: wait for merge.yml to merge the PR
# ---------------------------------------------------------------------------

log "Waiting for merge.yml to merge PR #${PR_NUM}..."
while true; do
    STATE=$(gh pr view "$PR_NUM" --repo "$REPO" --json state --jq .state)
    if [[ "$STATE" == "MERGED" ]]; then
        break
    fi
    if [[ "$STATE" == "CLOSED" ]]; then
        print_summary "FAIL" "PR #${PR_NUM} was closed without merging"
        exit 1
    fi
    poll_sleep_or_timeout "waiting for PR #${PR_NUM} to be merged"
done

MERGE_SHA=$(gh pr view "$PR_NUM" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid')
MERGED_BY=$(gh pr view "$PR_NUM" --repo "$REPO" --json mergedBy --jq '.mergedBy.login')
log "Merged: commit ${MERGE_SHA:0:12} by ${MERGED_BY}"

print_summary "PASS"
exit 0
