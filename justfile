# gh-agentic-workflows development helpers.
# Run `just --list` to see available recipes.

# Install (or re-pin) the gh-aw CLI extension to the version this repo requires.
setup:
    node scripts/setup-gh-aw.mjs

# Compile all gh-aw workflow .md sources to .lock.yml (run `just setup` first).
compile:
    gh aw compile drafter review fix queue-triage ci-triage retro --approve

# Setup + compile in one step.
all: setup compile
