import { describe, expect, test } from 'bun:test'
import { computerStep } from '../src/computer'
import { modelHistory } from '../src/session'

// Reported 2026-11-06: the next turn did not see the previous turn's steps, so the model said
// it had never opened WeChat (it had) and invented a sandbox block.
describe('earlier turns carry what they did', () => {
  test('a reply goes to the model with its steps and their first result line', () => {
    const history = modelHistory({
      messages: [
        { role: 'user', content: '打开微信', createdAt: 0 },
        { role: 'assistant', content: '微信已打开。', createdAt: 1 },
        { role: 'user', content: '继续', createdAt: 2 },
      ],
      tools: [
        {
          id: 'a',
          name: '打开 com.tencent.xinWeChat',
          done: true,
          turn: 1,
          output: '已在后台打开「WeChat」\n\n现在「WeChat」的窗口…',
        },
        { id: 'b', name: '点击 「新枝小助手」', done: true, turn: 1 },
      ],
    })
    expect(history[1]?.content).toBe(
      '微信已打开。\n\n［系统记录：这一轮实际执行过的操作］\n1. 打开 com.tencent.xinWeChat → 已在后台打开「WeChat」\n2. 点击 「新枝小助手」',
    )
    expect(history[0]?.content).toBe('打开微信')
  })
  test('a stopped turn with steps but no text still tells the model what ran', () => {
    const history = modelHistory({
      messages: [
        { role: 'user', content: '点一下', createdAt: 0 },
        { role: 'assistant', content: '', createdAt: 1 },
      ],
      tools: [{ id: 'a', name: '点击 「发送」', done: true, turn: 1 }],
    })
    expect(history).toHaveLength(2)
    expect(history[1]?.content).toContain('1. 点击 「发送」')
  })
})

// Reported 2026-11-06: typing 「小黑来过」 showed as 「输入『第二行』」, the field's old text.
test('the typing step names what was typed', () => {
  expect(computerStep('type_text', { text: '小黑来过', element: 1 })).toBe(
    '输入 「小黑来过」',
  )
})
