/**
 * ReplyDispatcher — the single place that decides HOW agent output gets sent.
 *
 * Responsibilities:
 *  1. Parse raw webhook response into individual chat bubbles
 *  2. Determine how many bubbles to send (from messages[] or by splitting text)
 *  3. Send each bubble as a separate WeChat message, with realistic typing delays
 *
 * Nothing else in the codebase should call client.sendText directly for replies.
 */

import type { WeChatClient } from "wechat-ilink-client";

/** Raw response shape returned by the Python webhook */
export interface WebhookReply {
  status: string;
  reply?: string;
  messages?: string[];
  no_reply?: boolean;
  send_time?: string;
}

/** Delay between consecutive bubbles (ms) */
const BUBBLE_DELAY_BASE_MS   = 600;
const BUBBLE_DELAY_PER_CHAR  = 55;
const BUBBLE_DELAY_MAX_MS    = 3_500;
const FOLLOWUP_DELAY_MIN_MS  = 3_000;
const FOLLOWUP_DELAY_MAX_MS  = 5_000;

export class ReplyDispatcher {
  private readonly client: WeChatClient;
  private readonly accountId: string;

  constructor(client: WeChatClient, accountId: string) {
    this.client    = client;
    this.accountId = accountId;
  }

  /**
   * Main entry point. Call this with the raw webhook response and the
   * destination user info — the dispatcher takes care of everything else.
   */
  async dispatch(
    toUser: string,
    contextToken: string | undefined,
    raw: WebhookReply,
  ): Promise<void> {
    console.log(
      `[Dispatcher] decision agent=${this.accountId} no_reply=${raw.no_reply === true} send_time=${raw.send_time ?? ""}`,
    );

    const bubbles = this.parse(raw);

    if (bubbles.length === 0) {
      console.log(`[Dispatcher] agent=${this.accountId} → no content to send`);
      return;
    }

    console.log(
      `[Dispatcher] agent=${this.accountId} → ${bubbles.length} bubble(s):`,
      bubbles,
    );

    const initialDelay = raw.send_time
      ? Math.max(0, new Date(raw.send_time).getTime() - Date.now())
      : 0;

    await this.sendBubbles(toUser, contextToken, bubbles, initialDelay);
  }

  // ── Parsing ───────────────────────────────────────────────────────────────

  /**
   * Turn raw webhook output into an ordered list of chat bubble strings.
   *
   * Priority:
   *  1. messages[] array (already split by Python brain_node)
   *  2. reply string, split by newline
   *
   * In both cases we also flatten any element that still contains \n
   * (defensive: some LLMs embed newlines inside a single JSON element).
   */
  private parse(raw: WebhookReply): string[] {
    if (raw.no_reply) return [];

    const source =
      raw.messages && raw.messages.length > 0
        ? raw.messages
        : (raw.reply?.trim() || "").split("\n");

    return source
      .flatMap((item) => item.split("\n"))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Send bubbles one by one. Each bubble is a separate sendText call.
   * A typing-simulation delay is inserted between bubbles.
   */
  private async sendBubbles(
    toUser: string,
    contextToken: string | undefined,
    bubbles: string[],
    initialDelayMs: number,
  ): Promise<void> {
    if (initialDelayMs > 0) await this.sleep(initialDelayMs);

    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];

      if (i > 0) {
        const computed = Math.min(
          BUBBLE_DELAY_BASE_MS + bubble.length * BUBBLE_DELAY_PER_CHAR,
          BUBBLE_DELAY_MAX_MS,
        );
        const jitter = Math.floor(Math.random() * 700); // small realism jitter
        const delay = Math.min(
          FOLLOWUP_DELAY_MAX_MS,
          Math.max(FOLLOWUP_DELAY_MIN_MS, computed + jitter),
        );
        await this.sleep(delay);
      }

      console.log(
        `[Dispatcher] send ${i + 1}/${bubbles.length} agent=${this.accountId}: "${bubble}"`,
      );

      try {
        await this.client.sendText(toUser, bubble, contextToken);
      } catch (err) {
        console.error(
          `[Dispatcher] sendText failed bubble ${i + 1} agent=${this.accountId}:`,
          err,
        );
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
