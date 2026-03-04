import type { ApiMeta } from "./response";
import { wrapResponse } from "./response";

// -- Philippine timezone helpers --

export function getTodayPH(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

export function getFutureDatePH(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
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
