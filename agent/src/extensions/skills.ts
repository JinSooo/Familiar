import { cp, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SkillInfo } from '../../../src/shared'
import { moveToTrash } from '../system'

/**
 * Skills in the SKILL.md format Claude Code and Codex use: a folder with YAML front matter
 * (name, description) and instructions, plus any files they mention. The model only sees names
 * and descriptions until it calls use_skill. Sources: `<workspace>/skills/` (imported, owned
 * by Familiar) and `~/.agents/skills/` (the shared folder, read in place).
 */
export const sharedSkillsDir = () => join(homedir(), '.agents', 'skills')
export const importSources = () => [
  { label: 'Claude Code', dir: join(homedir(), '.claude', 'skills') },
  { label: 'Codex', dir: join(homedir(), '.codex', 'skills') },
]

export function parseSkill(text: string): {
  name: string
  description: string
  body: string
} {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const fields: Record<string, string> = {}
  if (front) {
    const lines = front[1]!.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!)
      if (!m) continue
      let value = m[2]!.trim()
      // Block scalars (description: > / |): the indented lines that follow.
      if (/^[>|][+-]?$/.test(value)) {
        const block: string[] = []
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!))
          block.push(lines[++i]!.trim())
        value = block.join(value.startsWith('|') ? '\n' : ' ')
      }
      fields[m[1]!.toLowerCase()] = value.replace(/^(['"])([\s\S]*)\1$/, '$2')
    }
  }
  return {
    name: fields.name ?? '',
    description: fields.description ?? '',
    body: (front ? text.slice(front[0].length) : text).trim(),
  }
}

async function scan(
  dir: string,
  source: SkillInfo['source'],
): Promise<SkillInfo[]> {
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const skills: SkillInfo[] = []
  for (const folder of names.sort()) {
    const path = join(dir, folder)
    try {
      const parsed = parseSkill(await readFile(join(path, 'SKILL.md'), 'utf8'))
      skills.push({
        name: parsed.name || folder,
        description: parsed.description.slice(0, 1000),
        source,
        path,
      })
    } catch {
      /* Not a skill folder. */
    }
  }
  return skills
}

/** Imported skills first; a shared skill with the same name is hidden behind the imported one. */
export async function listSkills(workspace: string): Promise<SkillInfo[]> {
  const own = await scan(join(workspace, 'skills'), 'imported')
  const shared = await scan(sharedSkillsDir(), 'shared')
  return [...own, ...shared.filter((s) => !own.some((o) => o.name === s.name))]
}

export async function skillCandidates(workspace: string) {
  const have = new Set((await listSkills(workspace)).map((s) => s.name))
  const out: (SkillInfo & { from: string; exists: boolean })[] = []
  for (const { label, dir } of importSources())
    for (const s of await scan(dir, 'imported'))
      out.push({ ...s, from: label, exists: have.has(s.name) })
  return out
}

export async function importSkill(
  workspace: string,
  path: string,
): Promise<void> {
  if (!importSources().some(({ dir }) => !relative(dir, path).startsWith('..')))
    throw new Error('只能从 Claude Code 或 Codex 的 skills 目录导入')
  const { name } = parseSkill(await readFile(join(path, 'SKILL.md'), 'utf8'))
  const folder = (name || path.split('/').at(-1) || '').replace(
    /[^\p{L}\p{N}._-]+/gu,
    '-',
  )
  if (!folder) throw new Error('技能名无效')
  const target = join(workspace, 'skills', folder)
  if (
    await stat(target).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`已经有一个叫 ${folder} 的技能`)
  // Copies, not links: the imported copy is Familiar's own and stays in its git history.
  await cp(path, target, { recursive: true, dereference: true })
}

export async function removeSkill(
  workspace: string,
  path: string,
): Promise<void> {
  if (relative(join(workspace, 'skills'), path).startsWith('..'))
    throw new Error('共享目录里的技能不能在这里删除，只能停用')
  await moveToTrash(path)
}

async function filesOf(dir: string, limit = 60): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (out.length >= limit || entry.name.startsWith('.')) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(relative(dir, full))
    }
  }
  await walk(dir)
  return out
}

export function skillInstructions(skills: SkillInfo[]): string {
  if (!skills.length) return ''
  let used = 0
  const lines: string[] = []
  for (const s of skills) {
    const line = `- ${s.name}：${s.description.replace(/\s+/g, ' ').slice(0, 200)}`
    if (used + line.length > 5000) break
    used += line.length
    lines.push(line)
  }
  return `技能（Skill）：下面的任务说明书可以按需取用。用户的请求和某个技能的描述对得上时，先用 use_skill 读它的完整说明，再照着做；说明里提到的文件用绝对路径读取或执行。
${lines.join('\n')}`
}

export function createSkillTools(skills: SkillInfo[]): ToolSet {
  return {
    use_skill: tool({
      description:
        '读取一个技能的完整说明和它目录里的文件列表。name 用技能列表里的名字。',
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        const skill = skills.find((s) => s.name === name)
        if (!skill) return { error: `没有叫 ${name} 的技能` }
        try {
          const { body } = parseSkill(
            await readFile(join(skill.path, 'SKILL.md'), 'utf8'),
          )
          return {
            name: skill.name,
            dir: skill.path,
            instructions:
              body.length > 20000 ? `${body.slice(0, 20000)}…` : body,
            files: await filesOf(skill.path),
          }
        } catch (error) {
          return { error: String(error) }
        }
      },
    }),
  }
}
