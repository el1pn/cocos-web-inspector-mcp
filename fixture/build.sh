#!/usr/bin/env bash
# Build the Cocos fixture and vendor it into test/fixtures.
# Usage: fixture/build.sh [creator-version]   (default 3.8.8; macOS, or Git Bash on Windows)
set -euo pipefail

VERSION="${1:-3.8.8}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Never under /tmp: macOS resolves it to /private/tmp and Creator 3.8.x then drops custom scripts ("Missing class").
WORK="${COCOS_FIXTURE_WORK:-$HOME/.cache/cocos-web-inspector-fixture/$VERSION}"
if command -v cygpath >/dev/null; then
  CREATOR="${COCOS_CREATOR:-/c/ProgramData/cocos/editors/Creator/$VERSION/CocosCreator.exe}"
  creator_running() { tasklist //FI "IMAGENAME eq CocosCreator.exe" //NH | grep -qi CocosCreator; }
  native() { cygpath -w "$1"; }
else
  CREATOR="${COCOS_CREATOR:-/Applications/Cocos/Creator/$VERSION/CocosCreator.app/Contents/MacOS/CocosCreator}"
  creator_running() { pgrep -f "^/Applications/Cocos/Creator/.*/CocosCreator\.app/Contents/" >/dev/null; }
  native() { printf '%s' "$1"; }
fi

[ -x "$CREATOR" ] || { echo "Cocos Creator $VERSION not found at $CREATOR (set COCOS_CREATOR)" >&2; exit 1; }
# Another Creator (an editor, or a CI runner that kills every Creator) corrupts headless imports.
if creator_running; then echo "Close every running Cocos Creator first" >&2; exit 1; fi
[ -z "$(git -C "$ROOT" status --porcelain -- fixture)" ] || { echo "Commit fixture/ changes first; provenance records the commit" >&2; exit 1; }

rm -rf "$WORK" && mkdir -p "$WORK"
git -C "$ROOT" archive HEAD fixture | tar -x --strip-components=1 -C "$WORK"
node -e 'const f=process.argv[1],p=require(f);p.creator.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$WORK/package.json" "$VERSION"

vendor() { # config, output dir name, vendored dir, checksum file
  local config="$1" output="$WORK/build/$2" dest="$ROOT/test/fixtures/$3" sums="$4" log="$WORK/$1.log"
  # Creator exits 36 for "built with warnings"; judge the build by its output instead.
  env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE "$CREATOR" --project "$(native "$WORK")" --build "configPath=$(native "$WORK/$config.json")" >"$log" 2>&1 || true
  if grep -q "Missing class" "$log" || grep -rqs '"importer": "\*"' "$WORK/assets"; then echo "Broken import, see $log" >&2; exit 1; fi
  node -e 'const s=require(process.argv[1]);if(!s.engine?.builtinAssets?.length||!s.scripting?.scriptPackages?.length)process.exit(1)' "$output/src/settings.json" \
    || { echo "Build has no scene or scripts, see $log" >&2; exit 1; }

  local keep; keep="$(mktemp -d)"
  for file in README.md COCOS-ENGINE-LICENSE.md fixture-manifest.json "$config.json" fixture-production-provenance.json; do
    [ -f "$dest/$file" ] && cp "$dest/$file" "$keep/"
  done
  rm -rf "$dest" && mkdir -p "$dest"
  (cd "$output" && find . -type f ! -name '*.map' | sed 's|^\./||' | LC_ALL=C sort | while read -r file; do
    mkdir -p "$dest/$(dirname "$file")" && cp "$file" "$dest/$file"
    printf '%s  %s\n' "$(shasum -a 256 "$file" | cut -c1-64)" "$file"
  done) >"$dest/$sums"
  cp "$keep"/* "$dest/" 2>/dev/null || true
  rm -rf "$keep"
  echo "Vendored $(wc -l <"$dest/$sums" | tr -d ' ') files into test/fixtures/$3"
}

if [ "$VERSION" = 3.8.8 ]; then
  vendor build-dev inspector-web cocos-3.8.8 build-checksums.sha256
  vendor build-production inspector-web-production cocos-3.8.8-production build-production-checksums.sha256
else
  vendor build-dev inspector-web "cocos-$VERSION" build-checksums.sha256
fi
echo "Built from fixture commit $(git -C "$ROOT" rev-parse HEAD). Update provenance notes, then run: npm run check"
