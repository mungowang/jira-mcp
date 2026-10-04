#!/usr/bin/env bash
# Run the upstream Zephyr test suite against *our vendored source* in a clean temp dir.
# This is the reproducible evidence that vendoring did not change behaviour. See NOTICE.md.
#
#   bash scripts/verify-vendor.sh
#
# Expected: all 17 behavioural test files green (~1175 cases).
# The only skipped files are version.test.ts and docsConsistency.test.ts, which read
# README.md / server.json / src/index.ts - deliberately not vendored (the entry point
# is register.ts instead).
set -euo pipefail

UPSTREAM_REPO="https://github.com/vilaabo/zephyr-scale-mcp.git"
UPSTREAM_COMMIT="9c43dc5080f776f69ef7f7a25222833e79347057"   # keep in sync with NOTICE.md
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/zverify.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "workdir: $WORK"
echo "-> cloning upstream @ ${UPSTREAM_COMMIT:0:8}"
git clone -q "$UPSTREAM_REPO" "$WORK/upstream"
git -C "$WORK/upstream" checkout -q "$UPSTREAM_COMMIT"

mkdir -p "$WORK/run"
cp "$WORK/upstream/package.json" "$WORK/upstream/tsconfig.json" "$WORK/upstream/vitest.config.ts" "$WORK/run/" 2>/dev/null || true
cp -r "$WORK/upstream/test" "$WORK/run/"

echo "-> replacing the source under test with our vendored copy"
mkdir -p "$WORK/run/src"
cp -r "$HERE/src/entities/zephyr/." "$WORK/run/src/"
rm -f "$WORK/run/src/register.ts" "$WORK/run/src/LICENSE"

echo "-> rewriting relative imports in the tests (.js -> .ts) to match the vendored source"
find "$WORK/run/test" -name '*.ts' -print0 | xargs -0 sed -i.bak -E "s|(from '(\.\.?/)[^']*)\.js'|\1.ts'|g"
find "$WORK/run/test" -name '*.bak' -delete

# Keep the suite from depending on files that were not vendored.
python3 - "$WORK/run" <<'PY'
import json, sys, pathlib
root = pathlib.Path(sys.argv[1])
pkg = json.loads((root / 'package.json').read_text())
pkg['name'], pkg['version'] = 'zverify', '0.0.0'
pkg['scripts'] = {'test': 'vitest run'}
json.dump(pkg, (root / 'package.json').open('w'), indent=2)
# Behavioural tests only: skip the packaging and docs-consistency tests that read
for name in ('version.test.ts', 'docsConsistency.test.ts'):
    p = root / 'test' / name
    if p.exists():
        p.unlink()
        print(f'skipping (needs a non-vendored file): test/{name}')
PY

echo "-> installing dependencies and running the upstream suite"
cd "$WORK/run"
npm install --silent
npx vitest run 2>&1 | tail -12
