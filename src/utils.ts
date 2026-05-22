import type { ApiMeta } from "./response";
import { wrapResponse } from "./response";

// -- Philippine timezone helpers --

export function getTodayPH(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

export function getFutureDatePH(days: number): string {
  // Anchor on the Manila calendar day, then add days with pure UTC date math.
  // The previous version did setDate() in the runtime timezone before
  // formatting in Manila, so on a UTC runtime (Cloudflare Workers) near PH
  // midnight the base day and the formatted day could disagree, throwing the
  // expiry window off by one. Anchoring on getTodayPH() removes that drift.
  const [y, m, d] = getTodayPH().split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// -- Logging --

export function log(message: string): void {
  console.log(`[lts-mcp] ${message}`);
}

export function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  console.error(`[lts-mcp] ERROR: ${message}${detail ? ` - ${detail}` : ""}`);
}

// -- Response formatting --

export function toolResult(data: unknown, meta: ApiMeta) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(wrapResponse(data, meta), null, 2) }],
  };
}

export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Log full error details server-side, return generic message to client */
export function safeToolError(userMessage: string, err: unknown) {
  logError(userMessage, err);
  return toolError(userMessage);
}
