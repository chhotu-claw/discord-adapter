import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  type Guild,
  type ForumChannel,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type {
  OutgoingMessage,
  PermissionRequest,
  NotificationMessage,
  AgentCommand,
  PlanEntry,
  Attachment,
  OpenACPCore,
  Session,
  DisplayVerbosity,
  AdapterCapabilities,
  IRenderer,
  MessagingAdapterConfig,
  FileServiceInterface,
  CommandResponse,
  SettingsAPI,
} from "@openacp/plugin-sdk";
import { log, MessagingAdapter, SendQueue } from "@openacp/plugin-sdk";
import type { CommandRegistry } from "@openacp/plugin-sdk";
import { DiscordRenderer } from "./renderer.js";
import type { DiscordChannelConfig, DiscordPlatformData } from "./types.js";
import { DiscordDraftManager } from "./draft-manager.js";
import { ActivityTracker, type ToolCallMeta, type OutputMode, type TunnelServiceInterface } from "./activity.js";
import { SkillCommandManager } from "./skill-command-manager.js";
import { PermissionHandler } from "./permissions.js";
import {
  ensureForums,
  createSessionThread as forumsCreateThread,
  createThreadFromMessage,
  renameSessionThread as forumsRenameThread,
  deleteSessionThread as forumsDeleteThread,
  ensureUnarchived,
  buildDeepLink,
} from "./forums.js";
import {
  registerSlashCommands,
  handleSlashCommand,
  setupButtonCallbacks,
  buildMenuKeyboard,
} from "./commands/index.js";
import { buildSessionControlKeyboard } from "./commands/admin.js";
import { spawnAssistant, buildWelcomeMessage } from "./assistant.js";
import {
  buildFallbackText,
  downloadDiscordAttachment,
  isAttachmentTooLarge,
} from "./media.js";
import { buildLaneThreadName, resolveLaneRoute } from './lane-routes.js'
import type { DraftMode } from './streaming.js'
import {
  resolveDiscordDraftMode,
  shouldFinalizeDiscordDraftBeforeToolCall,
  shouldSuppressDiscordNotifications,
} from './lane-session.js'

export class DiscordAdapter extends MessagingAdapter {
  readonly name = 'discord';
  readonly renderer: IRenderer = new DiscordRenderer();
  readonly capabilities: AdapterCapabilities = {
    streaming: true, richFormatting: true, threads: true,
    reactions: true, fileUpload: true, voice: false,
  };

  readonly core: OpenACPCore;
  private client: Client;
  private discordConfig: DiscordChannelConfig;
  private settingsAPI: SettingsAPI | undefined;
  private sendQueue: SendQueue;
  private draftManager: DiscordDraftManager;
  private _outputModeResolver = new OutputModeResolver();
  private skillManager!: SkillCommandManager;
  private permissionHandler!: PermissionHandler;
  private sessionTrackers: Map<string, ActivityTracker> = new Map();

  private guild!: Guild;
  private forumChannel!: ForumChannel | TextChannel;
  private notificationChannel!: TextChannel;
  private assistantSession: Session | null = null;
  private assistantInitializing = false;
  private pendingAssistantSystemPrompt: string | null = null;
  private fileService: FileServiceInterface;

  // Per-session thread context for concurrency safety in sendMessage handlers
  private _sessionContexts = new Map<string, { thread: ThreadChannel; isAssistant: boolean }>();
  private _configChangedHandler?: (data: { sessionId: string }) => void;
  private _threadReadyHandler?: (data: { sessionId: string; channelId: string; threadId: string }) => void;

  constructor(core: OpenACPCore, config: DiscordChannelConfig, settingsAPI: SettingsAPI | undefined) {
    super(
      { configManager: core.configManager },
      { ...config as Record<string, unknown>, maxMessageLength: 2000, enabled: config.enabled ?? true } as MessagingAdapterConfig,
    );
    this.core = core;
    this.discordConfig = config;
    this.settingsAPI = settingsAPI;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.sendQueue = new SendQueue({ minInterval: 1000 });
    this.draftManager = new DiscordDraftManager(this.sendQueue);
    this.fileService = core.fileService;

    // Wire discord.js rate limit events to send queue
    this.client.rest.on("rateLimited", (info) => {
      log.warn(
        { route: info.route, timeToReset: info.timeToReset },
        "[DiscordAdapter] Rate limited",
      );
      this.sendQueue.onRateLimited();
    });
  }

  // ─── Plugin settings helpers ──────────────────────────────────────────────

  /**
   * Persists a plugin setting to disk and updates the in-memory config so
   * subsequent reads within the same session see the new value immediately.
   */
  async savePluginSetting(key: string, value: unknown): Promise<void> {
    if (this.settingsAPI) {
      if (value === undefined) {
        await this.settingsAPI.delete(key)
      } else {
        await this.settingsAPI.set(key, value)
      }
    }
    // Keep in-memory config in sync so callers don't need a restart to see the change.
    (this.discordConfig as Record<string, unknown>)[key] = value
  }

  /** Returns the adapter-level output mode from plugin settings, or undefined if not set. */
  get adapterOutputMode(): OutputMode | undefined {
    const v = this.discordConfig.outputMode
    if (v === 'low' || v === 'medium' || v === 'high') return v as OutputMode
    return undefined
  }

  // ─── start ────────────────────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.once("ready", async () => {
        try {
          log.info(
            { guildId: this.discordConfig.guildId },
            "[DiscordAdapter] Client ready, initializing...",
          );

          // Fetch guild
          const guild =
            this.client.guilds.cache.get(this.discordConfig.guildId) ??
            (await this.client.guilds
              .fetch(this.discordConfig.guildId)
              .catch(() => null));
          if (!guild) {
            throw new Error(`Guild not found: ${this.discordConfig.guildId}`);
          }
          this.guild = guild;

          // Ensure forum + notification channels exist
          const { forumChannel, notificationChannel } = await ensureForums(
            guild,
            {
              forumChannelId: this.discordConfig.forumChannelId,
              notificationChannelId: this.discordConfig.notificationChannelId,
            },
            (key, value) => this.savePluginSetting(key, value),
          );
          this.forumChannel = forumChannel;
          this.notificationChannel = notificationChannel;

          // Init managers that need guild/guildId
          this.skillManager = new SkillCommandManager(
            this.sendQueue,
            this.core.sessionManager,
          );
          this.permissionHandler = new PermissionHandler(
            guild.id,
            (sessionId) => this.core.sessionManager.getSession(sessionId),
            (notification) => this.sendNotification(notification),
          );

          // Register slash commands
          await registerSlashCommands(guild);

          // Wire interaction + message handlers
          this.setupInteractionHandler();
          this.setupMessageHandler();

          // Welcome message with menu buttons so users can quickly start sessions
          const welcomeMsg = buildWelcomeMessage(this.core);
          const menuComponents = buildMenuKeyboard();
          try {
            await this.notificationChannel.send({ content: welcomeMsg, components: menuComponents });
          } catch (err) {
            log.warn(
              { err },
              "[DiscordAdapter] Failed to send welcome message",
            );
          }

          // Spawn assistant session
          await this.setupAssistant();

          // Update control message when session config changes via commands
          this._configChangedHandler = ({ sessionId }) => {
            this.updateControlMessage(sessionId).catch(() => {});
          };
          this.core.eventBus.on('session:configChanged', this._configChangedHandler);

          // Send welcome + control messages for sessions created via API/CLI (not via /new command)
          this._threadReadyHandler = ({ sessionId, channelId, threadId }) => {
            if (channelId !== 'discord') return;
            const session = this.core.sessionManager.getSession(sessionId);
            if (!session) return;
            // Assistant manages its own welcome message
            if (this.assistantSession && sessionId === this.assistantSession.id) return;
            // Lane-root sessions already create their own thread-local control message.
            if (this.getPlatformData(sessionId)?.laneKey) return;

            this.guild.channels.fetch(threadId)
              .then((channel) => {
                if (!channel || !channel.isThread()) return;
                const thread = channel as ThreadChannel;
                return thread.send({ content: '⏳ Setting up session, please wait...' })
                  .then(() =>
                    thread.send({
                      content:
                        `✅ **Session started**\n` +
                        `**Agent:** ${session.agentName}\n` +
                        `**Workspace:** \`${session.workingDirectory}\`\n\n` +
                        `This is your coding session — chat here to work with the agent.`,
                      components: [buildSessionControlKeyboard(sessionId, false, false)],
                    }),
                  )
                  .then((controlMsg) => this.persistSessionControlMsgId(sessionId, controlMsg.id));
              })
              .catch((err) => {
                log.warn({ err, sessionId, threadId }, '[DiscordAdapter] Failed to send initial messages for API-created session');
              });
          };
          this.core.eventBus.on('session:threadReady', this._threadReadyHandler);

          log.info("[DiscordAdapter] Initialization complete");
          resolve();
        } catch (err) {
          log.error({ err }, "[DiscordAdapter] Initialization failed");
          reject(err);
        }
      });

      this.client.login(this.discordConfig.botToken).catch(reject);
    });
  }

  // ─── stop ─────────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.assistantSession) {
      try {
        await this.assistantSession.destroy();
      } catch (err) {
        log.warn(
          { err },
          "[DiscordAdapter] Failed to destroy assistant session",
        );
      }
      this.assistantSession = null;
    }
    if (this._configChangedHandler) {
      this.core.eventBus.off('session:configChanged', this._configChangedHandler);
      this._configChangedHandler = undefined;
    }
    if (this._threadReadyHandler) {
      this.core.eventBus.off('session:threadReady', this._threadReadyHandler);
      this._threadReadyHandler = undefined;
    }
    this.client.destroy();
    log.info("[DiscordAdapter] Stopped");
  }

  // ─── Interaction handler ──────────────────────────────────────────────────

  private getCommandRegistry(): CommandRegistry | undefined {
    return this.core.lifecycleManager?.serviceRegistry?.get<CommandRegistry>("command-registry");
  }

  private isAgentSwitchLocked(threadId: string | null | undefined): boolean {
    if (!threadId) return false
    const session = this.core.sessionManager.getSessionByThread('discord', threadId)
    const record = session
      ? this.core.sessionManager.getSessionRecord(session.id)
      : this.core.sessionManager.getRecordByThread('discord', threadId)
    const platform = record?.platform as DiscordPlatformData | undefined
    return platform?.lockedAgent === true
  }

  private async replyAgentSwitchLocked(
    interaction:
      | import('discord.js').ChatInputCommandInteraction
      | import('discord.js').ButtonInteraction,
  ): Promise<void> {
    const message = '🔒 This session is pinned to its lane agent and cannot switch agents.'
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: message })
    } else {
      await interaction.reply({ content: message, ephemeral: true })
    }
  }

  private async handleLaneRootMessage(
    message: import('discord.js').Message,
  ): Promise<boolean> {
    const route = resolveLaneRoute(this.discordConfig.laneRoutes, {
      id: message.channel.id,
      name: 'name' in message.channel ? message.channel.name : undefined,
    })
    if (!route) return false
    if (message.channel.isThread()) return false
    if (message.channel.type !== 0) return false

    let thread: ThreadChannel | undefined

    try {
      const threadName = buildLaneThreadName(route, message)
      thread = await createThreadFromMessage(message, threadName)

      const session = await this.core.handleNewSession(
        'discord',
        route.agentName,
        route.workingDirectory,
        { threadId: thread.id },
      )
      session.threadId = thread.id

      await this.core.sessionManager.patchRecord(session.id, {
        platform: {
          threadId: thread.id,
          laneKey: route.laneKey,
          lockedAgent: route.lockAgent ?? true,
          laneUxMode: 'final_only',
          suppressNotifications: true,
        },
      })

      const controlRow = buildSessionControlKeyboard(
        session.id,
        session.clientOverrides?.bypassPermissions ?? false,
        session.voiceMode === 'on',
      )
      const controlMsg = await thread.send({
        content:
          `✅ **Session started**\n` +
          `**Agent:** ${session.agentName}\n` +
          `**Workspace:** \`${session.workingDirectory}\`\n\n` +
          `This thread was auto-created from #${'name' in message.channel ? message.channel.name : route.laneKey}.`,
        components: [controlRow],
      })
      await this.persistSessionControlMsgId(session.id, controlMsg.id)

      let text = message.content
      const attachments = await this.processIncomingAttachments(message, session.id)
      if (!text && attachments.length > 0) {
        text = buildFallbackText(attachments)
      }
      if (!text && attachments.length === 0 && message.attachments.size > 0) {
        await thread.send('Failed to process attachment(s)').catch(() => {})
        return true
      }

      await this.core.handleMessage({
        channelId: 'discord',
        threadId: thread.id,
        userId: message.author.id,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      })

      return true
    } catch (err) {
      log.error({ err, channelId: message.channel.id }, '[DiscordAdapter] lane session creation failed')
      if (thread) {
        try {
          await forumsDeleteThread(this.guild, thread.id)
        } catch {
          /* ignore */
        }
      }
      await message.reply(`❌ ${err instanceof Error ? err.message : String(err)}`).catch(() => {})
      return true
    }
  }

  async persistSessionControlMsgId(sessionId: string, controlMsgId: string): Promise<void> {
    if (!sessionId || !controlMsgId) return

    try {
      const record = this.core.sessionManager.getSessionRecord(sessionId)
      if (!record) return

      await this.core.sessionManager.patchRecord(sessionId, {
        platform: {
          ...(record.platform ?? {}),
          controlMsgId,
        },
      })
    } catch {
      // Best effort only.
    }
  }

  private setupInteractionHandler(): void {
    this.client.on("interactionCreate", async (interaction) => {
      try {
        // --- Generic CommandRegistry dispatch (slash commands) ---
        if (interaction.isChatInputCommand()) {
          const registry = this.getCommandRegistry();
          if (registry) {
            const commandName = interaction.commandName;
            const def = registry.get(commandName);
            if (def) {
              const rawParts: string[] = [];
              for (const opt of interaction.options.data) {
                rawParts.push(String(opt.value ?? ""));
              }

              const channelId = interaction.channelId;
              const sessionId =
                this.core.sessionManager.getSessionByThread("discord", channelId)?.id ?? null;

              if (commandName === 'switch' && this.isAgentSwitchLocked(channelId)) {
                await this.replyAgentSwitchLocked(interaction)
                return
              }

              const response = await registry.execute(
                `/${commandName} ${rawParts.join(" ")}`.trim(),
                {
                  raw: "",
                  sessionId,
                  channelId: "discord",
                  userId: interaction.user.id,
                  options: Object.fromEntries(
                    interaction.options.data.map((o) => [o.name, String(o.value ?? "")]),
                  ),
                  reply: async (content: string) => {
                    if (typeof content === "string") {
                      if (interaction.replied || interaction.deferred) {
                        await interaction.editReply({ content });
                      } else {
                        await interaction.reply({ content });
                      }
                    }
                  },
                },
              );

              if (response.type !== "silent") {
                await this.renderCommandResponse(response, interaction);
              } else if (!interaction.replied && !interaction.deferred) {
                await interaction.deferReply();
              }
              return; // handled by registry
            }
          }

          // Fall through to existing slash command router
          if (interaction.commandName === 'switch' && this.isAgentSwitchLocked(interaction.channelId)) {
            await this.replyAgentSwitchLocked(interaction)
            return
          }
          await handleSlashCommand(interaction, this);
          return;
        }

        // --- Button interactions ---
        if (interaction.isButton()) {
          // Command registry buttons (c/ prefix) — check before permission/legacy
          if (interaction.customId.startsWith("c/")) {
            const registry = this.getCommandRegistry();
            if (registry) {
              const command = interaction.customId.slice(2);
              const channelId = interaction.channelId;
              const sessionId =
                this.core.sessionManager.getSessionByThread("discord", channelId)?.id ?? null;
              const commandName = command.trim().replace(/^\//, '').split(/\s+/, 1)[0];

              if (commandName === 'switch' && this.isAgentSwitchLocked(channelId)) {
                await this.replyAgentSwitchLocked(interaction);
                return;
              }

              const response = await registry.execute(command, {
                raw: "",
                sessionId,
                channelId: "discord",
                userId: interaction.user.id,
                reply: async (content: string) => {
                  if (typeof content === "string") {
                    if (interaction.replied || interaction.deferred) {
                      await interaction.editReply({ content });
                    } else {
                      await interaction.reply({ content, ephemeral: true });
                    }
                  }
                },
              });

              if (response.type !== "silent") {
                await this.renderCommandResponse(response, interaction);
              }
              return;
            }
          }

          // Permission buttons take priority over legacy
          const handled =
            await this.permissionHandler.handleButtonInteraction(interaction);
          if (!handled) {
            await setupButtonCallbacks(interaction, this);
          }
        }
      } catch (err) {
        log.error({ err }, "[DiscordAdapter] interactionCreate handler error");
      }
    });
  }

  // ─── CommandRegistry response rendering ──────────────────────────────────

  private async renderCommandResponse(
    response: CommandResponse,
    interaction: import("discord.js").ChatInputCommandInteraction | import("discord.js").ButtonInteraction | import("discord.js").StringSelectMenuInteraction,
  ): Promise<void> {
    const reply = async (opts: Record<string, unknown>) => {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(opts);
      } else {
        await interaction.reply(opts);
      }
    };

    switch (response.type) {
      case "text":
        await reply({ content: response.text });
        break;
      case "adaptive": {
        const variant = response.variants?.['discord'] as
          | { content?: string; embeds?: unknown[] }
          | undefined;
        await reply({
          content: variant?.content ?? response.fallback,
          ...(variant?.embeds && { embeds: variant.embeds }),
        });
        break;
      }
      case "error":
        await reply({ content: `\u26a0\ufe0f ${response.message}`, ephemeral: true });
        break;
      case "menu": {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } =
          await import("discord.js");
        const embed = new EmbedBuilder().setTitle(response.title);
        const rows: InstanceType<typeof ActionRowBuilder>[] = [];
        // Max 5 buttons per row, max 5 rows
        for (let i = 0; i < response.options.length && rows.length < 5; i += 5) {
          const row = new ActionRowBuilder();
          const slice = response.options.slice(i, i + 5);
          for (const opt of slice) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`c/${opt.command}`)
                .setLabel(opt.label.slice(0, 80))
                .setStyle(ButtonStyle.Secondary),
            );
          }
          rows.push(row);
        }
        await reply({ embeds: [embed], components: rows });
        break;
      }
      case "list": {
        const { EmbedBuilder } = await import("discord.js");
        const desc = response.items
          .map((i) => `\u2022 **${i.label}**${i.detail ? ` \u2014 ${i.detail}` : ""}`)
          .join("\n");
        const embed = new EmbedBuilder()
          .setTitle(response.title)
          .setDescription(desc);
        await reply({ embeds: [embed] });
        break;
      }
      case "confirm": {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } =
          await import("discord.js");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`c/${response.onYes}`)
            .setLabel("Yes")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`c/${response.onNo || "noop"}`)
            .setLabel("No")
            .setStyle(ButtonStyle.Secondary),
        );
        await reply({ content: response.question, components: [row] });
        break;
      }
      case "silent":
        break;
    }
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private setupMessageHandler(): void {
    this.client.on("messageCreate", async (message) => {
      try {
        // Ignore bots and self
        if (message.author.bot) return;

        // Ignore DMs
        if (!message.guild) return;

        // Ignore messages from the wrong guild
        if (message.guild.id !== this.guild.id) return;

        // Handle dedicated root lanes that auto-create a new thread + session per message
        if (!message.channel.isThread()) {
          const handled = await this.handleLaneRootMessage(message)
          if (handled) return
        }

        // Only process messages in threads
        if (!message.channel.isThread()) return;

        const threadId = message.channel.id;
        const userId = message.author.id;
        let text = message.content;

        log.debug(
          {
            threadId,
            userId,
            text: text.slice(0, 50),
            attachmentCount: message.attachments.size,
          },
          "[DiscordAdapter] messageCreate received",
        );

        // Ignore messages with no text and no attachments
        if (!text && message.attachments.size === 0) return;

        // Resolve sessionId for file storage (fallback to "unknown" for new sessions)
        let sessionId =
          this.core.sessionManager.getSessionByThread("discord", threadId)
            ?.id ?? "unknown";

        // If a legacy thread exists without in-memory session state, restore a lane session
        // from its parent or naming cues so users can continue typing in old lane threads.
        if (sessionId === "unknown") {
          const parentChannel =
            message.channel.parent ??
            (message.channel.parentId ? await this.guild.channels.fetch(message.channel.parentId).catch(() => null) : null);

          const forumFallbackRoute = await (async () => {
            const routes = this.discordConfig.laneRoutes;
            if (!routes) return null;

            // 1) Primary match from parent channel id/name (preferred)
            if (parentChannel) {
              const route = resolveLaneRoute(routes, parentChannel);
              if (route) return route;
            }

            // 2) If thread name contains lane hint (e.g. "🔄 gemini — ...") use that.
            const threadName = ((message.channel as { name?: string } | null) as { name?: string })?.name?.toLowerCase() ?? "";
            const routeFromName = Object.entries(routes).find(([laneKey, route]) => {
              const keyMatch = threadName.includes(laneKey.toLowerCase());
              const agentMatch =
                typeof route.agentName === "string" ? threadName.includes(route.agentName.toLowerCase()) : false;
              return keyMatch || agentMatch;
            });
            if (routeFromName) {
              const [laneKey, route] = routeFromName;
              return {
                laneKey,
                ...route,
              };
            }

            // 3) Check recent thread history for explicit slash commands (e.g. `/gemini`, `/claude`) so
            // old threads started manually (or renamed to neutral titles) can recover.
            try {
              const fetchedHistory = await message.channel.messages.fetch({ limit: 50 });
              const history = fetchedHistory.toJSON();
              for (const msg of history) {
                if (msg.author?.bot) continue;
                const lower = (msg.content ?? "").toLowerCase();
                const routeFromHistory = (() => {
                  const routeEntries = Object.entries(routes);
                  const commandRegex = /\/(\w+)/g;
                  let match: RegExpExecArray | null;
                  while ((match = commandRegex.exec(lower)) !== null) {
                    const command = match[1].toLowerCase();
                    const found = routeEntries.find(
                      ([laneKey, route]) =>
                        laneKey.toLowerCase() === command || String(route.agentName).toLowerCase() === command,
                    );
                    if (found) {
                      return found;
                    }
                  }
                  return undefined;
                })();

                if (routeFromHistory) {
                  const [laneKey, route] = routeFromHistory;
                  return {
                    laneKey,
                    ...route,
                  };
                }
              }
            }
            catch (err) {
              log.warn({ err, threadId }, "[DiscordAdapter] Failed to infer lane route from thread history");
            }

            // 4) Last-resort fallback for single-route setups (prevents hard dead-ends on restart).
            const routeEntries = Object.entries(routes);
            if (routeEntries.length === 1) {
              const [laneKey, route] = routeEntries[0];
              return { laneKey, ...route };
            }

            return null;
          })();

          if (forumFallbackRoute) {
            try {
              const session = await this.core.handleNewSession(
                "discord",
                forumFallbackRoute.agentName,
                forumFallbackRoute.workingDirectory,
                { threadId },
              );
              session.threadId = threadId;

              await this.core.sessionManager.patchRecord(session.id, {
                platform: {
                  threadId,
                  laneKey: forumFallbackRoute.laneKey,
                  lockedAgent: forumFallbackRoute.lockAgent ?? true,
                  laneUxMode: "final_only",
                  suppressNotifications: true,
                },
              });
              sessionId = session.id;

              try {
                const controlMsg = await message.channel.send({
                  content:
                    `✅ **Session started**\n` +
                    `**Agent:** ${session.agentName}\n` +
                    `**Workspace:** \`${session.workingDirectory}\`\n\n` +
                    `This was a previously used lane thread; continuing in a fresh session.`,
                  components: [
                    buildSessionControlKeyboard(
                      session.id,
                      session.clientOverrides?.bypassPermissions ?? false,
                      session.voiceMode === 'on',
                    ),
                  ],
                });
                await this.persistSessionControlMsgId(session.id, controlMsg.id);
              } catch {
                // Control message is non-essential; continue with the new session anyway.
              }
            } catch (err) {
              log.error({ err, threadId }, "[DiscordAdapter] failed to recreate lane session for thread");
            }
          }
        }

        // Process attachments
        if (message.attachments.size > 0) {
          log.info(
            {
              sessionId,
              attachments: message.attachments.map((a) => ({
                name: a.name,
                size: a.size,
                contentType: a.contentType,
                url: a.url?.slice(0, 80),
              })),
            },
            "[discord-media] Processing incoming attachments",
          );
        }
        const attachments = await this.processIncomingAttachments(
          message,
          sessionId,
        );

        // Generate fallback text if message has attachments but no text
        if (!text && attachments.length > 0) {
          text = buildFallbackText(attachments);
        }

        // If all attachment downloads failed and no text, notify user
        if (!text && attachments.length === 0 && message.attachments.size > 0) {
          try {
            await message.reply("Failed to process attachment(s)");
          } catch {
            /* best effort */
          }
          return;
        }

        // Route assistant thread messages to assistant
        if (
          this.discordConfig.assistantThreadId &&
          threadId === this.discordConfig.assistantThreadId
        ) {
          if (this.assistantSession && text) {
            let promptText = text;
            if (this.pendingAssistantSystemPrompt) {
              promptText = `${this.pendingAssistantSystemPrompt}\n\n---\n\nUser message:\n${text}`;
              this.pendingAssistantSystemPrompt = null;
            }
            await this.assistantSession.enqueuePrompt(
              promptText,
              attachments.length > 0 ? attachments : undefined,
            );
          }
          return;
        }

        // Reset tracker state for new prompt cycle on existing sessions
        if (sessionId !== "unknown") {
          const tracker = this.sessionTrackers.get(sessionId);
          if (tracker) {
            await tracker.onNewPrompt();
          }
        }

        // Route to core for session dispatch
        await this.core.handleMessage({
          channelId: "discord",
          threadId,
          userId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      } catch (err) {
        log.error({ err }, "[DiscordAdapter] messageCreate handler error");
      }
    });
  }

  // ─── Assistant ────────────────────────────────────────────────────────────

  private async setupAssistant(): Promise<void> {
    let threadId = this.discordConfig.assistantThreadId;

    // Verify existing thread is still accessible
    if (threadId) {
      try {
        const existing =
          this.guild.channels.cache.get(threadId) ??
          (await this.guild.channels.fetch(threadId));
        if (existing && existing.isThread()) {
          await ensureUnarchived(
            existing as import("discord.js").ThreadChannel,
          );
          log.info(
            { threadId },
            "[DiscordAdapter] Reusing existing assistant thread",
          );
        } else {
          log.warn(
            { threadId },
            "[DiscordAdapter] Assistant thread not found, recreating...",
          );
          threadId = null;
        }
      } catch {
        log.warn(
          { threadId },
          "[DiscordAdapter] Assistant thread inaccessible, recreating...",
        );
        threadId = null;
      }
    }

    if (!threadId) {
      // Create a new thread for the assistant
      const thread = await forumsCreateThread(this.forumChannel, "Assistant");
      threadId = thread.id;
      await this.savePluginSetting('assistantThreadId', thread.id)
      log.info({ threadId }, "[DiscordAdapter] Created assistant thread");
    }

    this.assistantInitializing = true;
    try {
      const { session, pendingSystemPrompt } = await spawnAssistant(this.core, threadId);
      this.assistantSession = session;
      this.pendingAssistantSystemPrompt = pendingSystemPrompt;
      this.assistantInitializing = false;
    } catch (err) {
      this.assistantInitializing = false;
      log.error({ err }, "[DiscordAdapter] Failed to spawn assistant");
    }
  }

  async respawnAssistant(): Promise<void> {
    if (this.assistantSession) {
      try {
        await this.assistantSession.destroy();
      } catch {
        /* ignore */
      }
      this.assistantSession = null;
    }
    await this.setupAssistant();
  }

  // ─── Incoming media ──────────────────────────────────────────────────

  private async processIncomingAttachments(
    message: import("discord.js").Message,
    sessionId: string,
  ): Promise<Attachment[]> {
    if (message.attachments.size === 0) return [];

    const isVoiceMessage = message.flags.has(MessageFlags.IsVoiceMessage);

    const results = await Promise.allSettled(
      message.attachments.map(async (discordAtt) => {
        const buffer = await downloadDiscordAttachment(
          discordAtt.url,
          discordAtt.name ?? "attachment",
        );
        if (!buffer) return null;

        let data = buffer;
        let fileName = discordAtt.name ?? "attachment";
        let mimeType = discordAtt.contentType ?? "application/octet-stream";

        // Convert voice messages from OGG Opus to WAV
        if (isVoiceMessage && mimeType.includes("ogg")) {
          try {
            data = await this.fileService.convertOggToWav(buffer);
            fileName = "voice.wav";
            mimeType = "audio/wav";
          } catch (err) {
            log.warn(
              { err },
              "[discord-media] OGG→WAV conversion failed, saving original",
            );
          }
        }

        return this.fileService.saveFile(sessionId, fileName, data, mimeType);
      }),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length > 0) {
      log.warn(
        { rejected: rejected.map((r) => (r as PromiseRejectedResult).reason) },
        "[discord-media] Some attachments failed",
      );
    }

    const saved = results
      .filter(
        (r): r is PromiseFulfilledResult<Attachment | null> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value)
      .filter((att): att is Attachment => att !== null);

    log.info(
      { count: saved.length, files: saved.map((a) => a.fileName) },
      "[discord-media] Attachments processed",
    );
    return saved;
  }

  // ─── Helper: resolve thread ───────────────────────────────────────────────

  private async getThread(sessionId: string): Promise<ThreadChannel | null> {
    const session = this.core.sessionManager.getSession(sessionId);
    const threadId = session?.threadId;
    if (!threadId) {
      log.warn({ sessionId }, "[DiscordAdapter] No threadId for session");
      return null;
    }
    try {
      const channel =
        this.guild.channels.cache.get(threadId) ??
        (await this.guild.channels.fetch(threadId));
      if (channel && channel.isThread()) return channel as ThreadChannel;
      log.warn(
        { sessionId, threadId },
        "[DiscordAdapter] Channel is not a thread",
      );
      return null;
    } catch (err) {
      log.warn(
        { err, sessionId, threadId },
        "[DiscordAdapter] Failed to fetch thread",
      );
      return null;
    }
  }

  private getPlatformData(sessionId: string): DiscordPlatformData | undefined {
    const record = this.core.sessionManager.getSessionRecord(sessionId)
    return record?.platform as DiscordPlatformData | undefined
  }

  private shouldSuppressNotifications(sessionId: string): boolean {
    return shouldSuppressDiscordNotifications(this.getPlatformData(sessionId))
  }

  private resolveDraftMode(sessionId: string): DraftMode {
    return resolveDiscordDraftMode(this.getPlatformData(sessionId))
  }

  // ─── Helper: get or create activity tracker ──────────────────────────────

  private resolveMode(sessionId: string): OutputMode {
    return this._outputModeResolver.resolve(
      this.discordConfig,
      this.core.configManager as any,
      sessionId,
      this.core.sessionManager as any,
    );
  }

  private getOrCreateTracker(
    sessionId: string,
    thread: TextChannel | ThreadChannel,
    outputMode: OutputMode = "medium",
  ): ActivityTracker {
    let tracker = this.sessionTrackers.get(sessionId);
    if (!tracker) {
      const tunnelService = this.core.lifecycleManager?.serviceRegistry?.get("tunnel") as TunnelServiceInterface | undefined;
      const session = this.core.sessionManager.getSession(sessionId);
      const sessionContext = session
        ? { id: sessionId, workingDirectory: session.workingDirectory }
        : undefined;
      tracker = new ActivityTracker(
        thread,
        this.sendQueue,
        outputMode,
        sessionId,
        tunnelService,
        sessionContext,
      );
      this.sessionTrackers.set(sessionId, tracker);
    } else {
      tracker.setOutputMode(outputMode);
    }
    return tracker;
  }

  /** Called from button router to switch mode and re-render the current tool card. */
  updateSessionOutputMode(sessionId: string, mode: OutputMode): void {
    const tracker = this.sessionTrackers.get(sessionId);
    if (!tracker) return;
    tracker.setOutputMode(mode);
    tracker.rerender();
  }

  /**
   * Edit the control message to reflect current session state (bypass, voice mode).
   * No-op if the control message ID is unknown (session created before this fix).
   */
  async updateControlMessage(sessionId: string): Promise<void> {
    const controlMsgId = this.getControlMsgId(sessionId);
    if (!controlMsgId) return;

    const thread = await this.getThread(sessionId);
    if (!thread) return;

    const session = this.core.sessionManager.getSession(sessionId);
    if (!session) return;

    const keyboard = buildSessionControlKeyboard(
      sessionId,
      session.clientOverrides?.bypassPermissions ?? false,
      session.voiceMode === 'on',
    );

    try {
      const msg = await thread.messages.fetch(controlMsgId);
      await msg.edit({ components: [keyboard] });
    } catch {
      // Message deleted or inaccessible — ignore
    }
  }

  private getSessionContext(sessionId: string): { thread: ThreadChannel; isAssistant: boolean } {
    const ctx = this._sessionContexts.get(sessionId);
    if (!ctx) {
      throw new Error(`No thread context stored for session ${sessionId}`);
    }
    return ctx;
  }

  // ─── sendMessage ──────────────────────────────────────────────────────────

  async sendMessage(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    // Suppress output while assistant is initializing its system prompt
    if (
      this.assistantInitializing &&
      this.assistantSession &&
      sessionId === this.assistantSession.id
    ) {
      return;
    }

    const thread = await this.getThread(sessionId);
    if (!thread) return;

    await ensureUnarchived(thread);

    // Store thread context keyed by sessionId for concurrency safety
    this._sessionContexts.set(sessionId, {
      thread,
      isAssistant: this.assistantSession != null && sessionId === this.assistantSession.id,
    });

    try {
      await super.sendMessage(sessionId, content);
    } finally {
      this._sessionContexts.delete(sessionId);
    }
  }

  // ─── Handler overrides ─────────────────────────────────────────────────────

  protected async handleThought(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    const mode = this.resolveMode(sessionId);
    const tracker = this.getOrCreateTracker(sessionId, thread, mode);
    await tracker.onThought(content.text || "");
  }

  protected async handleText(sessionId: string, content: OutgoingMessage): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    const draftMode = this.resolveDraftMode(sessionId);
    if (!this.draftManager.hasDraft(sessionId)) {
      const mode = this.resolveMode(sessionId);
      const tracker = this.getOrCreateTracker(sessionId, thread, mode);
      await tracker.onTextStart();
    }
    const draft = this.draftManager.getOrCreate(
      sessionId,
      thread,
      draftMode,
    );
    draft.append(content.text);
    this.draftManager.appendText(sessionId, content.text);
    if (draftMode === 'final_only') {
      this.draftManager.scheduleDeferredFinalize(sessionId, thread, isAssistant);
    }
  }

  protected async handleToolCall(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    const meta = (content.metadata ?? {}) as Partial<ToolCallMeta>;
    const mode = this.resolveMode(sessionId);
    const tracker = this.getOrCreateTracker(sessionId, thread, mode);
    if (shouldFinalizeDiscordDraftBeforeToolCall(this.getPlatformData(sessionId))) {
      await this.draftManager.finalize(sessionId, thread, isAssistant);
    }
    await tracker.onToolCall(
      {
        id: meta.id ?? "",
        name: meta.name ?? content.text ?? "Tool",
        kind: meta.kind,
        status: meta.status,
        content: meta.content,
        rawInput: meta.rawInput,
        viewerLinks: meta.viewerLinks,
        viewerFilePath: meta.viewerFilePath,
        displaySummary: meta.displaySummary as string | undefined,
        displayTitle: meta.displayTitle as string | undefined,
        displayKind: meta.displayKind as string | undefined,
      },
      String(meta.kind ?? ""),
      meta.rawInput,
    );
  }

  protected async handleToolUpdate(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    const meta = (content.metadata ?? {}) as Partial<ToolCallMeta & { diffStats?: { added: number; removed: number } }>;
    const mode = this.resolveMode(sessionId);
    const tracker = this.getOrCreateTracker(sessionId, thread, mode);
    await tracker.onToolUpdate(
      meta.id ?? "",
      meta.status ?? "completed",
      meta.viewerLinks as { file?: string; diff?: string } | undefined,
      typeof meta.content === "string" ? meta.content : null,
      meta.rawInput ?? undefined,
      meta.diffStats as { added: number; removed: number } | undefined,
    );
  }

  protected async handlePlan(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    const meta = (content.metadata ?? {}) as { entries?: PlanEntry[] };
    const entries = meta.entries ?? [];
    const mode = this.resolveMode(sessionId);
    const tracker = this.getOrCreateTracker(sessionId, thread, mode);
    await tracker.onPlan(entries);
  }

  protected async handleUsage(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    await this.draftManager.finalize(sessionId, thread, isAssistant);
    const meta = content.metadata as { tokensUsed?: number; contextSize?: number; cost?: number; duration?: number } | undefined;
    const mode = this.resolveMode(sessionId);

    try {
      const { renderUsageEmbed } = await import("./formatting.js");
      const embed = renderUsageEmbed(meta ?? {}, mode);
      await this.sendQueue.enqueue(
        () => thread.send({ embeds: [embed] }),
        { type: "other" },
      );
    } catch (err) {
      log.warn({ err, sessionId }, "Failed to send usage embed");
    }

    // Notify notification channel
    if (this.notificationChannel && sessionId !== this.assistantSession?.id && !this.shouldSuppressNotifications(sessionId)) {
      const sess = this.core.sessionManager.getSession(sessionId);
      const name = sess?.name || "Session";
      try {
        await this.sendNotification({
          sessionId,
          sessionName: name,
          type: 'completed',
          summary: 'Task completed.',
        });
      } catch {
        /* best effort */
      }
    }
  }

  protected async handleSessionEnd(sessionId: string, _content: OutgoingMessage): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    await this.draftManager.finalize(sessionId, thread, isAssistant);
    this.draftManager.cleanup(sessionId);
    await this.skillManager.cleanup(sessionId);
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      await tracker.cleanup();
      this.sessionTrackers.delete(sessionId);
    } else {
      try {
        await this.sendQueue.enqueue(
          () => thread.send({ content: "\u2705 **Done**" }),
          { type: "other" },
        );
      } catch {
        /* best effort */
      }
    }
  }

  protected async handleConfigUpdate(sessionId: string, _content: OutgoingMessage): Promise<void> {
    await this.updateControlMessage(sessionId);
  }

  protected async handleError(sessionId: string, content: OutgoingMessage): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    await this.draftManager.finalize(sessionId, thread, isAssistant);
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }
    try {
      await this.sendQueue.enqueue(
        () => thread.send({ content: `\u274c **Error:** ${content.text}` }),
        { type: "other" },
      );
    } catch {
      /* best effort */
    }
  }

  protected async handleAttachment(sessionId: string, content: OutgoingMessage): Promise<void> {
    if (!content.attachment) return;
    const { attachment } = content;
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    await this.draftManager.finalize(
      sessionId,
      thread,
      isAssistant,
    );

    // Discord free tier limit: 25MB
    if (isAttachmentTooLarge(attachment.size)) {
      log.warn(
        {
          sessionId,
          fileName: attachment.fileName,
          size: attachment.size,
        },
        "[discord-media] File too large (>25MB)",
      );
      try {
        await this.sendQueue.enqueue(
          () =>
            thread.send({
              content: `⚠️ File too large to send (${Math.round(attachment.size / 1024 / 1024)}MB): ${attachment.fileName}`,
            }),
          { type: "other" },
        );
      } catch {
        /* best effort */
      }
      return;
    }

    try {
      await this.sendQueue.enqueue(
        () =>
          thread.send({
            files: [
              { attachment: attachment.filePath, name: attachment.fileName },
            ],
          }),
        { type: "other" },
      );

      // Strip [TTS]...[/TTS] block from the text message after audio is sent.
      // This fires after sendQueue completes, so the draft message already exists.
      // stripPattern is best-effort and handles missing/finalized drafts gracefully.
      if (attachment.type === "audio") {
        const draft = this.draftManager.getDraft(sessionId);
        if (draft) {
          draft.stripPattern(/\[TTS\][\s\S]*?\[\/TTS\]/g).catch(() => {});
        }
      }
    } catch (err) {
      log.error(
        { err, sessionId, fileName: attachment.fileName },
        "[discord-media] Failed to send attachment",
      );
    }
  }

  protected async handleSystem(sessionId: string, content: OutgoingMessage): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    try {
      await this.sendQueue.enqueue(
        () => thread.send({ content: content.text }),
        { type: "other" },
      );
    } catch {
      /* best effort */
    }
  }

  // ─── sendPermissionRequest ────────────────────────────────────────────────

  async sendPermissionRequest(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId);
    if (!session) {
      log.warn(
        { sessionId },
        "[DiscordAdapter] sendPermissionRequest: session not found",
      );
      return;
    }

    const thread = await this.getThread(sessionId);
    if (!thread) return;

    await this.permissionHandler.sendPermissionRequest(
      session,
      request,
      thread,
      !this.shouldSuppressNotifications(sessionId),
    );
  }

  // ─── sendNotification ─────────────────────────────────────────────────────

  async sendNotification(notification: NotificationMessage): Promise<void> {
    if (!this.notificationChannel) return;
    if (notification.sessionId && this.shouldSuppressNotifications(notification.sessionId)) return;

    const typeIcon: Record<string, string> = {
      completed: "✅",
      error: "❌",
      permission: "🔐",
      input_required: "💬",
    };

    const icon = typeIcon[notification.type] ?? "ℹ️";
    const name = notification.sessionName
      ? ` **${notification.sessionName}**`
      : "";
    let text = `${icon}${name}: ${notification.summary}`;
    if (notification.deepLink) {
      text += `\n${notification.deepLink}`;
    }

    try {
      await this.sendQueue.enqueue(
        () => this.notificationChannel.send({ content: text }),
        { type: "other" },
      );
    } catch (err) {
      log.warn({ err }, "[DiscordAdapter] Failed to send notification");
    }
  }

  // ─── createSessionThread ─────────────────────────────────────────────────

  async createSessionThread(sessionId: string, name: string): Promise<string> {
    const thread = await forumsCreateThread(this.forumChannel, name);

    // Persist threadId on session record
    const session = this.core.sessionManager.getSession(sessionId);
    if (session) {
      session.threadId = thread.id;
    }

    const record = this.core.sessionManager.getSessionRecord(sessionId);
    if (record) {
      await this.core.sessionManager.patchRecord(sessionId, {
        platform: { ...record.platform, threadId: thread.id },
      });
    }

    return thread.id;
  }

  // ─── renameSessionThread ──────────────────────────────────────────────────

  async renameSessionThread(sessionId: string, newName: string): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId);
    const threadId = session?.threadId;
    if (!threadId) return;
    await forumsRenameThread(this.guild, threadId, newName);
  }

  // ─── deleteSessionThread ──────────────────────────────────────────────────

  async deleteSessionThread(sessionId: string): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId);
    const threadId = session?.threadId;
    if (!threadId) return;
    await forumsDeleteThread(this.guild, threadId);
  }

  // ─── sendSkillCommands ────────────────────────────────────────────────────

  async sendSkillCommands(
    sessionId: string,
    commands: AgentCommand[],
  ): Promise<void> {
    const thread = await this.getThread(sessionId);
    if (!thread) return;
    await this.skillManager.send(sessionId, thread, commands);
  }

  // ─── cleanupSkillCommands ─────────────────────────────────────────────────

  async cleanupSkillCommands(sessionId: string): Promise<void> {
    await this.skillManager.cleanup(sessionId);
  }

  // ─── Public helpers (for slash commands) ─────────────────────────────────

  getForumChannel(): ForumChannel | TextChannel {
    return this.forumChannel;
  }

  getGuild(): Guild {
    return this.guild;
  }

  getGuildId(): string {
    return this.guild.id;
  }

  getAssistantSessionId(): string | null {
    return this.assistantSession?.id ?? null;
  }

  getAssistantThreadId(): string | null {
    return this.discordConfig.assistantThreadId;
  }

  /**
   * Persist the control message ID to the session record so it survives restart.
   * Called after sending the welcome/control message in new-session.ts.
   */
  async persistControlMsgId(sessionId: string, messageId: string): Promise<void> {
    const record = this.core.sessionManager.getSessionRecord(sessionId);
    if (!record) return;
    await this.core.sessionManager.patchRecord(sessionId, {
      platform: { ...(record.platform ?? {}), controlMsgId: messageId },
    }).catch((err) => {
      log.warn({ err, sessionId }, "[DiscordAdapter] Failed to persist controlMsgId");
    });
  }

  /**
   * Retrieve stored control message ID for a session (survives restart via session record).
   */
  getControlMsgId(sessionId: string): string | undefined {
    const record = this.core.sessionManager.getSessionRecord(sessionId);
    const platform = record?.platform as { controlMsgId?: string } | undefined;
    return platform?.controlMsgId;
  }
}

// ─── OutputModeResolver ────────────────────────────────────────────────────────
// Resolves output mode with 3-level cascade:
// Session override -> Adapter override -> Global default -> "medium"

class OutputModeResolver {
  resolve(
    // Adapter-level setting comes from plugin settings (discordConfig), not legacy core config.
    discordConfig: { outputMode?: unknown },
    configManager: { get(): Record<string, unknown> },
    sessionId?: string,
    sessionManager?: { getSession(id: string): { record?: { outputMode?: string } } | undefined },
  ): OutputMode {
    // Level 3: Session override (highest priority)
    if (sessionId && sessionManager) {
      const session = sessionManager.getSession(sessionId);
      const mode = session?.record?.outputMode;
      if (mode === "low" || mode === "medium" || mode === "high") return mode;
    }
    // Level 2: Adapter override (from plugin settings)
    const adapterMode = discordConfig.outputMode;
    if (adapterMode === "low" || adapterMode === "medium" || adapterMode === "high") return adapterMode as OutputMode;
    // Level 1: Global default (from core config)
    const globalMode = configManager.get().outputMode;
    if (globalMode === "low" || globalMode === "medium" || globalMode === "high") return globalMode as OutputMode;
    return "medium";
  }
}
