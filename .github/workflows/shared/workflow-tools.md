---
description: just (via bootc-ubuntu-setup) and the gh-aw CLI for recompiling lock files, installed before the agent starts
# Tools the drafter and fix agents need to recompile lock files
# (`just setup && just compile`). They're installed on the runner before the
# agent starts because the agent can't install them from inside the AWF
# sandbox: it has no GitHub token for `gh extension install`, and
# api.github.com isn't on its network allowlist. AWF exposes the host's
# binaries and $HOME (where gh keeps extensions) to the agent, so no custom
# runner or container image is needed. See
# https://github.github.com/gh-aw/reference/sandbox/#host-binaries
#
# The gh-aw runtime installs the CLI at the version that compiled the lock
# file, which ci.yml keeps equal to .github/aw/gh-aw-version.
runtimes:
  gh-aw: {}
# Custom steps run outside the sandbox, after checkout; see
# https://github.github.com/gh-aw/reference/steps-jobs/
# bootc-ubuntu-setup is the org's standard host setup; it installs just
# (among other things) and fails on runners other than Ubuntu 24.04/26.04,
# so importing workflows run on ubuntu-26.04.
steps:
  - name: Bootc Ubuntu setup
    uses: bootc-dev/actions/bootc-ubuntu-setup@main
---
