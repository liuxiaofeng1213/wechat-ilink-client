import "dotenv/config";

/**
 * EchoSoul WeChat Bridge — Fastify HTTP server.
 *
 * Endpoints:
 *   POST /sessions/start          Start a QR-code login session
 *   GET  /sessions/:id/status     Get current session status (for polling fallback)
 *   POST /sessions/:id/abort      Abort an in-progress login session
 *
 *   POST /bots/restore            Restore a bot from saved credentials (on Python restart)
 *   POST /bots/:accountId/stop    Stop a running bot
 *   POST /bots/:accountId/send    Send a text message via a running bot
 *   GET  /bots                    List all running bots
 *
 *   GET  /health                  Health check
 *
 * Authentication: All requests must include header  X-Bridge-Secret: <secret>
 * (except /health which is unauthenticated).
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { BotManager } from "./manager.js";
import type {
  RestoreBotRequest,
  SendTextRequest,
  StartLoginRequest,
} from "./types.js";

// ─── Config from environment ──────────────────────────────────────────────────

const PORT = parseInt(process.env.BRIDGE_PORT ?? "4000", 10);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";
const PYTHON_CALLBACK_URL =
  process.env.PYTHON_CALLBACK_URL ?? "http://127.0.0.1:8000/api/v1/internal/wechat/callback";
const PYTHON_BOT_STATUS_URL =
  process.env.PYTHON_BOT_STATUS_URL ?? "http://127.0.0.1:8000/api/v1/internal/wechat/bot-status";
const PYTHON_WEBHOOK_URL =
  process.env.PYTHON_WEBHOOK_URL ?? "http://127.0.0.1:8000/api/v1/qclaw/callback";
const PYTHON_WEBHOOK_TOKEN = process.env.QCLAW_WEBHOOK_TOKEN ?? "";

if (!BRIDGE_SECRET) {
  console.error("[Bridge] FATAL: BRIDGE_SECRET environment variable is not set");
  process.exit(1);
}

// ─── Fastify app ──────────────────────────────────────────────────────────────

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  },
});

await fastify.register(cors, { origin: false });

const manager = new BotManager(BRIDGE_SECRET, PYTHON_BOT_STATUS_URL);

// ─── Auth hook ────────────────────────────────────────────────────────────────

fastify.addHook("preHandler", async (request, reply) => {
  // Skip auth for health check
  if (request.url === "/health") return;

  const secret = request.headers["x-bridge-secret"];
  if (!secret || secret !== BRIDGE_SECRET) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

fastify.get("/health", async () => ({ status: "ok", bots: manager.listBots().length }));

// ─── Login sessions ───────────────────────────────────────────────────────────

fastify.post<{ Body: { sessionId: string; callbackUrl?: string } }>("/sessions/start", async (request, reply) => {
  const { sessionId, callbackUrl } = request.body;
  if (!sessionId) {
    return reply.code(400).send({ error: "sessionId is required" });
  }

  const req: StartLoginRequest = {
    sessionId,
    // Prefer the callbackUrl sent by the caller (Python controls its own address).
    // Fall back to the env-configured URL for clients that don't supply it.
    callbackUrl: callbackUrl || PYTHON_CALLBACK_URL,
  };

  await manager.startLogin(req);
  return reply.code(202).send({ sessionId });
});

fastify.get<{ Params: { id: string } }>("/sessions/:id/status", async (request, reply) => {
  const session = manager.getSession(request.params.id);
  if (!session) {
    return reply.code(404).send({ error: "Session not found" });
  }
  return {
    sessionId: session.sessionId,
    status: session.status,
    qrUrl: session.qrUrl ?? null,
  };
});

fastify.post<{ Params: { id: string } }>("/sessions/:id/abort", async (request, reply) => {
  const session = manager.getSession(request.params.id);
  if (!session) {
    return reply.code(404).send({ error: "Session not found" });
  }
  session.abortController.abort();
  return { aborted: true };
});

// ─── Bot management ───────────────────────────────────────────────────────────

fastify.post<{ Body: RestoreBotRequest }>("/bots/restore", async (request, reply) => {
  const { accountId, token, baseUrl } = request.body;
  if (!accountId || !token || !baseUrl) {
    return reply.code(400).send({ error: "accountId, token and baseUrl are required" });
  }

  await manager.restoreBot({
    accountId,
    token,
    baseUrl,
    webhookUrl: PYTHON_WEBHOOK_URL,
    webhookToken: PYTHON_WEBHOOK_TOKEN,
  });

  return { restored: true, accountId };
});

fastify.post<{ Params: { accountId: string } }>("/bots/:accountId/stop", async (request, reply) => {
  const stopped = manager.stopBot(request.params.accountId);
  if (!stopped) {
    return reply.code(404).send({ error: "Bot not found" });
  }
  return { stopped: true };
});

fastify.post<{ Params: { accountId: string }; Body: SendTextRequest }>(
  "/bots/:accountId/send",
  async (request, reply) => {
    const { to, text } = request.body;
    if (!to || !text) {
      return reply.code(400).send({ error: "to and text are required" });
    }
    try {
      await manager.sendText(request.params.accountId, to, text);
      return { sent: true };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  },
);

fastify.get("/bots", async () => ({ bots: manager.listBots() }));

// ─── Startup ──────────────────────────────────────────────────────────────────

try {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`[Bridge] Listening on ${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
