#!/bin/bash
# Determine the next release version by reading git tags.
# This project uses v0.x.0 minor releases.
set -euo pipefail

latest=$(git tag --list 'v*' --sort=-v:refname | head -1)

if [ -z "$latest" ]; then
    echo "v0.1.0"
    exit 0
fi

# Strip leading 'v', split on '.', bump minor, reset patch
IFS='.' read -r major minor _patch <<< "${latest#v}"
echo "v${major}.$((minor + 1)).0"
