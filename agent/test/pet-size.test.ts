import { describe, expect, test } from 'bun:test'
import { petDimensions, settingsSchema, trayTier } from '../../src/shared'

// Asked for 2026-11-02: size and speed take any value in a range; the named ones stay as presets.
describe('pet size and speed', () => {
  test('settings written with the old names read as numbers', () => {
    const pet = settingsSchema.parse({
      pet: { size: 'large', speed: 'slow' },
    }).pet
    expect([pet.scale, pet.rate]).toEqual([0.95, 0.6])
  })
  test('defaults, a custom value, and the range', () => {
    const fresh = settingsSchema.parse({}).pet
    expect([fresh.scale, fresh.rate]).toEqual([0.73, 1])
    expect(
      settingsSchema.parse({ pet: { scale: 1.1, rate: 1.25 } }).pet,
    ).toMatchObject({ scale: 1.1, rate: 1.25 })
    expect(() => settingsSchema.parse({ pet: { scale: 2 } })).toThrow()
    expect(() => settingsSchema.parse({ pet: { rate: 0.1 } })).toThrow()
  })
  test('the menu bar checks a size only when it is exactly one of the three', () => {
    expect(trayTier(0.5)).toBe('small')
    expect(trayTier(0.95)).toBe('large')
    expect(trayTier(0.6)).toBe('custom')
  })
  test('the pet window grows with the scale', () => {
    expect(petDimensions(1.3).width).toBeGreaterThan(petDimensions(0.5).width)
  })
})

// P6 (2026-11-06): only a real first run asks for the pet's name.
describe('naming the pet', () => {
  test('a fresh install has not named it; settings from before naming existed have', () => {
    expect(settingsSchema.parse({}).pet.named).toBe(false)
    expect(settingsSchema.parse({ pet: { name: '小黑' } }).pet.named).toBe(true)
    expect(
      settingsSchema.parse({ pet: { name: '小黑', named: false } }).pet.named,
    ).toBe(false)
  })
})
