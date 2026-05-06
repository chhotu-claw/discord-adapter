import type { Session } from '@openacp/plugin-sdk'

export interface DiscordPlatformData {
  guildId: string
  channelId: string
  threadId?: string
  messageId?: string
  skillMsgId?: string
  laneKey?: string
  lockedAgent?: boolean
  laneUxMode?: 'streaming' | 'final_only'
  suppressNotifications?: boolean
  controlMsgId?: string
}

export interface DiscordLaneRouteConfig {
  agentName: string
  workingDirectory?: string
  lockAgent?: boolean
}

export interface DiscordChannelConfig {
  enabled: boolean
  botToken: string
  guildId: string
  forumChannelId: string | null
  notificationChannelId: string | null
  assistantThreadId: string | null
  laneRoutes?: Record<string, DiscordLaneRouteConfig>
  outputMode?: 'low' | 'medium' | 'high'
  [key: string]: unknown
}

export interface CommandsAssistantContext {
  threadId: string
  getSession: () => Session | null
  respawn: () => Promise<void>
}
