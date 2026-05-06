import { describe, expect, it } from 'vitest'
import {
  resolveDiscordDraftMode,
  shouldFinalizeDiscordDraftBeforeToolCall,
  shouldSuppressDiscordNotifications,
} from '../lane-session.js'

describe('lane session helpers', () => {
  it('suppresses external notifications when requested', () => {
    expect(shouldSuppressDiscordNotifications({ guildId: '1', channelId: '2', suppressNotifications: true })).toBe(true)
    expect(shouldSuppressDiscordNotifications({ guildId: '1', channelId: '2' })).toBe(false)
  })

  it('uses final_only draft mode for lane sessions', () => {
    expect(resolveDiscordDraftMode({ guildId: '1', channelId: '2', laneUxMode: 'final_only' })).toBe('final_only')
    expect(resolveDiscordDraftMode({ guildId: '1', channelId: '2' })).toBe('streaming')
  })

  it('avoids forced finalize before tool calls in final_only mode', () => {
    expect(shouldFinalizeDiscordDraftBeforeToolCall({ guildId: '1', channelId: '2', laneUxMode: 'final_only' })).toBe(false)
    expect(shouldFinalizeDiscordDraftBeforeToolCall({ guildId: '1', channelId: '2', laneUxMode: 'streaming' })).toBe(true)
  })
})
