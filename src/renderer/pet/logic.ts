import type { PetGesture, PetSkin, PetState, Settings } from '../../shared'

export const scales = { small: 0.5, medium: 0.73, large: 0.95 }
export function petDimensions(size: Settings['pet']['size']) {
  return {
    width: Math.ceil((460 * scales[size]) / 0.73),
    height: Math.ceil((330 * scales[size]) / 0.73),
  }
}
export function atlasVersion(width: number, height: number): 1 | 2 | undefined {
  return width === 1536
    ? height === 1872
      ? 1
      : height === 2288
        ? 2
        : undefined
    : undefined
}
/** Relative asset paths only. Also reject encoded separators and traversal. */
export function validAssetPath(path: string): boolean {
  try {
    const decoded = decodeURIComponent(path)
    return (
      decoded === path &&
      !/[\\:?#]/.test(path) &&
      ![...path].some((c) => c.charCodeAt(0) < 32) &&
      path.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
    )
  } catch {
    return false
  }
}
const priority: PetState[] = [
  'needs-you',
  'failed',
  'thinking',
  'talking',
  'done',
  'listening',
  'sleeping',
  'idle',
]
export function resolveState(
  active: Partial<Record<PetState, boolean>>,
  gesture?: PetGesture,
): PetState | PetGesture {
  return gesture ?? priority.find((s) => active[s]) ?? 'idle'
}
export type Action = PetState | PetGesture | 'running-left' | 'running-right'
export function animation(action: Action, skin?: PetSkin) {
  const extra = skin?.extension?.rows[action]
  if (extra)
    return {
      ...extra,
      loop: ['wave', 'jump', 'petted', 'poked', 'failed'].includes(action)
        ? false
        : extra.loop,
      source: 'extension' as const,
      fps: 8,
      opacity: 1,
    }
  const rows: Record<Action, [number, number, boolean]> = {
    idle: [0, 6, true],
    'running-right': [1, 8, true],
    'running-left': [2, 8, true],
    wave: [3, 4, false],
    jump: [4, 5, false],
    petted: [4, 5, false],
    poked: [4, 5, false],
    failed: [5, 8, false],
    'needs-you': [6, 6, true],
    thinking: [7, 6, true],
    talking: [7, 6, true],
    done: [8, 6, true],
    listening: [0, 6, true],
    sleeping: [0, 1, true],
  }
  const [row, frames, loop] = rows[action]
  return {
    row,
    frames,
    loop,
    source: 'base' as const,
    fps: action.startsWith('running-') ? 12 : action === 'sleeping' ? 2 : 8,
    opacity: action === 'sleeping' ? 0.7 : 1,
  }
}
export function clickSequence(times: number[], now: number) {
  const next = [...times.filter((t) => now - t <= 1000), now]
  return { times: next.length >= 3 ? [] : next, poked: next.length >= 3 }
}
export interface Sweep {
  x: number
  direction: number
  reversals: number[]
}
export function sweep(previous: Sweep, x: number, now: number) {
  if (Math.abs(x - previous.x) < 3) return { ...previous, petted: false }
  const direction = Math.sign(x - previous.x)
  const reversals = previous.reversals.filter((t) => now - t <= 1500)
  if (previous.direction && direction !== previous.direction)
    reversals.push(now)
  const petted = reversals.length >= 3
  return { x, direction, reversals: petted ? [] : reversals, petted }
}
