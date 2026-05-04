import { describe, expect, it, vi } from 'vitest'
import type { TextChannel } from 'discord.js'
import { PermissionHandler } from '../permissions.js'

function createThread() {
  return {
    id: 'thread-1',
    send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  } as unknown as TextChannel
}

describe('PermissionHandler', () => {
  it('keeps permission buttons in-thread and suppresses external notifications when requested', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const handler = new PermissionHandler('guild-1', () => undefined, sendNotification)
    const thread = createThread()

    await handler.sendPermissionRequest(
      { id: 'sess-1', name: 'Lane Session' } as any,
      {
        id: 'perm-1',
        description: 'Allow command?',
        options: [{ id: 'allow', label: 'Allow', isAllow: true }],
      },
      thread,
      false,
    )

    expect(thread.send).toHaveBeenCalledTimes(1)
    expect(sendNotification).not.toHaveBeenCalled()
  })
})
