import { describe, expect, it, vi } from 'vitest'
import type { TextChannel } from 'discord.js'
import { MessageDraft } from '../streaming.js'

function createThread() {
  return {
    send: vi.fn().mockResolvedValue({
      id: 'msg-1',
      edit: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as TextChannel
}

function createSendQueue() {
  return {
    enqueue: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
  }
}

describe('MessageDraft', () => {
  it('streams intermediate text in streaming mode', async () => {
    const thread = createThread()
    const sendQueue = createSendQueue()
    const draft = new MessageDraft(thread, sendQueue as any, 'sess-1', 'streaming')

    draft.append('hello')
    await draft.flush()

    expect(thread.send).toHaveBeenCalledTimes(1)
  })

  it('holds text until finalize in final_only mode', async () => {
    const thread = createThread()
    const sendQueue = createSendQueue()
    const draft = new MessageDraft(thread, sendQueue as any, 'sess-1', 'final_only')

    draft.append('hello')
    await draft.flush()

    expect(thread.send).not.toHaveBeenCalled()

    await draft.finalize()

    expect(thread.send).toHaveBeenCalledTimes(1)
    expect(thread.send).toHaveBeenCalledWith({ content: 'hello' })
  })
})
