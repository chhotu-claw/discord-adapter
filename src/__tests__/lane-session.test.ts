import { describe, expect, it } from 'vitest'
import {
  resolveDiscordDraftMode,
  shouldFinalizeDiscordDraftBeforeToolCall,
  shouldSuppressDiscordNotifications,
} from '../lane-session.js'

describe('lane session helpers', () => {
  it('uses final_only drafts for lane-routed Gemini sessions', () => {
    expect(resolveDiscordDraftMode({ laneUxMode: 'final_only' } as any)).toBe('final_only')
  })

  it('keeps streaming drafts for normal sessions', () => {
    expect(resolveDiscordDraftMode(undefined)).toBe('streaming')
  })

  it('suppresses notification fan-out only when lane metadata asks for it', () => {
    expect(shouldSuppressDiscordNotifications({ suppressNotifications: true } as any)).toBe(true)
    expect(shouldSuppressDiscordNotifications(undefined)).toBe(false)
  })

  it('keeps buffered text intact across tool calls for final_only lane sessions', () => {
    expect(shouldFinalizeDiscordDraftBeforeToolCall({ laneUxMode: 'final_only' } as any)).toBe(false)
    expect(shouldFinalizeDiscordDraftBeforeToolCall(undefined)).toBe(true)
  })
})
