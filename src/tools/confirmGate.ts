import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { jsonResult, type McpTextResult } from "./toolHelpers.js";

/**
 * Two-step confirmation for outward-facing or bulk writes (messages to
 * students, discussion posts, bulk page edits, accessibility fixes).
 *
 * A boolean `confirm: true` flag would let the model skip the preview on its
 * first call. A token bound to a hash of the exact arguments forces a preview
 * call first, and any edit after the preview (different recipients, reworded
 * body) voids the token, so what the teacher approved is what gets sent.
 */

const TOKEN_TTL_MS = 15 * 60 * 1000;

interface PendingToken {
  action: string;
  argsHash: string;
  expiresAt: number;
}

const pending = new Map<string, PendingToken>();

export const CONFIRMATION_TOKEN_PARAM = z
  .string()
  .optional()
  .describe(
    "Omit on the first call: you get a PREVIEW and a confirmation_token, and nothing is written. " +
      "Show the preview to the teacher; only after they approve, call again with identical arguments plus this token.",
  );

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function hashArgs(args: Record<string, unknown>): string {
  const { confirmation_token: _ignored, ...rest } = args;
  return createHash("sha256").update(JSON.stringify(canonicalize(rest))).digest("hex");
}

function sweepExpired(now: number): void {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

export function issueConfirmationToken(action: string, args: Record<string, unknown>): string {
  const now = Date.now();
  sweepExpired(now);
  const token = randomBytes(12).toString("hex");
  pending.set(token, { action, argsHash: hashArgs(args), expiresAt: now + TOKEN_TTL_MS });
  return token;
}

/**
 * Consume a token. Single-use: a valid token is deleted on success so a
 * replayed call cannot send the same messages twice.
 */
export function consumeConfirmationToken(
  action: string,
  args: Record<string, unknown>,
  token: string,
): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  sweepExpired(now);
  const entry = pending.get(token);
  if (!entry) {
    return {
      ok: false,
      reason:
        "confirmation_token is unknown, expired (15 min), or already used. Call again WITHOUT a token to get a fresh preview.",
    };
  }
  if (entry.action !== action) {
    return { ok: false, reason: `confirmation_token was issued for ${entry.action}, not ${action}.` };
  }
  if (entry.argsHash !== hashArgs(args)) {
    return {
      ok: false,
      reason:
        "Arguments changed since the preview, so the token is void. Call again WITHOUT a token to preview the new version.",
    };
  }
  pending.delete(token);
  return { ok: true };
}

/** Standard preview response: nothing was written; here is what would be. */
export function previewResult(
  action: string,
  args: Record<string, unknown>,
  preview: Record<string, unknown>,
  summary: string,
): McpTextResult {
  const token = issueConfirmationToken(action, args);
  return jsonResult(
    { preview_only: true, action, ...preview, confirmation_token: token, token_expires_in_minutes: TOKEN_TTL_MS / 60000 },
    {
      summary:
        `PREVIEW ONLY — nothing was written. ${summary} ` +
        "Show this preview to the teacher. Only if they approve, call the same tool again with identical arguments plus confirmation_token.",
    },
  );
}

/** Test-only: clear all pending tokens. */
export function resetConfirmationTokens(): void {
  pending.clear();
}
