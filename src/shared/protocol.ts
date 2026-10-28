import type { ShortcutAction } from './index'
/**
 * Wire protocol between the Tauri shell (src-tauri), the agent sidecar (agent/) and the
 * webviews (src/renderer). See docs/architecture.md for the full picture.
 *
 * - Webview → Rust: Tauri command `familiar_invoke(channel, args)` forwards any FamiliarAPI
 *   call (IPC channel names from ./index.ts) to the sidecar and resolves with its response.
 *   Window-local commands stay in Rust: `pet_hit`, `pet_drag_start`.
 * - Rust ↔ sidecar: newline-delimited JSON on the sidecar's stdin/stdout (one object per line).
 *   The sidecar writes logs to stderr only.
 * - Sidecar → webviews: `emit` messages; Rust re-emits them as Tauri events named `channel`.
 */

export type WindowLabel = 'pet' | 'chat' | 'settings' | 'main'

/** Rust → sidecar */
export type ShellToAgent =
  | {
      kind: 'request'
      id: number
      window: WindowLabel | 'tray'
      channel: string
      args: unknown[]
    }
  | { kind: 'signal'; signal: ShellSignal }

export type ShellSignal =
  | { name: 'chat-window'; visible: boolean; focused: boolean }
  | { name: 'main-window'; visible: boolean; focused: boolean }
  /** Shortcuts the system refused to register (already taken). */
  | {
      name: 'shortcut-status'
      failed: { action: ShortcutAction; accelerator: string; error: string }[]
    }
  /** The app became active; refresh things like the accent colour. */
  | { name: 'app-activated' }
  /** The user went to another app: the pet or chat lost focus and no Familiar window has it. */
  | { name: 'blurred' }
  /** Pet overlay drag progress, for the running-left/right animation. */
  | { name: 'pet-drag'; phase: 'move' | 'end'; dx: number }

/** Sidecar → Rust */
export type AgentToShell =
  | { kind: 'response'; id: number; ok: true; value?: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | {
      kind: 'emit'
      channel: string
      payload: unknown
      target: WindowLabel | 'all'
    }
  | { kind: 'ui'; action: UiAction }

export type UiAction =
  | { type: 'show-chat' }
  | { type: 'hide-chat' }
  /** Make the pet panel key so the capsule gets typing and notices when the user leaves. */
  | { type: 'focus-pet' }
  | { type: 'show-settings' }
  /** The standalone conversation window (Familiar appears in the Dock while it is open). */
  | { type: 'show-main' }
  /** (Re)register global shortcuts; an empty accelerator means none. */
  | { type: 'shortcuts'; bindings: Record<ShortcutAction, string> }
  | { type: 'pet-visible'; visible: boolean }
  /** Resize the pet overlay, keeping its bottom-right corner fixed. */
  | { type: 'pet-size'; width: number; height: number }
  /** Rebuild the tray menu. */
  | {
      type: 'tray'
      pets: { id: string; name: string }[]
      currentPet: string
      size: 'small' | 'medium' | 'large'
    }
  | { type: 'quit' }

/**
 * Environment the shell passes to the sidecar:
 * - FAMILIAR_DATA_DIR       ~/.familiar (settings.json, mcp.json, skills/, pets/, window-state.json)
 * - FAMILIAR_RESOURCES_DIR  bundled resources root (contains pets/)
 * Pet assets are served to webviews as familiar-pet://<id>/<file> by Rust from
 * <FAMILIAR_RESOURCES_DIR>/pets/<id>/ or <FAMILIAR_DATA_DIR>/pets/<id>/ (data dir wins only for ids
 * not bundled).
 */
export const SIDECAR_ENV = {
  dataDir: 'FAMILIAR_DATA_DIR',
  resourcesDir: 'FAMILIAR_RESOURCES_DIR',
} as const
