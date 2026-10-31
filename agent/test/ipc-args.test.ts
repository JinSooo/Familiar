import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { optionalArg } from '../src/ipc-args'

describe('optional IPC arguments', () => {
  const text = optionalArg(z.string().trim().min(1).max(300))

  // Regression: clicking 对 on a pending memory sent confirmMemory(id, undefined), which
  // arrived as null and made the agent reject the request.
  test('an omitted argument that went through JSON is read as absent', () => {
    const wire = JSON.parse(JSON.stringify(['m-1', undefined])) as unknown[]
    expect(wire[1]).toBeNull()
    expect(text.parse(wire[1])).toBeUndefined()
  })

  test('undefined and real values still work, bad values still fail', () => {
    expect(text.parse(undefined)).toBeUndefined()
    expect(text.parse('  改过的文字 ')).toBe('改过的文字')
    expect(() => text.parse('')).toThrow()
    expect(() => text.parse(5)).toThrow()
  })
})
