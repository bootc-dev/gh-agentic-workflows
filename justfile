# gh-agentic-workflows development helpers.
# Run `just --list` to see available recipes.

gh_aw_version := `cat .github/aw/gh-aw-version`

# Install (or re-pin) the gh-aw CLI extension to the version this repo requires.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    wanted="{{ gh_aw_version }}"
    # Ask gh-aw itself: `gh extension list` needs gh to be logged in, and it
    # isn't in the agent sandbox, where the CLI is pre-installed (see
    # .github/workflows/shared/workflow-tools.md).
    if version=$(gh aw version 2>&1); then
        installed=$(awk '{print $NF}' <<<"$version")
        if [ "$installed" = "$wanted" ]; then
            echo "gh-aw $wanted already installed."
            exit 0
        fi
        echo "gh-aw installed at $installed, re-pinning to $wanted..."
        gh extension remove gh-aw
    fi
    gh extension install github/gh-aw --pin "$wanted"

# Compile all gh-aw workflow .md sources to .lock.yml (run `just setup` first).
compile:
    gh aw compile drafter review fix queue-triage ci-triage retro --approve

# Setup + compile in one step.
all: setup compile
