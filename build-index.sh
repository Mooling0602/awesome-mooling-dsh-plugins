#!/usr/bin/env bash
# Write the plugin market index.
#
# This used to clone the harness, install the harness' own generator, and run it with `--registry` pointing at the
# deployed CloudFlare Workers registry. That made the index depend on the worker while the worker compiles the index in,
# so neither could be built first. The index's real inputs are this repository's metadata and GitHub, both of which are
# reachable without the worker, and `src/index/build.ts` reads them directly.
#
# Kept as a script rather than dropped: CI calls it by name, and it keeps the entry point in one place if a build step
# is ever needed again.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# The packuments are what a tarball-form plugin's versions are read from, so the registry build has to have run first.
if [[ ! -d "$ROOT/dists/registry/packuments" ]]; then
  echo 'error: dists/registry/packuments is missing; run `pnpm registry` first' >&2
  exit 1
fi

node "$ROOT/src/index/build.ts"
