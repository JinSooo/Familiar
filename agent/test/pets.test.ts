import { describe, expect, test } from 'bun:test'
import { listPets } from '../src/pets'

// resourcesDir defaults to ./resources, the bundled pets the app ships with.
describe('bundled pets', () => {
  test('every bundled pet loads, v2 atlases included', async () => {
    const pets = await listPets()
    const byId = new Map(pets.map((p) => [p.id, p]))
    expect(byId.get('xiaohei-q')?.version).toBe(1)
    for (const id of ['dango', 'momo', 'matsuko']) {
      expect(byId.get(id)?.version).toBe(2)
      expect(byId.get(id)?.displayName).toBeTruthy()
    }
  })
})
