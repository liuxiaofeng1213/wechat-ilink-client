/**
 * BotManager — lifecycle management for WeChat iLink bot instances.
 *
 * Responsibilities:
 *  - Manage in-progress login sessions (QR code flow)
 *  - Manage running bot instances (long-poll loops)
 *  - Forward incoming WeChat messages to the Python webhook
 *  - Push status updates to Python during login (via HTTP callback)
 */

import { WeChatClient, MessageType } from "wechat-ilink-client";
import { ReplyDispatcher } from "./reply-dispatcher.js";
import type {
  BotCredentials,
  BotInstance,
  BotLifecycleEvent,
  BotStatus,
  CallbackEvent,
  LoginSession,
  LoginSessionStatus,
  RestoreBotRequest,
  StartLoginRequest,
} from "./types.js";

const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Incoming messages from the same user are buffered for MESSAGE_BATCH_WINDOW_MS
 * before being forwarded to the Python backend. This lets us capture rapid-fire
 * multi-bubble inputs (e.g. "你在干嘛" / "吃了吗" / "我睡了") and send them
 * as one combined payload so the LLM sees the complete thought.
 */
const MESSAGE_BATCH_WINDOW_MS = 15_000; // 15 seconds


interface MessageBuffer {
  lines: string[];
  contextToken: string | undefined;
  timer: ReturnType<typeof setTimeout>;
}

export class BotManager {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly bots = new Map<string, BotInstance & { client: WeChatClient }>();
  private readonly bridgeSecret: string;
  private readonly botStatusCallbackUrl: string;
  /** Key: `${accountId}:${fromUser}` */
  private readonly msgBuffers = new Map<string, MessageBuffer>();

  constructor(bridgeSecret: string, botStatusCallbackUrl: string) {
    this.bridgeSecret = bridgeSecret;
    this.botStatusCallbackUrl = botStatusCallbackUrl;
    // Periodically clean up stale login sessions
    setInterval(() => this.cleanStaleSessions(), 60_000);
  }


  // ─── Login Flow ────────────────────────────────────────────────────────────

  /**
   * Start a QR-code login session.
   * Status updates are pushed to `callbackUrl` (Python backend).
   */
  async startLogin(req: StartLoginRequest): Promise<void> {
    const { sessionId, callbackUrl } = req;

    // Abort any existing session with the same ID
    this.sessions.get(sessionId)?.abortController.abort();

    const abortController = new AbortController();
    const session: LoginSession = {
      sessionId,
      status: "pending",
      createdAt: Date.now(),
      abortController,
    };
    this.sessions.set(sessionId, session);

    // Run login in the background — do not await here
    this.runLoginFlow(session, callbackUrl).catch((err) => {
      console.error(`[BotManager] Login flow error for session=${sessionId}:`, err);
    });
  }

  private async runLoginFlow(session: LoginSession, callbackUrl: string): Promise<void> {
    const { sessionId, abortController } = session;
    const client = new WeChatClient();

    try {
      const result = await client.login({
        signal: abortController.signal,
        timeoutMs: LOGIN_SESSION_TTL_MS,
        maxRefreshes: 3,

        onQRCode: async (url) => {
          session.status = "qr_ready";
          session.qrUrl = url;
          // Must await: library waits for this; if Python rejects, login should fail loudly
          await this.pushCallback(callbackUrl, { type: "qr_code", sessionId, url });
        },

        onStatus: (status) => {
          if (status === "scaned") {
            session.status = "scanned";
            void this.pushCallback(callbackUrl, { type: "scanned", sessionId }).catch((err) =>
              console.error("[BotManager] push scanned failed:", err),
            );
          } else if (status === "expired") {
            /**
             * WeChat reports "expired" for the *current* QR image while the library
             * will immediately fetch a new QR (until maxRefreshes). This is NOT a
             * terminal failure — do not confuse the frontend or close SSE.
             */
            void this.pushCallback(callbackUrl, {
              type: "qr_expired",
              sessionId,
              detail: "current_qr_expired_will_refresh",
            }).catch((err) => console.error("[BotManager] push qr_expired failed:", err));
          }
        },
      });

      if (!result.connected) {
        session.status = "expired";
        const failMsg =
          result.message?.trim() ||
          "登录未完成。若始终无二维码，请检查：1) EchoSoul 与 Bridge 的 WECHAT_BRIDGE_SECRET 是否一致 2) Python 是否收到 /internal/wechat/callback 2xx";
        console.error(`[BotManager] login() failed for session=${sessionId}: ${failMsg}`);
        await this.pushCallback(callbackUrl, {
          type: "expired",
          sessionId,
          message: failMsg,
        });
        return;
      }

      session.status = "connected";
      const credentials: BotCredentials = {
        accountId: result.accountId!,
        token: result.botToken!,
        baseUrl: result.baseUrl!,
      };

      await this.pushCallback(callbackUrl, {
        type: "confirmed",
        sessionId,
        credentials,
      });
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") return; // Intentionally cancelled

      session.status = "error";
      this.pushCallback(callbackUrl, {
        type: "error",
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Session is terminal — remove after short delay for late consumers
      setTimeout(() => this.sessions.delete(sessionId), 30_000);
    }
  }

  getSession(sessionId: string): LoginSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ─── Bot Instance Management ───────────────────────────────────────────────

  /**
   * Restore a bot from saved credentials (called on server restart).
   * Starts the long-poll loop immediately.
   */
  async restoreBot(req: RestoreBotRequest): Promise<void> {
    const { accountId, token, baseUrl, webhookUrl, webhookToken } = req;

    if (this.bots.has(accountId)) {
      console.log(`[BotManager] Bot ${accountId} already running, skip restore`);
      return;
    }

    const client = new WeChatClient({ accountId, token, baseUrl });
    await this.startBotPolling(accountId, client, webhookUrl, webhookToken);
  }

  /**
   * Start message polling for a bot using its credentials.
   */
  async startBotFromCredentials(
    credentials: BotCredentials,
    webhookUrl: string,
    webhookToken: string,
  ): Promise<void> {
    const { accountId, token, baseUrl } = credentials;

    // Stop existing instance if any
    this.stopBot(accountId);

    const client = new WeChatClient({ accountId, token, baseUrl });
    await this.startBotPolling(accountId, client, webhookUrl, webhookToken);
  }

  private async startBotPolling(
    accountId: string,
    client: WeChatClient,
    webhookUrl: string,
    webhookToken: string,
  ): Promise<void> {
    const abortController = new AbortController();
    const instance: BotInstance & { client: WeChatClient } = {
      accountId,
      status: "starting" as BotStatus,
      startedAt: Date.now(),
      abortController,
      webhookUrl,
      webhookToken,
      client,
    };
    this.bots.set(accountId, instance);

    client.on("message", (msg) => {
      if (msg.message_type !== MessageType.USER) return;

      const fromUser     = msg.from_user_id!;
      const text         = WeChatClient.extractText(msg);
      const contextToken = msg.context_token;
      const bufKey       = `${accountId}:${fromUser}`;

      const existing = this.msgBuffers.get(bufKey);
      if (existing) {
        // Append to existing buffer and reset the flush timer
        clearTimeout(existing.timer);
        existing.lines.push(text);
        existing.timer = setTimeout(
          () => this.flushBuffer(bufKey, accountId, fromUser, webhookUrl, webhookToken, client),
          MESSAGE_BATCH_WINDOW_MS,
        );
      } else {
        // Start a new buffer
        const timer = setTimeout(
          () => this.flushBuffer(bufKey, accountId, fromUser, webhookUrl, webhookToken, client),
          MESSAGE_BATCH_WINDOW_MS,
        );
        this.msgBuffers.set(bufKey, { lines: [text], contextToken, timer });
      }
    });

    client.on("sessionExpired", () => {
      console.warn(`[BotManager] Session expired for bot=${accountId}`);
      instance.status = "expired";
      void this.pushBotStatus({
        accountId,
        status: "expired",
        reason: "iLink session expired; re-login required",
      }).catch((err) => console.error("[BotManager] push bot status failed:", err));
      abortController.abort();
      this.bots.delete(accountId);
    });

    client.on("error", (err) => {
      console.error(`[BotManager] Poll error for bot=${accountId}:`, err.message);
    });

    instance.status = "running";

    // Start long-poll loop (non-blocking)
    client
      .start({ signal: abortController.signal })
      .catch((err) => {
        if (err?.name === "AbortError" || err?.message === "aborted") return;
        console.error(`[BotManager] start() threw for bot=${accountId}:`, err);
        instance.status = "error";
      });

    console.log(`[BotManager] Bot started: accountId=${accountId}`);
  }

  // ─── Message Buffer Flush ─────────────────────────────────────────────────

  /**
   * Flush the accumulated message buffer for one user, call the Python webhook
   * with the combined text, then fan-out each reply bubble with typing delays.
   */
  private async flushBuffer(
    bufKey: string,
    accountId: string,
    fromUser: string,
    webhookUrl: string,
    webhookToken: string,
    client: WeChatClient,
  ): Promise<void> {
    const buf = this.msgBuffers.get(bufKey);
    if (!buf) return;
    this.msgBuffers.delete(bufKey);

    const { lines, contextToken } = buf;
    // Join multiple bubbles into one text block so the LLM sees the full thought
    const combinedText = lines.join("\n");

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: webhookToken,
          from_user: fromUser,
          platform: "wechat",
          content: combinedText,
          agent_id: accountId,
        }),
      });

      if (!response.ok) {
        console.error(`[BotManager] Webhook ${response.status} for agent=${accountId}`);
        return;
      }

      const data = (await response.json()) as {
        status: string;
        reply?: string;
        messages?: string[];
        no_reply?: boolean;
        send_time?: string;
      };

      const dispatcher = new ReplyDispatcher(client, accountId);
      await dispatcher.dispatch(fromUser, contextToken, data);
    } catch (err) {
      console.error(`[BotManager] flushBuffer error for agent=${accountId}:`, err);
    }
  }


  stopBot(accountId: string): boolean {
    const instance = this.bots.get(accountId);
    if (!instance) return false;

    instance.abortController.abort();
    instance.status = "stopped";
    this.bots.delete(accountId);
    console.log(`[BotManager] Bot stopped: accountId=${accountId}`);
    return true;
  }

  listBots(): { accountId: string; status: BotStatus; startedAt: number }[] {
    return Array.from(this.bots.values()).map((b) => ({
      accountId: b.accountId,
      status: b.status,
      startedAt: b.startedAt,
    }));
  }

  // ─── Message Sending ───────────────────────────────────────────────────────

  async sendText(accountId: string, to: string, text: string): Promise<void> {
    const instance = this.bots.get(accountId);
    if (!instance) {
      throw new Error(`Bot not found or not running: ${accountId}`);
    }
    await instance.client.sendText(to, text);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async pushCallback(url: string, event: CallbackEvent): Promise<void> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Secret": this.bridgeSecret,
      },
      body: JSON.stringify(event),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`Python callback ${res.status}: ${text.slice(0, 500)}`);
    }
  }

  private async pushBotStatus(event: BotLifecycleEvent): Promise<void> {
    if (!this.botStatusCallbackUrl) return;
    const res = await fetch(this.botStatusCallbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Secret": this.bridgeSecret,
      },
      body: JSON.stringify(event),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`Python bot-status callback ${res.status}: ${text.slice(0, 500)}`);
    }
  }

  private cleanStaleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > LOGIN_SESSION_TTL_MS + 60_000) {
        session.abortController.abort();
        this.sessions.delete(id);
      }
    }
  }
}
