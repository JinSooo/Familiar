import { describe, expect, test } from 'bun:test'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deletePet, listPets } from '../src/pets'
import { dataDir, resourcesDir } from '../src/system'

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

describe('deleting pets', () => {
  test('an added pet goes to the trash; bundled and unknown ones are refused', async () => {
    const dir = join(dataDir, 'pets', 'mine')
    await mkdir(dir, { recursive: true })
    await cp(join(resourcesDir, 'pets', 'dango'), dir, { recursive: true })
    const manifest = JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8'))
    await writeFile(
      join(dir, 'pet.json'),
      JSON.stringify({ ...manifest, id: 'mine' }),
    )
    try {
      const pets = await listPets()
      expect(pets.find((p) => p.id === 'mine')?.removable).toBe(true)
      expect(pets.find((p) => p.id === 'dango')?.removable).toBe(false)
      const trashed: string[] = []
      const trash = async (path: string) => {
        trashed.push(path)
      }
      await expect(deletePet('dango', trash)).rejects.toThrow()
      await expect(deletePet('nope', trash)).rejects.toThrow()
      expect(trashed).toEqual([])
      await deletePet('mine', trash)
      expect(trashed).toHaveLength(1)
      expect(trashed[0]!.endsWith('/pets/mine')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
