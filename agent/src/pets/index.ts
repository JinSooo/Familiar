import { dataDir, moveToTrash, resourcesDir } from '../system'
import { cp, mkdir, readdir, readFile, realpath, lstat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { skinExtensionSchema, type PetSkin } from '../../../src/shared'
import { atlasVersion, validAssetPath } from '../pet-logic'

const manifest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  displayName: z.string(),
  description: z.string(),
  spritesheetPath: z.string(),
})
const library = new Map<
  string,
  { directory: string; skin: PetSkin; files: Set<string> }
>()
const roots = () => [join(resourcesDir, 'pets'), join(dataDir, 'pets')]
async function contained(directory: string, file: string) {
  if (!validAssetPath(file)) throw new Error('Invalid pet asset path')
  const root = await realpath(directory)
  const target = await realpath(join(root, file))
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Pet asset escapes library')
  return target
}
/**
 * Reads PNG/WebP dimensions from the file header. nativeImage cannot decode WebP on macOS,
 * and ChatGPT pets ship as WebP.
 */
async function imageSize(
  path: string,
): Promise<{ width: number; height: number }> {
  const b = await readFile(path)
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (
    b.length > 30 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = b.toString('ascii', 12, 16)
    if (chunk === 'VP8X')
      return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8 ')
      return {
        width: b.readUInt16LE(26) & 0x3fff,
        height: b.readUInt16LE(28) & 0x3fff,
      }
  }
  return { width: 0, height: 0 }
}
const url = (id: string, file: string) =>
  `familiar-pet://localhost/${id}/${file.split('/').map(encodeURIComponent).join('/')}`
export async function listPets(): Promise<PetSkin[]> {
  library.clear()
  for (const root of roots()) {
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      try {
        const directory = await contained(root, dir.name)
        const data = manifest.parse(
          JSON.parse(
            await readFile(await contained(directory, 'pet.json'), 'utf8'),
          ),
        )
        // The bundled default remains authoritative.
        if (library.has(data.id)) continue
        const atlas = await contained(directory, data.spritesheetPath)
        const { width, height } = await imageSize(atlas)
        const version = atlasVersion(width, height)
        if (!version) throw new Error('Unsupported pet atlas size')
        const skin: PetSkin = {
          ...data,
          version,
          spritesheetUrl: url(data.id, data.spritesheetPath),
          // Only what the user added lives in the data folder; the bundled pets stay.
          removable: root === roots()[1],
        }
        const files = new Set([data.spritesheetPath])
        try {
          const extra = skinExtensionSchema.parse(
            JSON.parse(
              await readFile(
                await contained(directory, 'familiar.json'),
                'utf8',
              ),
            ),
          )
          const size = await imageSize(await contained(directory, extra.sheet))
          if (
            size.width !== 1536 ||
            size.height % 208 !== 0 ||
            size.height === 0 ||
            Object.values(extra.rows).some(
              (row) => row.row >= size.height / 208,
            )
          )
            throw new Error('Invalid extension grid')
          skin.extension = {
            sheetUrl: url(data.id, extra.sheet),
            rows: extra.rows,
          }
          files.add(extra.sheet)
        } catch {
          /* Optional extension can arrive later; base sheet stays usable. */
        }
        library.set(data.id, { directory, skin, files })
      } catch (error) {
        console.warn('Skipping invalid pet', dir.name, error)
      }
    }
  }
  return [...library.values()].map((item) => item.skin)
}
export function currentSkin(id: string): PetSkin {
  const skin = library.get(id)?.skin ?? library.get('xiaohei-q')?.skin
  if (!skin) throw new Error('Default pet skin is missing')
  return skin
}
/**
 * What the 自己做一只 button copies: the bundled skill's path and where the pet goes, for the
 * user to paste into Codex or Claude Code with their own description.
 */
export function petCreatePrompt() {
  const skill = join(resourcesDir, 'pet-creator', 'SKILL.md')
  return `按 ${skill} 的步骤，帮我做一只 Familiar 桌宠，做好后放进 ${roots()[1]}。\n\n它的样子：`
}
/** Moves a pet the user added to the Trash (so it can be put back); the bundled ones stay. */
export async function deletePet(
  id: string,
  trash: (path: string) => Promise<void> = moveToTrash,
) {
  const item = library.get(id)
  if (!item) throw new Error('找不到这只宠物')
  if (!item.skin.removable) throw new Error('内置宠物不能删除')
  await trash(item.directory)
  library.delete(id)
}
export async function importCodexPets() {
  const source = join(homedir(), '.codex/pets')
  const target = roots()[1]!
  await mkdir(target, { recursive: true })
  for (const dir of await readdir(source, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!dir.isDirectory() || !validAssetPath(dir.name)) continue
    // Never overwrite an existing imported skin or follow source symlinks.
    await cp(join(source, dir.name), join(target, dir.name), {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: async (path) => !(await lstat(path)).isSymbolicLink(),
    })
  }
  return listPets()
}
