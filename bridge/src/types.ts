/**
 * Shared TypeScript types for the EchoSoul WeChat Bridge service.
 */

// ─── Login Session ───────────────────────────────────────────────────────────

export type LoginSessionStatus =
  | "pending"    // QR not yet generated
  | "qr_ready"   // QR URL available, waiting for user to scan
  | "scanned"    // User scanned, awaiting confirmation in WeChat
  | "connected"  // Login successful, credentials ready
  | "expired"    // QR expired and max refreshes reached
  | "error";     // Fatal error during login

export interface LoginSession {
  sessionId: string;
  status: LoginSessionStatus;
  qrUrl?: string;
  createdAt: number;
  abortController: AbortController;
}

// ─── Bot Instance ─────────────────────────────────────────────────────────────

export interface BotCredentials {
  accountId: string;
  token: string;
  baseUrl: string;
}

export type BotStatus = "starting" | "running" | "stopped" | "expired" | "error";

export interface BotInstance {
  accountId: string;
  status: BotStatus;
  startedAt: number;
  abortController: AbortController;
  webhookUrl: string;
  webhookToken: string;
}

// ─── Bridge API Payloads ──────────────────────────────────────────────────────

export interface StartLoginRequest {
  sessionId: string;
  /** Python callback endpoint for push notifications */
  callbackUrl: string;
}

export interface StartLoginResponse {
  sessionId: string;
}

export interface RestoreBotRequest {
  accountId: string;
  token: string;
  baseUrl: string;
  webhookUrl: string;
  webhookToken: string;
}

export interface SendTextRequest {
  to: string;
  text: string;
  contextToken?: string;
}

// ─── Push Notification Payloads (Bridge → Python) ────────────────────────────

export type CallbackEventType =
  | "qr_code"
  | "scanned"
  | "qr_expired"
  | "confirmed"
  | "expired"
  | "error";

export interface QrCodeEvent {
  type: "qr_code";
  sessionId: string;
  url: string;
}

export interface ScannedEvent {
  type: "scanned";
  sessionId: string;
}

export interface QrExpiredEvent {
  type: "qr_expired";
  sessionId: string;
  detail?: string;
}

export interface ConfirmedEvent {
  type: "confirmed";
  sessionId: string;
  credentials: BotCredentials;
}

export interface ExpiredEvent {
  type: "expired";
  sessionId: string;
  message?: string;
}

export interface ErrorEvent {
  type: "error";
  sessionId: string;
  message: string;
}

export type CallbackEvent =
  | QrCodeEvent
  | ScannedEvent
  | QrExpiredEvent
  | ConfirmedEvent
  | ExpiredEvent
  | ErrorEvent;

export interface BotLifecycleEvent {
  accountId: string;
  status: "active" | "inactive" | "expired" | "error";
  reason?: string;
}
