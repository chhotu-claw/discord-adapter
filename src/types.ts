import type { Session } from '@openacp/plugin-sdk'

export interface DiscordPlatformData {
  guildId: string
  channelId: string
  threadId?: string
  messageId?: string
  skillMsgId?: string
}

export interface DiscordChannelConfig {
  enabled: boolean
  botToken: string
  guildId: string
  forumChannelId: string | null
  notificationChannelId: string | null
  assistantThreadId: string | null
  outputMode?: 'low' | 'medium' | 'high'
  /** Roots whose immediate subdirectories appear in the /new workspace picker. */
  workspaceRoots?: string[]
  /** Directories pinned as-is in the /new workspace picker. */
  workspacePins?: string[]
  [key: string]: unknown
}

export interface CommandsAssistantContext {
  threadId: string
  getSession: () => Session | null
  respawn: () => Promise<void>
}
