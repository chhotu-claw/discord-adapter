import {
  ActionRowBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from '@openacp/plugin-sdk'
import type { DiscordAdapter } from '../adapter.js'
import { executeNewSession } from './new-session.js'

const OTHER = '__other__'
const MORE = '__more__:' // followed by the next page index
// Discord caps a select menu at 25 options. Reserve 2 slots (More + Other).
const PAGE_SIZE = 23

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** Display form: collapse home to `~`, truncate to Discord's 100-char limit. */
function shorten(p: string): string {
  const h = homedir()
  const s = p === h ? '~' : p.startsWith(h + '/') ? '~' + p.slice(h.length) : p
  return s.length > 96 ? '…' + s.slice(-95) : s
}

/** Recency signal for a project dir: its own mtime, bumped by .git activity. */
function dirMtime(dir: string): number {
  let m = 0
  try {
    m = statSync(dir).mtimeMs
  } catch {
    /* ignore */
  }
  try {
    const g = statSync(join(dir, '.git')).mtimeMs // commits/checkouts rewrite .git
    if (g > m) m = g
  } catch {
    /* not a git repo */
  }
  return m
}

/**
 * Immediate subdirectories of `dir` (absolute paths), skipping dotfiles,
 * sorted by last modified — most recent first.
 */
function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(dir, e.name))
      .map((p) => ({ p, m: dirMtime(p) }))
      .sort((a, b) => b.m - a.m)
      .map((x) => x.p)
  } catch {
    return []
  }
}

interface WsDir {
  value: string
  tag?: string
}

/**
 * Full, ordered, de-duplicated list of candidate workspaces (no cap — the
 * picker paginates it):
 *   1. recent workspaces (from the session store)
 *   2. pinned dirs (default: ~/.hermes)
 *   3. subdirs of scan roots (default: ~/workspace/projects) — the "projects"
 */
function buildAllDirs(adapter: DiscordAdapter): WsDir[] {
  const seen = new Set<string>()
  const out: WsDir[] = []
  const add = (dir: string, tag?: string) => {
    if (!dir || dir.length > 100 || seen.has(dir)) return
    seen.add(dir)
    out.push({ value: dir, tag })
  }

  try {
    const recents = [
      ...new Set(
        adapter.core.sessionManager
          .listRecords()
          .map((r: { workingDir?: string }) => r.workingDir)
          .filter((d): d is string => !!d),
      ),
    ].slice(0, 5)
    for (const d of recents) add(d, 'recent')
  } catch (err) {
    log.warn({ err }, '[workspace-picker] could not read recent workspaces')
  }

  for (const p of adapter.getWorkspacePins()) add(expandHome(p), 'pinned')
  for (const root of adapter.getWorkspaceRoots()) {
    for (const d of listSubdirs(expandHome(root))) add(d)
  }
  return out
}

/**
 * Autocomplete suggestions for the `/new` workspace option — substring match
 * over the same ordered candidate list, capped at Discord's 25-choice limit.
 */
export function searchWorkspaces(
  adapter: DiscordAdapter,
  query: string,
): { name: string; value: string }[] {
  const q = query.trim().toLowerCase()
  const all = buildAllDirs(adapter)
  const matched = q ? all.filter((d) => d.value.toLowerCase().includes(q)) : all
  return matched.slice(0, 25).map((d) => ({
    name: shorten(d.value), // already <= 96 chars
    value: d.value, // buildAllDirs guarantees <= 100 chars
  }))
}

/**
 * Show (or re-page) the workspace picker as the response to a deferred /new,
 * agent-button, or "More…" interaction. Selecting a directory creates the
 * session there; "Other…" opens a modal for an arbitrary path.
 */
export async function showWorkspacePicker(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction,
  adapter: DiscordAdapter,
  agentKey: string,
  page = 0,
): Promise<void> {
  const all = buildAllDirs(adapter)
  const start = page * PAGE_SIZE
  const slice = all.slice(start, start + PAGE_SIZE)
  const remaining = all.length - (start + slice.length)

  const options = slice.map((d) => ({
    label: shorten(d.value),
    value: d.value,
    ...(d.tag ? { description: d.tag } : {}),
  }))
  if (remaining > 0) {
    options.push({
      label: `▶ More… (${remaining} more)`,
      value: `${MORE}${page + 1}`,
      description: 'Show the next page',
    })
  }
  options.push({
    label: '📁 Other… (type a path)',
    value: OTHER,
    description: 'Enter any directory as a one-off',
  })

  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE))
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`wsp:${agentKey}`)
    .setPlaceholder(
      totalPages > 1
        ? `📁 Choose a workspace… (page ${page + 1}/${totalPages})`
        : '📁 Choose a workspace…',
    )
    .addOptions(options)

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
  await interaction.editReply({
    content: `📂 **Pick a directory for \`${agentKey}\`** — or choose **Other…** to type one.`,
    components: [row],
  })
}

/** Handle a selection from the workspace picker dropdown. */
export async function handleWorkspaceSelect(
  interaction: StringSelectMenuInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  const agentKey = interaction.customId.slice('wsp:'.length)
  const value = interaction.values[0] ?? ''

  // Paginate
  if (value.startsWith(MORE)) {
    const nextPage = parseInt(value.slice(MORE.length), 10) || 0
    try {
      await interaction.deferUpdate()
    } catch {
      /* ignore */
    }
    await showWorkspacePicker(interaction, adapter, agentKey, nextPage)
    return
  }

  // One-off path via modal — showModal MUST be the first response (no defer).
  if (value === OTHER) {
    const modal = new ModalBuilder()
      .setCustomId(`wspm:${agentKey}`)
      .setTitle('Open a directory')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('path')
            .setLabel('Directory path (~ allowed)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('~/code/my-project'),
        ),
      )
    await interaction.showModal(modal)
    return
  }

  try {
    await interaction.deferUpdate()
  } catch {
    /* ignore */
  }
  await executeNewSession(interaction, adapter, agentKey, value)
}

/** Handle the "Other… (type a path)" modal submission. */
export async function handleWorkspaceModal(
  interaction: ModalSubmitInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  const agentKey = interaction.customId.slice('wspm:'.length)
  const dir = expandHome(interaction.fields.getTextInputValue('path').trim())

  try {
    await interaction.deferReply({ ephemeral: true })
  } catch {
    /* ignore */
  }
  await executeNewSession(interaction, adapter, agentKey, dir)
}
