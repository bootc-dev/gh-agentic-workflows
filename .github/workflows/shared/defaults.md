---
description: Shared defaults for all workflows
model: claude-opus-5-5
engine:
  id: claude
  # gh-aw v0.89.21 bundles Claude Code 2.1.273, which predates
  # claude-opus-5-5 (added in 2.1.280). Drop this on the next gh-aw upgrade.
  version: "2.1.285"
network:
  allowed:
    - defaults
    - rust
    - github
    - github-actions
    - containers
    - "just.systems"
---
