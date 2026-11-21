#!/usr/bin/env bash
set -euo pipefail

TITLE=${TITLE:-awesome-mooling-dsh-plugins}
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=https://github.com/deepseek-ai/deepseek-harness.git
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

read_version() {
  curl -fsS --max-time 30 "$1" | node -e '
let raw = ""
process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).version + "\n"))
'
}

VERSION=${DSH_VERSION:-$(read_version https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest)}

if ! curl -fsS --max-time 30 -o /dev/null "https://registry.npmjs.org/@deepseek-ai%2Fdsh-plugin-market-index/$VERSION"; then
  echo "error: @deepseek-ai/dsh-plugin-market-index@$VERSION is not published on npm" >&2
  exit 1
fi
if ! git ls-remote --exit-code --tags "$REPO" "refs/tags/dsh-v$VERSION" >/dev/null; then
  echo "error: tag dsh-v$VERSION does not exist in $REPO" >&2
  exit 1
fi

echo "dsh $VERSION"

git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --sparse \
  --branch "dsh-v$VERSION" "$REPO" "$WORK/harness"
git -C "$WORK/harness" sparse-checkout set apps/plugin-market-generator
cp -r "$WORK/harness/apps/plugin-market-generator" "$WORK/gen"

node - "$WORK/gen/package.json" "$VERSION" <<'JS'
const fs = require('node:fs')
const [file, version] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const field of ['dependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(pkg[field] ?? {})) {
    if (range.startsWith('workspace:')) pkg[field][name] = version
  }
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
JS

cd "$WORK/gen"
npm install --no-audit --no-fund --workspaces=false --fetch-retries=3 --cache "$WORK/npm-cache" >/dev/null
npx tsx src/bin.ts \
  --input "$ROOT/plugins.txt" \
  --output "$ROOT/index.json" \
  --title "$TITLE" \
  --cache "$WORK/cache"
