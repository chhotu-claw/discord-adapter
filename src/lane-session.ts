import type { DiscordPlatformData } from './types.js'

export function shouldSuppressDiscordNotifications(
  platform: DiscordPlatformData | undefined,
): boolean {
  return platform?.suppressNotifications === true
}

export function resolveDiscordDraftMode(
  platform: DiscordPlatformData | undefined,
): 'streaming' | 'final_only' {
  return platform?.laneUxMode === 'final_only' ? 'final_only' : 'streaming'
}

export function shouldFinalizeDiscordDraftBeforeToolCall(
  platform: DiscordPlatformData | undefined,
): boolean {
  return resolveDiscordDraftMode(platform) !== 'final_only'
}
