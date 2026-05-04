import type { Message } from 'discord.js'
import type { DiscordLaneRoute } from './types.js'

export interface ResolvedLaneRoute extends DiscordLaneRoute {
  laneKey: string
}

export function resolveLaneRoute(
  laneRoutes: Record<string, DiscordLaneRoute> | undefined,
  channel: { id: string; name?: string | null },
): ResolvedLaneRoute | null {
  if (!laneRoutes) return null

  const byId = laneRoutes[channel.id]
  if (byId) {
    return { laneKey: channel.id, ...byId }
  }

  const name = channel.name?.trim()
  if (name) {
    const byName = laneRoutes[name]
    if (byName) {
      return { laneKey: name, ...byName }
    }
  }

  return null
}

export function buildLaneThreadName(
  route: { agentName: string },
  message: Pick<Message, 'content'>,
  fallbackLabel = 'new session',
): string {
  const normalized = message.content.replace(/\s+/g, ' ').trim()
  const snippet = normalized ? normalized.slice(0, 60) : fallbackLabel
  return `🔄 ${route.agentName} — ${snippet}`
}
