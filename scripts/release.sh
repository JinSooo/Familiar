#!/bin/sh
# Publishes a release to GitHub: builds the app with update archives signed by the update key,
# writes latest.json (what installed copies check daily), tags HEAD as v<version> and uploads the
# dmg, the update archive and latest.json. Usage: pnpm release <notes.md>
#
# The update key lives outside the repo (default ~/.tauri/familiar.key, or FAMILIAR_UPDATE_KEY).
# Lose it and installed copies can never update again; keep a backup.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
notes=${1:?usage: pnpm release <notes.md>}
[ -f "$notes" ] || { echo "No notes file: $notes" >&2; exit 1; }
key=${FAMILIAR_UPDATE_KEY:-$HOME/.tauri/familiar.key}
[ -f "$key" ] || { echo "No update key at $key" >&2; exit 1; }

version=$(node -p "require('./package.json').version")
conf=$(node -p "require('./src-tauri/tauri.conf.json').version")
cargo=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
if [ "$version" != "$conf" ] || [ "$version" != "$cargo" ]; then
  echo "Versions differ: package.json $version, tauri.conf.json $conf, Cargo.toml $cargo" >&2
  exit 1
fi
tag="v$version"
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash changes first" >&2
  exit 1
fi
git fetch -q origin main --tags
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "HEAD is not origin/main; push first" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists; bump the version" >&2
  exit 1
fi

TAURI_SIGNING_PRIVATE_KEY=$(cat "$key")
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'

bundle=src-tauri/target/release/bundle
dmg="$bundle/dmg/Familiar_${version}_aarch64.dmg"
archive="$bundle/macos/Familiar.app.tar.gz"
latest="$bundle/latest.json"
for f in "$dmg" "$archive" "$archive.sig"; do
  [ -f "$f" ] || { echo "Build output missing: $f" >&2; exit 1; }
done
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
VERSION=$version SIG=$(cat "$archive.sig") \
  URL="https://github.com/$repo/releases/download/$tag/Familiar.app.tar.gz" \
  node -e '
    const { VERSION, SIG, URL } = process.env
    process.stdout.write(JSON.stringify({
      version: VERSION,
      pub_date: new Date().toISOString(),
      platforms: { "darwin-aarch64": { signature: SIG, url: URL } },
    }, null, 2) + "\n")
  ' >"$latest"

git tag -a "$tag" -m "Familiar $version"
git push -q origin "$tag"
gh release create "$tag" "$dmg" "$archive" "$latest" \
  --title "Familiar $version" --notes-file "$notes" --verify-tag
