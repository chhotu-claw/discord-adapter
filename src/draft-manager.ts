import type { TextChannel, ThreadChannel } from 'discord.js'
import { MessageDraft } from './streaming.js'
import type { SendQueue } from '@openacp/plugin-sdk'
import { detectAction, storeAction, buildActionKeyboard } from './action-detect.js'

const FINAL_ONLY_IDLE_FINALIZE_MS = 2500

/**
 * Discord-specific draft manager.
 *
 * Note: Discord's MessageDraft has platform-specific features (truncation,
 * message splitting, stripPattern) that diverge significantly from the shared
 * Draft primitive. We keep the platform-specific MessageDraft for streaming
 * while following the same naming convention as other migrated classes.
 */
export class DiscordDraftManager {
  private drafts = new Map<string, MessageDraft>()
  private finalizedDrafts = new Map<string, MessageDraft>()
  private textBuffers = new Map<string, string>()
  private deferredFinalizeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private sendQueue: SendQueue,
  ) {}

  getOrCreate(
    sessionId: string,
    thread: TextChannel | ThreadChannel,
    mode: 'streaming' | 'final_only' = 'streaming',
  ): MessageDraft {
    let draft = this.drafts.get(sessionId)
    if (!draft) {
      draft = new MessageDraft(thread, this.sendQueue, sessionId, mode)
      this.drafts.set(sessionId, draft)
    }
    return draft
  }

  hasDraft(sessionId: string): boolean {
    return this.drafts.has(sessionId)
  }

  getDraft(sessionId: string): MessageDraft | undefined {
    return this.drafts.get(sessionId) ?? this.finalizedDrafts.get(sessionId)
  }

  appendText(sessionId: string, text: string): void {
    this.textBuffers.set(sessionId, (this.textBuffers.get(sessionId) ?? '') + text)
  }

  scheduleDeferredFinalize(
    sessionId: string,
    thread: TextChannel | ThreadChannel,
    isAssistant?: boolean,
    delayMs = FINAL_ONLY_IDLE_FINALIZE_MS,
  ): void {
    const existingTimer = this.deferredFinalizeTimers.get(sessionId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      this.deferredFinalizeTimers.delete(sessionId)
      void this.finalize(sessionId, thread, isAssistant)
    }, delayMs)

    this.deferredFinalizeTimers.set(sessionId, timer)
  }

  private clearDeferredFinalize(sessionId: string): void {
    const timer = this.deferredFinalizeTimers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.deferredFinalizeTimers.delete(sessionId)
  }

  /**
   * Finalize the current draft.
   * If isAssistant is true, detects action patterns in the accumulated text and sends
   * action buttons as a follow-up message.
   */
  async finalize(
    sessionId: string,
    thread?: TextChannel | ThreadChannel,
    isAssistant?: boolean,
  ): Promise<void> {
    this.clearDeferredFinalize(sessionId)
    const draft = this.drafts.get(sessionId)
    if (!draft) return

    // Delete BEFORE awaiting to prevent concurrent finalize() calls
    // from double-finalizing the same draft
    this.drafts.delete(sessionId)
    await draft.finalize()
    this.finalizedDrafts.set(sessionId, draft)

    // Detect actions in assistant responses and attach action buttons
    if (isAssistant && thread) {
      const fullText = this.textBuffers.get(sessionId)
      this.textBuffers.delete(sessionId)
      if (fullText) {
        const detected = detectAction(fullText)
        if (detected) {
          const actionId = storeAction(detected)
          const components = [buildActionKeyboard(actionId, detected)]
          try {
            await this.sendQueue.enqueue(
              () => thread.send({ components }),
              { type: 'other' },
            )
          } catch {
            // Best effort — action buttons are non-critical
          }
        }
      }
    } else {
      this.textBuffers.delete(sessionId)
    }
  }

  cleanup(sessionId: string): void {
    this.clearDeferredFinalize(sessionId)
    this.drafts.delete(sessionId)
    this.finalizedDrafts.delete(sessionId)
    this.textBuffers.delete(sessionId)
  }
}
