import type { Message } from 'discord.js'
import type { DiscordLaneRouteConfig } from './types.js'

export interface ResolvedDiscordLaneRoute extends DiscordLaneRouteConfig {
  laneKey: string
}

export function resolveLaneRoute(
  laneRoutes: Record<string, DiscordLaneRouteConfig> | undefined,
  channel: { id: string; name?: string | null },
): ResolvedDiscordLaneRoute | null {
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
  route: Pick<ResolvedDiscordLaneRoute, 'agentName'>,
  message: Pick<Message, 'content'>,
  fallbackLabel = 'new session',
): string {
  const normalized = message.content.replace(/\s+/g, ' ').trim()
  const snippet = normalized ? normalized.slice(0, 60) : fallbackLabel
  return `🔄 ${route.agentName} — ${snippet}`
}
