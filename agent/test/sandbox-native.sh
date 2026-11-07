#!/bin/bash
# Run from the repository root, outside an enclosing sandbox, on macOS.
set -euo pipefail

fixture=$(mktemp -d "$HOME/.familiar-f1-check.XXXXXX")
temporary=''
trap 'rm -rf "$fixture"; if [ -n "$temporary" ]; then rm -f "$temporary"; fi' EXIT
temporary=$(mktemp "${TMPDIR:-/tmp}/familiar-f1.XXXXXX")
export FAMILIAR_DATA_DIR="$fixture/.familiar"
data="$FAMILIAR_DATA_DIR"
mkdir -p "$data"/{workspace/blocked,memory,conversations,knowledge,skills/blocked,perception}
for file in settings.json mcp.json perception/buffer.enc workspace/note.txt workspace/blocked/note.txt memory/note.txt conversations/note.txt knowledge/note.txt skills/note.txt skills/blocked/note.txt 'workspace/Login Data' workspace/logins.json workspace/key4.db; do
  printf 'fixture\n' > "$data/$file"
done
printf 'fixture\n' > "$fixture/plain.txt"

profile() {
  F1_WORKSPACE="$1" bun -e '
    import { sandboxProfile } from "./agent/src/workspace/sandbox";
    import { settingsSchema } from "./src/shared";
    const data = process.env.FAMILIAR_DATA_DIR;
    console.log(await sandboxProfile(settingsSchema.parse({
      workspacePath: process.env.F1_WORKSPACE,
      dirRules: [
        { path: `${data}/workspace/blocked`, access: "deny" },
        { path: `${data}/skills/blocked`, access: "deny" },
      ],
    }), false));
  '
}

probe() {
  local expected="$1" mode="$2" path="$3" actual=deny
  if /usr/bin/sandbox-exec -p "$policy" /bin/sh -c '
    if [ "$1" = read ]; then /bin/cat "$2"; else printf probe >> "$2"; fi
  ' sh "$mode" "$path" > /dev/null 2> "$fixture/error"; then
    actual=allow
  fi
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL: %s %s expected=%s actual=%s\n' "$mode" "${path#"$fixture/"}" "$expected" "$actual"
    cat "$fixture/error"
    exit 1
  fi
  printf 'PASS: %s %s = %s\n' "$mode" "${path#"$fixture/"}" "$actual"
}

for workspace in "$HOME" "$fixture" "$data" "$data/workspace"; do
  printf '\nWorkspace: %s\n' "$workspace"
  policy=$(profile "$workspace")
  # Positive controls also detect profile compilation or sandbox_apply failures.
  probe allow read "$data/workspace/note.txt"
  probe allow write "$data/workspace/note.txt"
  probe allow read "$temporary"
  probe allow write "$temporary"
  for file in settings.json mcp.json perception/buffer.enc workspace/blocked/note.txt skills/blocked/note.txt 'workspace/Login Data' workspace/logins.json workspace/key4.db; do
    probe deny read "$data/$file"
    probe deny write "$data/$file"
  done
  for dir in memory conversations knowledge skills; do
    probe allow read "$data/$dir/note.txt"
    probe deny write "$data/$dir/note.txt"
  done
done

for dir in memory conversations knowledge skills; do
  policy=$(profile "$data/$dir")
  probe allow read "$fixture/plain.txt"
  probe allow read "$data/$dir/note.txt"
  probe deny write "$data/$dir/note.txt"
done

# Real credential checks open existing files only; no bytes are printed or modified.
policy=$(profile "$HOME")
open_file='import { openSync, closeSync, constants } from "node:fs"; closeSync(openSync(process.argv[1], process.argv[2] === "read" ? constants.O_RDONLY : constants.O_WRONLY));'
/usr/bin/sandbox-exec -p "$policy" "$(command -v bun)" -e "$open_file" "$fixture/plain.txt" read
/usr/bin/sandbox-exec -p "$policy" "$(command -v bun)" -e "$open_file" "$fixture/plain.txt" write
for secret in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa" "$HOME/Library/Keychains/login.keychain-db" "$HOME/.gnupg/pubring.kbx"; do
  for mode in read write; do
    if ! bun -e "$open_file" "$secret" "$mode" >/dev/null 2>&1; then
      printf 'SKIP: credential %s %s (not accessible outside sandbox)\n' "$secret" "$mode"
      continue
    fi
    if /usr/bin/sandbox-exec -p "$(profile "$HOME")" "$(command -v bun)" -e "$open_file" "$secret" "$mode" >/dev/null 2> "$fixture/error"; then
      printf 'FAIL: credential %s allowed %s\n' "$secret" "$mode"
      exit 1
    fi
    printf 'PASS: credential %s denied %s\n' "$secret" "$mode"
  done
done
printf '\nNative sandbox checks passed.\n'
