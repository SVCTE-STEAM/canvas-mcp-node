import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consumeConfirmationToken,
  hashArgs,
  issueConfirmationToken,
  previewResult,
  resetConfirmationTokens,
} from "../../src/tools/confirmGate.js";
import { parseJsonResult } from "../_helpers/mockCanvas.js";

afterEach(() => {
  resetConfirmationTokens();
  vi.useRealTimers();
});

describe("confirmGate", () => {
  const args = { course_identifier: "BIO 101", recipient_ids: ["1", "2"], subject: "Hi", body: "Reminder" };

  it("accepts a token for identical args exactly once", () => {
    const token = issueConfirmationToken("send_conversation", args);
    expect(consumeConfirmationToken("send_conversation", { ...args, confirmation_token: token }, token)).toEqual({ ok: true });
    const replay = consumeConfirmationToken("send_conversation", args, token);
    expect(replay.ok).toBe(false);
  });

  it("voids the token when any argument changes after the preview", () => {
    const token = issueConfirmationToken("send_conversation", args);
    const changed = consumeConfirmationToken("send_conversation", { ...args, body: "Different" }, token);
    expect(changed).toMatchObject({ ok: false });
    expect((changed as { reason: string }).reason).toMatch(/changed/);
  });

  it("refuses a token issued for a different tool", () => {
    const token = issueConfirmationToken("bulk_update_pages", args);
    expect(consumeConfirmationToken("send_conversation", args, token).ok).toBe(false);
  });

  it("refuses unknown and expired tokens", () => {
    expect(consumeConfirmationToken("send_conversation", args, "nope").ok).toBe(false);
    vi.useFakeTimers();
    const token = issueConfirmationToken("send_conversation", args);
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(consumeConfirmationToken("send_conversation", args, token).ok).toBe(false);
  });

  it("hashes key order and the token field out of the comparison", () => {
    const reordered = { body: "Reminder", subject: "Hi", recipient_ids: ["1", "2"], course_identifier: "BIO 101" };
    expect(hashArgs(reordered)).toBe(hashArgs({ ...args, confirmation_token: "abc" }));
    expect(hashArgs({ ...args, recipient_ids: ["2", "1"] })).not.toBe(hashArgs(args));
  });

  it("previewResult says nothing was written and carries a usable token", () => {
    const result = previewResult("send_conversation", args, { recipient_count: 2 }, "Would message 2 students.");
    const text = result.content[0].text;
    expect(text).toMatch(/^PREVIEW ONLY — nothing was written/);
    const payload = parseJsonResult<{ preview_only: boolean; confirmation_token: string; recipient_count: number }>(result);
    expect(payload.preview_only).toBe(true);
    expect(payload.recipient_count).toBe(2);
    expect(consumeConfirmationToken("send_conversation", args, payload.confirmation_token)).toEqual({ ok: true });
  });
});
