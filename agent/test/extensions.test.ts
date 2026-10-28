import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { settingsSchema } from '../../src/shared'
import { decideToolCall } from '../src/permissions'
import {
  mcpFile,
  mcpTools,
  readMcpConfig,
  serverOfTool,
  slug,
  updateMcpServer,
} from '../src/extensions/mcp'
import {
  createSkillTools,
  importSkill,
  listSkills,
  parseSkill,
  skillInstructions,
} from '../src/extensions/skills'

describe('SKILL.md', () => {
  test('front matter: plain, quoted and folded values', () => {
    const s = parseSkill(`---
name: "pdf-tools"
description: >
  Read, merge and split PDFs.
  Use when a PDF is involved.
license: MIT
---
# PDF

Steps…`)
    expect(s).toEqual({
      name: 'pdf-tools',
      description: 'Read, merge and split PDFs. Use when a PDF is involved.',
      body: '# PDF\n\nSteps…',
    })
    expect(parseSkill('no front matter').name).toBe('')
  })

  test('imported skills list first; use_skill returns instructions and files', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'familiar-ws-'))
    await mkdir(join(ws, 'skills', 'notes', 'scripts'), { recursive: true })
    await writeFile(
      join(ws, 'skills', 'notes', 'SKILL.md'),
      '---\nname: notes\ndescription: Keep notes tidy\n---\nDo the thing.',
    )
    await writeFile(join(ws, 'skills', 'notes', 'scripts', 'run.sh'), 'echo hi')
    const skills = (await listSkills(ws)).filter((s) => s.source === 'imported')
    expect(skills.map((s) => s.name)).toEqual(['notes'])
    expect(skillInstructions(skills)).toContain('- notes：Keep notes tidy')
    const out = (await createSkillTools(skills).use_skill!.execute!(
      { name: 'notes' },
      { toolCallId: '1', messages: [] } as never,
    )) as { instructions: string; files: string[] }
    expect(out.instructions).toBe('Do the thing.')
    expect(out.files.sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
  })

  test('imports only from the Claude Code and Codex folders', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'familiar-ws-'))
    await expect(importSkill(ws, '/etc')).rejects.toThrow('只能从')
  })
})

describe('MCP', () => {
  beforeAll(() => mkdir(dirname(mcpFile()), { recursive: true }))
  test('tool names carry the server', () => {
    expect(slug('my server!')).toBe('my_server_')
    expect(serverOfTool('mcp__github__create_issue')).toBe('github')
    expect(serverOfTool('read_file')).toBeUndefined()
  })

  test('config keeps unknown fields and flags bad entries', async () => {
    await writeFile(
      mcpFile(),
      JSON.stringify({
        other: 1,
        mcpServers: {
          a: { command: 'npx', args: ['x'] },
          b: { url: 'https://example.com/mcp', access: 'allow' },
          bad: { nothing: true },
        },
      }),
    )
    const config = await readMcpConfig()
    expect(Object.keys(config.servers)).toEqual(['a', 'b'])
    expect(config.servers.a!.access).toBe('ask')
    expect(Object.keys(config.invalid)).toEqual(['bad'])
    await updateMcpServer('a', (e) => ({ ...e, access: 'off' }))
    expect((await readMcpConfig()).servers.a!.access).toBe('off')
    expect(JSON.parse(await Bun.file(mcpFile()).text()).other).toBe(1)
  })

  test('permission follows the server access and the mode', async () => {
    await writeFile(
      mcpFile(),
      JSON.stringify({
        mcpServers: {
          ask: { command: '/usr/bin/false', access: 'ask' },
          ok: { command: '/usr/bin/false', access: 'allow' },
          no: { command: '/usr/bin/false', access: 'off' },
        },
      }),
    )
    await mcpTools() // loads the config the decisions read (the servers fail to start; fine)
    const settings = settingsSchema.parse({ permissionMode: 'auto' })
    const decide = (name: string, mode = settings) =>
      decideToolCall({ id: '', toolName: name, input: {} }, mode)
    expect(await decide('mcp__ask__x')).toMatchObject({
      decision: 'ask',
      server: 'ask',
    })
    expect((await decide('mcp__ok__x')).decision).toBe('allow')
    expect((await decide('mcp__no__x')).decision).toBe('deny')
    expect(
      (await decide('mcp__ask__x', { ...settings, permissionMode: 'full' }))
        .decision,
    ).toBe('allow')
    expect((await decide('use_skill')).decision).toBe('allow')
  })
})
