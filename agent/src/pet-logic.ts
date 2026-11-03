import type { PetGesture, PetState } from '../../src/shared'

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
export function clickSequence(times: number[], now: number) {
  const next = [...times.filter((t) => now - t <= 1000), now]
  return { times: next.length >= 3 ? [] : next, poked: next.length >= 3 }
}
