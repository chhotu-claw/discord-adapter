import type { OpenACPPlugin, InstallContext, OpenACPCore } from '@openacp/plugin-sdk'
import type { DiscordChannelConfig } from './types.js'

function createDiscordPlugin(): OpenACPPlugin {
  let adapter: { stop(): Promise<void> } | null = null

  return {
    name: '@openacp/discord-adapter',
    version: '0.1.0',
    description: 'Discord adapter with forum threads',
    essential: false,
    pluginDependencies: {
      '@openacp/security': '^1.0.0',
      '@openacp/notifications': '^1.0.0',
    },
    optionalPluginDependencies: {
      '@openacp/speech': '^1.0.0',
    },
    permissions: ['services:register', 'kernel:access', 'events:read'],

    async install(ctx: InstallContext) {
      const { terminal, settings } = ctx
      const legacyConfig = (ctx as InstallContext & {
        legacyConfig?: {
          channels?: Record<string, unknown>
        }
      }).legacyConfig

      // Migrate from legacy config if present
      if (legacyConfig) {
        const ch = legacyConfig.channels as Record<string, unknown> | undefined
        const discordCfg = ch?.discord as Record<string, unknown> | undefined
        if (discordCfg?.botToken) {
          await settings.setAll({
            botToken: discordCfg.botToken,
            guildId: discordCfg.guildId,
            forumChannelId: discordCfg.forumChannelId ?? null,
            notificationChannelId: discordCfg.notificationChannelId ?? null,
            assistantThreadId: discordCfg.assistantThreadId ?? null,
            laneRoutes: discordCfg.laneRoutes ?? {},
          })
          terminal.log.success('Discord settings migrated from legacy config')
          return
        }
      }

      // Interactive setup via terminal
      const { validateDiscordToken } = await import('./validators.js')

      terminal.note(
        '1. Create app at https://discord.com/developers/applications\n' +
        '2. Go to Bot > Reset Token > copy it\n' +
        '3. Enable Message Content Intent (Bot > Privileged Intents)\n' +
        '4. OAuth2 > URL Generator > scopes: bot + applications.commands\n' +
        '5. Bot Permissions: Manage Channels, Send Messages, Manage Threads, Attach Files\n' +
        '6. Open generated URL > invite bot to your server',
        'Discord Setup',
      )

      let botToken = ''
      while (true) {
        botToken = await terminal.text({
          message: 'Bot token (from Discord Developer Portal):',
          validate: (val) => {
            if (!val.trim()) return 'Token cannot be empty'
            return undefined
          },
        })
        botToken = botToken.trim()

        const spin = terminal.spinner()
        spin.start('Validating token...')
        const result = await validateDiscordToken(botToken)
        if (result.ok) {
          spin.stop(`Connected as @${result.username} (id: ${result.id})`)
          break
        }
        spin.fail(result.error)
        const action = await terminal.select({
          message: 'What to do?',
          options: [
            { label: 'Re-enter token', value: 'retry' },
            { label: 'Use as-is (skip validation)', value: 'skip' },
          ],
        })
        if (action === 'skip') break
      }

      const guildId = await terminal.text({
        message: 'Guild (server) ID:',
        validate: (val) => {
          const trimmed = val.trim()
          if (!trimmed) return 'Guild ID cannot be empty'
          if (!/^\d{17,20}$/.test(trimmed)) return 'Guild ID must be a numeric Discord snowflake (17-20 digits)'
          return undefined
        },
      })

      await settings.setAll({
        botToken,
        guildId: guildId.trim(),
        forumChannelId: null,
        notificationChannelId: null,
        assistantThreadId: null,
        laneRoutes: {},
      })
      terminal.log.success('Discord settings saved')
    },

    async configure(ctx: InstallContext) {
      const { terminal, settings } = ctx
      const current = await settings.getAll()

      const choice = await terminal.select({
        message: 'What to configure?',
        options: [
          { value: 'token', label: 'Change bot token' },
          { value: 'guildId', label: 'Change guild ID' },
          { value: 'done', label: 'Done' },
        ],
      })

      if (choice === 'token') {
        const token = await terminal.text({
          message: 'New bot token:',
          validate: (v) => (!v.trim() ? 'Token cannot be empty' : undefined),
        })
        await settings.set('botToken', token.trim())
        terminal.log.success('Bot token updated')
      } else if (choice === 'guildId') {
        const val = await terminal.text({
          message: 'New guild ID:',
          defaultValue: (current.guildId as string) ?? '',
          validate: (v) => {
            const trimmed = v.trim()
            if (!trimmed) return 'Guild ID cannot be empty'
            if (!/^\d{17,20}$/.test(trimmed)) return 'Guild ID must be a numeric Discord snowflake (17-20 digits)'
            return undefined
          },
        })
        await settings.set('guildId', val.trim())
        terminal.log.success('Guild ID updated')
      }
    },

    async uninstall(ctx: InstallContext, opts: { purge: boolean }) {
      if (opts.purge) {
        await ctx.settings.clear()
        ctx.terminal.log.success('Discord settings cleared')
      }
    },

    async setup(ctx) {
      const config = ctx.pluginConfig as Record<string, unknown>
      if (!config.botToken || !config.guildId) {
        ctx.log.info('Discord disabled (missing botToken or guildId)')
        return
      }

      const core = ctx.core as OpenACPCore

      // Create a SettingsAPI scoped to this plugin so the adapter can persist
      // channel IDs and other runtime state to plugin settings instead of core config.
      const settingsAPI = (core as any).settingsManager?.createAPI(ctx.pluginName)
      if (!settingsAPI) {
        ctx.log.warn('SettingsManager not available — plugin settings will not persist')
      }

      // If channel IDs are null in plugin settings but present in main config, migrate them.
      // This handles users who ran a version where ensureForums saved to main config instead of plugin settings.
      if ((config.forumChannelId == null || config.notificationChannelId == null) && settingsAPI) {
        const fullConfig = core.configManager.get() as Record<string, any>
        const legacy = (fullConfig.channels?.discord ?? {}) as Record<string, unknown>
        let migrated = false
        if (legacy.forumChannelId != null && config.forumChannelId == null) {
          config.forumChannelId = legacy.forumChannelId
          await settingsAPI.set('forumChannelId', legacy.forumChannelId)
          migrated = true
        }
        if (legacy.notificationChannelId != null && config.notificationChannelId == null) {
          config.notificationChannelId = legacy.notificationChannelId
          await settingsAPI.set('notificationChannelId', legacy.notificationChannelId)
          migrated = true
        }
        if (legacy.assistantThreadId != null && config.assistantThreadId == null) {
          config.assistantThreadId = legacy.assistantThreadId
          await settingsAPI.set('assistantThreadId', legacy.assistantThreadId)
          migrated = true
        }
        if (migrated) {
          ctx.log.info('Migrated channel IDs from main config to plugin settings')
        }
      }

      const { DiscordAdapter } = await import('./adapter.js')
      adapter = new DiscordAdapter(
        core,
        {
          ...config,
          enabled: true,
          maxMessageLength: 2000,
        } as unknown as DiscordChannelConfig,
        settingsAPI,
      )

      ctx.registerService('adapter:discord', adapter)
      ctx.log.info('Discord adapter registered')
    },

    async teardown() {
      if (adapter) {
        await adapter.stop()
      }
    },
  }
}

export default createDiscordPlugin()
