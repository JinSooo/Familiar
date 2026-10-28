# Familiar Tauri shell (T10)

macOS only. Wire types mirror `src/shared/protocol.ts`; TypeScript remains the
contract. Rust owns system integration, while the agent owns business state.

## Integration

Add these scripts to the root `package.json` (outside T10's write scope):

```json
{
  "dev": "tauri dev",
  "build": "tauri build",
  "agent:build": "bun build --compile agent/src/main.ts --outfile src-tauri/binaries/familiar-agent-$(rustc -vV | sed -n 's/^host: //p')"
}
```

This agent command targets the current host. For cross compilation, Bun's
`--target` and the sidecar suffix must both match Tauri's target. On this machine
the output is `binaries/familiar-agent-aarch64-apple-darwin`.

Run `pnpm agent:build` before raw Cargo builds or the first `tauri dev`:
tauri-build validates/copies `externalBin` even for debug. `tauri build` runs it
through `beforeBuildCommand`. Debug actually launches Bun directly, while release
uses the sidecar and needs no installed Bun. The sidecar is a generated artifact,
not a checked-in executable. Rebuild it after the parallel agent task finishes.

Tauri CLI enables `custom-protocol` for production asset embedding. Raw embedded
frontend builds must pass `--features custom-protocol` explicitly.

`FAMILIAR_DATA_DIR` optionally overrides the default `~/.familiar` for isolated
testing (without it, Familiar's files in the old `~/Library/Application
Support/Familiar` are moved there on first launch). The shell creates
it and passes it plus `FAMILIAR_RESOURCES_DIR` to each agent launch. Set
`FAMILIAR_SHOW_DOCK` to retain the Dock icon for automation. Debug needs Bun on PATH.

## Modules and interface

- `main.rs`: plugins, commands, scheme registration, setup and exit cleanup.
- `windows.rs`: NSPanel conversion, placement, effects, size and position,
  close-to-hide, UI actions and focus/visibility signals.
- `hit.rs`: 33 ms main-thread AppKit cursor poll, click-through and native drag.
  Hit testing uses only AppKit mouse/panel frame coordinates.
- `agent.rs`: NDJSON transport, request correlation, 30 s ordinary deadlines,
  unlimited `agent:run`, exit cancellation, exponential backoff and at most five
  restarts in any minute. Child process groups are killed on application exit.
- `tray.rs`: native menus, template tray image, agent-driven menu rebuilding.
- `protocol.rs`: typed incoming messages and confined, CORS-enabled pet resources.

Commands: `familiar_invoke(channel, args)`, `pet_hit(inside)`, `pet_drag_start()`.
The first derives the sender label from Tauri. The latter two reject callers
other than `pet`.

Events: `pet:cursor {x,y}` (CSS pixels, top-left origin, changed coordinates only),
plus unchanged agent `emit.channel` events routed according to `target`.
Signals: `chat-window {visible,focused}`, `app-activated`,
`pet-drag {phase: 'move'|'end', dx}`; end uses `dx: 0`.
Menus send requests with `window: 'tray'` and channels `chat:toggle`,
`settings:open`, `pets:select`, `pet:size-set`, `pets:import`, `app:quit`.

Capabilities allow three local windows, event listen/unlisten, the three custom
commands, and http/https/mailto opener URLs. Shell execution is Rust only;
webviews have no shell execution permission.

`familiar-pet://localhost/<id>/<file>` gives bundled pet ids precedence over user
ids. Missing bundled files do not fall back to user pets with the same id.
Traversal, encoded separators and canonical symlink escapes are rejected.
MIME types cover WebP, PNG and JSON; all responses include CORS headers.

## Verification

```sh
cargo build --offline --manifest-path src-tauri/Cargo.toml
cargo clippy --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --offline --manifest-path src-tauri/Cargo.toml
```

Tests cover protocol parsing, asset traversal/encoding/symlink confinement,
bundled namespace precedence/CORS, long-run deadlines, error correlation, and a
real Bun child echoing a request through NDJSON into the pending response path.
The fake agent is inline and leaves no script behind. This transport test does
not exercise a webview invocation or GUI events.

Native multi-monitor positioning, fullscreen Spaces, drag delivery, vibrancy,
alpha hit testing, real renderer invocations, crash/restart behavior over a full
minute, and app/DMG signing need an integrated macOS acceptance run.
