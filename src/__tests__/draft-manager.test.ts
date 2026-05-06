import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { TextChannel } from 'discord.js'
import { DiscordDraftManager } from '../draft-manager.js'

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

describe('DiscordDraftManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-finalizes final_only drafts after a short idle period', async () => {
    const thread = createThread()
    const sendQueue = createSendQueue()
    const manager = new DiscordDraftManager(sendQueue as any)

    const draft = manager.getOrCreate('sess-1', thread, 'final_only')
    draft.append('hello from gemini')
    manager.appendText('sess-1', 'hello from gemini')
    manager.scheduleDeferredFinalize('sess-1', thread, true)

    expect(thread.send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_500)

    expect(thread.send).toHaveBeenCalledTimes(1)
    expect(thread.send).toHaveBeenCalledWith({ content: 'hello from gemini' })
  })

  it('resets the idle timer when more final_only text arrives', async () => {
    const thread = createThread()
    const sendQueue = createSendQueue()
    const manager = new DiscordDraftManager(sendQueue as any)

    const draft = manager.getOrCreate('sess-1', thread, 'final_only')
    draft.append('hello')
    manager.appendText('sess-1', 'hello')
    manager.scheduleDeferredFinalize('sess-1', thread, true)

    await vi.advanceTimersByTimeAsync(2_000)

    draft.append(' world')
    manager.appendText('sess-1', ' world')
    manager.scheduleDeferredFinalize('sess-1', thread, true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(thread.send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(700)
    expect(thread.send).toHaveBeenCalledTimes(1)
    expect(thread.send).toHaveBeenCalledWith({ content: 'hello world' })
  })
})
