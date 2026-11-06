import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type FakeResponse,
  type RequestRecord,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { Anonymizer } from "../../src/anonymizer.js";
import { resetConfirmationTokens } from "../../src/tools/confirmGate.js";
import {
  CONVERSATION_SCRUB_NOTE,
  NO_COURSE_CONTEXT_NOTE,
  registerMessagingTools,
} from "../../src/tools/messaging.js";

const COURSE_ID = 60366;

const STUDENT_PAGE: FakeResponse = {
  status: 200,
  data: [
    { id: 1001, name: "Grace Park" },
    { id: 1002, name: "Ana Maria" },
  ],
};
const STAFF_PAGE: FakeResponse = { status: 200, data: [{ id: 5000, name: "Mr. Smith" }] };

/** resolveRecipients fetches the student roster, then the staff roster. */
const RECIPIENT_ROSTER: FakeResponse[] = [STUDENT_PAGE, STAFF_PAGE];
/** buildCourseScrubber fetches the staff roster, then the student roster. */
const SCRUBBER_ROSTER: FakeResponse[] = [STAFF_PAGE, STUDENT_PAGE];
const SELF: FakeResponse = { status: 200, data: { id: 5000, name: "Mr. Smith" } };

const REAL_NAMES = /Grace|Park|Ana Maria|Parent Person/;

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-messaging-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
  resetConfirmationTokens();
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
});

function buildHarness(responses: FakeResponse[]) {
  const mock = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerMessagingTools(harness.server as never, mock.client, anonymizer);
  return { harness, requests: mock.requests, enqueue: mock.enqueue };
}

function posts(requests: RequestRecord[]): RequestRecord[] {
  return requests.filter((request) => request.method === "POST");
}

function textOf(result: ToolResponse): string {
  return result.content?.[0]?.text ?? "";
}

const postOk = (id: number): FakeResponse => ({ status: 200, data: [{ id }] });

describe("registerMessagingTools", () => {
  it("registers the six messaging tools", () => {
    const { harness } = buildHarness([]);
    expect([...harness.tools.keys()].sort()).toEqual([
      "get_conversation_details",
      "get_unread_count",
      "list_conversations",
      "mark_conversations_read",
      "send_bulk_messages_from_list",
      "send_conversation",
    ]);
    expect(harness.tools.get("send_conversation")?.description).toMatch(/\{first_name\}/);
  });

  describe("send_conversation", () => {
    const baseArgs = {
      course_identifier: COURSE_ID,
      recipient_ids: ["1001", "1002"],
      subject: "Hi {first_name}",
      body: "Reminder for {first_name}: essay due Friday.",
    };

    it("preview returns pseudonymized recipients and a token, and sends nothing", async () => {
      const { harness, requests } = buildHarness([...RECIPIENT_ROSTER]);
      const result = await harness.call("send_conversation", baseArgs);
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.preview_only).toBe(true);
      expect(payload.confirmation_token).toEqual(expect.any(String));
      expect(payload.recipients).toEqual([
        { user_id: "1001", recipient: "Student 1" },
        { user_id: "1002", recipient: "Student 2" },
      ]);
      expect(payload.subject).toBe("Hi {first_name}");
      expect(payload.personalized).toBe(true);
      expect(posts(requests)).toHaveLength(0);
      expect(requests[0]?.params).toMatchObject({ "enrollment_type[]": ["student"] });
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("with a valid token sends one personalized private message per recipient and reports pseudonyms", async () => {
      const { harness, requests, enqueue } = buildHarness([...RECIPIENT_ROSTER]);
      const preview = parseJsonResult(await harness.call("send_conversation", baseArgs));
      [...RECIPIENT_ROSTER, postOk(9001), postOk(9002)].forEach(enqueue);

      const result = await harness.call("send_conversation", {
        ...baseArgs,
        confirmation_token: preview.confirmation_token,
      });
      expect(result.isError).toBeFalsy();
      const sent = posts(requests);
      expect(sent).toHaveLength(2);
      expect(sent[0]?.url).toBe("/api/v1/conversations");
      expect(sent[0]?.data).toMatchObject({
        recipients: ["1001"],
        subject: "Hi Grace",
        body: "Reminder for Grace: essay due Friday.",
        context_code: `course_${COURSE_ID}`,
        group_conversation: false,
      });
      expect(sent[1]?.data).toMatchObject({ recipients: ["1002"], subject: "Hi Ana" });

      const payload = parseJsonResult(result);
      expect(payload.sent).toBe(2);
      expect(payload.failed).toBe(0);
      expect((payload.results as Array<{ recipient: string }>).map((entry) => entry.recipient)).toEqual([
        "Student 1",
        "Student 2",
      ]);
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("requires a valid token: an unknown token sends nothing", async () => {
      const { harness, requests } = buildHarness([...RECIPIENT_ROSTER]);
      const result = await harness.call("send_conversation", { ...baseArgs, confirmation_token: "not-a-real-token" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Nothing was sent/);
      expect(posts(requests)).toHaveLength(0);
    });

    it("changing any argument after the preview voids the token", async () => {
      const { harness, requests, enqueue } = buildHarness([...RECIPIENT_ROSTER]);
      const preview = parseJsonResult(await harness.call("send_conversation", baseArgs));
      RECIPIENT_ROSTER.forEach(enqueue);
      const result = await harness.call("send_conversation", {
        ...baseArgs,
        body: "A reworded body the teacher never saw.",
        confirmation_token: preview.confirmation_token,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Arguments changed/);
      expect(posts(requests)).toHaveLength(0);
    });

    it("a token is single-use", async () => {
      const { harness, requests, enqueue } = buildHarness([...RECIPIENT_ROSTER]);
      const preview = parseJsonResult(await harness.call("send_conversation", baseArgs));
      [...RECIPIENT_ROSTER, postOk(9001), postOk(9002), ...RECIPIENT_ROSTER].forEach(enqueue);
      const confirmArgs = { ...baseArgs, confirmation_token: preview.confirmation_token };
      expect((await harness.call("send_conversation", confirmArgs)).isError).toBeFalsy();
      const replay = await harness.call("send_conversation", confirmArgs);
      expect(replay.isError).toBe(true);
      expect(textOf(replay)).toMatch(/already used/);
      expect(posts(requests)).toHaveLength(2);
    });

    it("refuses recipient ids that are not enrolled in the course, listing them, without issuing a token", async () => {
      const { harness, requests } = buildHarness([...RECIPIENT_ROSTER]);
      const result = await harness.call("send_conversation", { ...baseArgs, recipient_ids: ["1001", "9999", "424242"] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/9999, 424242/);
      expect(textOf(result)).not.toMatch(/confirmation_token/);
      expect(posts(requests)).toHaveLength(0);
    });

    it("rejects an empty subject before any Canvas call", async () => {
      const { harness, requests } = buildHarness([]);
      const result = await harness.call("send_conversation", { ...baseArgs, subject: "   " });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/subject must not be empty/);
      expect(requests).toHaveLength(0);
    });

    it("resolves a course code with bypassCache on every call (write path)", async () => {
      const courseList: FakeResponse = { status: 200, data: [{ id: COURSE_ID, course_code: "BIO-101", name: "Biology" }] };
      const { harness, requests, enqueue } = buildHarness([courseList, ...RECIPIENT_ROSTER]);
      const args = { ...baseArgs, course_identifier: "BIO-101" };
      const first = parseJsonResult(await harness.call("send_conversation", args));
      expect(first.course_code).toBe("BIO-101");
      [courseList, ...RECIPIENT_ROSTER].forEach(enqueue);
      await harness.call("send_conversation", args);
      expect(requests.filter((request) => request.url === "/api/v1/courses")).toHaveLength(2);
    });

    it("reports a per-recipient failure without failing the whole call", async () => {
      const { harness, enqueue } = buildHarness([...RECIPIENT_ROSTER]);
      const preview = parseJsonResult(await harness.call("send_conversation", baseArgs));
      [...RECIPIENT_ROSTER, postOk(9001), { status: 400, data: { errors: [{ message: "bad" }] } }].forEach(enqueue);
      const result = await harness.call("send_conversation", { ...baseArgs, confirmation_token: preview.confirmation_token });
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.sent).toBe(1);
      expect(payload.failed).toBe(1);
      const results = payload.results as Array<{ recipient: string; ok: boolean }>;
      expect(results[1]).toMatchObject({ recipient: "Student 2", ok: false });
      expect(textOf(result)).toMatch(/1 FAILED/);
    });
  });

  describe("send_bulk_messages_from_list", () => {
    const rows = [
      { user_id: 1001, subject: "Missing work, {first_name}", body: "You are missing Lab 2." },
      { user_id: "1002", subject: "Great job", body: "Your essay was excellent, {name}." },
    ];
    const baseArgs = { course_identifier: COURSE_ID, messages: rows };

    it("preview shows every row with pseudonyms and sends nothing", async () => {
      const { harness, requests } = buildHarness([...RECIPIENT_ROSTER]);
      const result = await harness.call("send_bulk_messages_from_list", baseArgs);
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect(payload.preview_only).toBe(true);
      expect(payload.message_count).toBe(2);
      expect(payload.messages).toEqual([
        { row: 0, user_id: "1001", recipient: "Student 1", subject: rows[0]!.subject, body: rows[0]!.body },
        { row: 1, user_id: "1002", recipient: "Student 2", subject: rows[1]!.subject, body: rows[1]!.body },
      ]);
      expect(posts(requests)).toHaveLength(0);
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("with a valid token sends each row's own message", async () => {
      const { harness, requests, enqueue } = buildHarness([...RECIPIENT_ROSTER]);
      const preview = parseJsonResult(await harness.call("send_bulk_messages_from_list", baseArgs));
      [...RECIPIENT_ROSTER, postOk(1), postOk(2)].forEach(enqueue);
      const result = await harness.call("send_bulk_messages_from_list", {
        ...baseArgs,
        confirmation_token: preview.confirmation_token,
      });
      expect(result.isError).toBeFalsy();
      const sent = posts(requests);
      expect(sent.map((request) => request.data)).toEqual([
        expect.objectContaining({ recipients: ["1001"], subject: "Missing work, Grace", body: "You are missing Lab 2." }),
        expect.objectContaining({ recipients: ["1002"], subject: "Great job", body: "Your essay was excellent, Ana Maria." }),
      ]);
      const payload = parseJsonResult(result);
      expect(payload.sent).toBe(2);
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("an invalid row refuses the whole batch before any Canvas call", async () => {
      const { harness, requests } = buildHarness([]);
      const result = await harness.call("send_bulk_messages_from_list", {
        course_identifier: COURSE_ID,
        messages: [rows[0], { user_id: 1002, subject: "Hello", body: "" }],
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/row 1 \(user_id 1002\): body must not be empty/);
      expect(requests).toHaveLength(0);
    });

    it("refuses duplicate and non-numeric user ids", async () => {
      const { harness, requests } = buildHarness([]);
      const result = await harness.call("send_bulk_messages_from_list", {
        course_identifier: COURSE_ID,
        messages: [rows[0], { ...rows[0], subject: "again" }, { user_id: "course_60366", subject: "x", body: "y" }],
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/row 1 \(user_id 1001\): user_id appears in more than one row/);
      expect(textOf(result)).toMatch(/row 2 \(user_id course_60366\): user_id must be a plain numeric/);
      expect(requests).toHaveLength(0);
    });

    it("refuses rows addressed to users outside the course", async () => {
      const { harness, requests } = buildHarness([...RECIPIENT_ROSTER]);
      const result = await harness.call("send_bulk_messages_from_list", {
        course_identifier: COURSE_ID,
        messages: [...rows, { user_id: 31337, subject: "x", body: "y" }],
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/31337/);
      expect(posts(requests)).toHaveLength(0);
    });

    it("edited rows void the token, and a used token cannot be replayed", async () => {
      const { harness, requests, enqueue } = buildHarness([...RECIPIENT_ROSTER]);
      const preview = parseJsonResult(await harness.call("send_bulk_messages_from_list", baseArgs));
      RECIPIENT_ROSTER.forEach(enqueue);
      const edited = await harness.call("send_bulk_messages_from_list", {
        course_identifier: COURSE_ID,
        messages: [rows[0], { ...rows[1], body: "Changed after preview." }],
        confirmation_token: preview.confirmation_token,
      });
      expect(edited.isError).toBe(true);
      expect(textOf(edited)).toMatch(/Arguments changed/);
      expect(posts(requests)).toHaveLength(0);

      [...RECIPIENT_ROSTER, postOk(1), postOk(2), ...RECIPIENT_ROSTER].forEach(enqueue);
      const confirmArgs = { ...baseArgs, confirmation_token: preview.confirmation_token };
      expect((await harness.call("send_bulk_messages_from_list", confirmArgs)).isError).toBeFalsy();
      const replay = await harness.call("send_bulk_messages_from_list", confirmArgs);
      expect(replay.isError).toBe(true);
      expect(posts(requests)).toHaveLength(2);
    });
  });

  describe("list_conversations", () => {
    const courseConversation = {
      id: 11,
      subject: "Question from Grace",
      workflow_state: "unread",
      last_message: "Hi Mr. Smith, this is Grace Park about the lab.",
      last_message_at: "2026-10-01T12:00:00Z",
      message_count: 2,
      starred: false,
      context_code: `course_${COURSE_ID}`,
      context_name: "Biology",
      avatar_url: "https://example.com/avatar.png",
      audience: [1001],
      participants: [
        { id: 5000, name: "Mr. Smith", full_name: "Mr. Smith" },
        { id: 1001, name: "Grace Park", full_name: "Grace Park" },
      ],
    };

    it("pseudonymizes non-staff participants and scrubs subject/preview by default", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: [courseConversation] },
        SELF,
        ...SCRUBBER_ROSTER,
      ]);
      const result = await harness.call("list_conversations", {});
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/conversations");
      expect(requests[0]?.params).toMatchObject({ scope: "unread", per_page: 20 });
      expect(requests[1]?.url).toBe("/api/v1/users/self");

      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(true);
      expect(payload.warnings).toContain(CONVERSATION_SCRUB_NOTE);
      const [conversation] = payload.conversations as Array<Record<string, unknown>>;
      expect(conversation?.participants).toEqual([
        { id: 5000, name: "Mr. Smith" },
        { id: 1001, name: "Student 1" },
      ]);
      expect(conversation?.subject).toBe("Question from Student 1");
      expect(conversation?.last_message).toBe("Hi Mr. Smith, this is Student 1 about the lab.");
      expect(conversation).not.toHaveProperty("avatar_url");
      expect(conversation).not.toHaveProperty("audience");
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("fails closed when a conversation has no course context: every non-self participant is pseudonymized", async () => {
      const { harness, requests } = buildHarness([
        {
          status: 200,
          data: [
            {
              id: 12,
              subject: "From Parent Person",
              last_message: "Grace Park's parent here, Parent Person.",
              context_code: "user_5000",
              context_name: "Parent Person",
              participants: [
                { id: 5000, name: "Mr. Smith" },
                { id: 1001, name: "Grace Park" },
                { id: 7777, name: "Parent Person" },
              ],
            },
          ],
        },
        SELF,
      ]);
      const result = await harness.call("list_conversations", { scope: "all" });
      expect(result.isError).toBeFalsy();
      expect(requests).toHaveLength(2);
      expect(requests[0]?.params).not.toHaveProperty("scope");
      const payload = parseJsonResult(result);
      expect(payload.warnings).toContain(NO_COURSE_CONTEXT_NOTE);
      const [conversation] = payload.conversations as Array<{ participants: Array<{ id: number; name: string }> } & Record<string, unknown>>;
      expect(conversation?.participants[0]).toEqual({ id: 5000, name: "Mr. Smith" });
      expect(conversation?.participants[1]?.name).toMatch(/^Student \d+$/);
      expect(conversation?.participants[2]?.name).toMatch(/^Student \d+$/);
      expect(conversation?.course_code).toBeNull();
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("filters by course and reports more_available from the Link header", async () => {
      const { harness, requests } = buildHarness([
        {
          status: 200,
          data: [],
          headers: { link: '<https://canvas.example.com/api/v1/conversations?page=2>; rel="next"' },
        },
      ]);
      const result = await harness.call("list_conversations", { course_identifier: COURSE_ID, scope: "sent", limit: 5 });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.params).toMatchObject({ scope: "sent", "filter[]": [`course_${COURSE_ID}`], per_page: 5 });
      const payload = parseJsonResult(result);
      expect(payload.more_available).toBe(true);
      expect(payload.returned).toBe(0);
    });

    it("anonymous=false without the operator opt-in still anonymizes and warns", async () => {
      const { harness } = buildHarness([{ status: 200, data: [courseConversation] }, SELF, ...SCRUBBER_ROSTER]);
      const result = await harness.call("list_conversations", { anonymous: false });
      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(true);
      expect((payload.warnings as string[])[0]).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("anonymous=false with the operator opt-in returns real names without roster calls", async () => {
      process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
      const { harness, requests } = buildHarness([{ status: 200, data: [courseConversation] }]);
      const result = await harness.call("list_conversations", { anonymous: false });
      expect(requests).toHaveLength(1);
      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(false);
      expect(payload.warnings).toBeUndefined();
      const [conversation] = payload.conversations as Array<{ participants: Array<{ name: string }> }>;
      expect(conversation?.participants[1]?.name).toBe("Grace Park");
    });

    it("surfaces a Canvas error as a tool error", async () => {
      const { harness } = buildHarness([{ status: 401, data: { errors: [{ message: "Invalid access token." }] } }]);
      const result = await harness.call("list_conversations", {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/list_conversations: .*401/);
    });
  });

  describe("get_conversation_details", () => {
    const detail = {
      id: 11,
      subject: "Lab question",
      workflow_state: "unread",
      message_count: 2,
      context_code: `course_${COURSE_ID}`,
      context_name: "Biology",
      participants: [
        { id: 5000, name: "Mr. Smith" },
        { id: 1001, name: "Grace Park" },
      ],
      messages: [
        {
          id: 2,
          created_at: "2026-10-01T12:05:00Z",
          author_id: 5000,
          body: "Sure Grace, come by after class.",
          participating_user_ids: [5000, 1001],
        },
        {
          id: 1,
          created_at: "2026-10-01T12:00:00Z",
          author_id: 1001,
          body: "Hi, this is Grace Park. Ana Maria and I have a question.",
          attachments: [{ id: 77, display_name: "Grace Park lab.pdf", content_type: "application/pdf", size: 1234, url: "https://x" }],
          forwarded_messages: [{ id: 0, author_id: 1002, body: "Forwarded from Ana Maria" }],
        },
      ],
    };

    it("never marks the conversation read and anonymizes authors, bodies, attachments and forwards", async () => {
      const { harness, requests } = buildHarness([{ status: 200, data: detail }, SELF, ...SCRUBBER_ROSTER]);
      const result = await harness.call("get_conversation_details", { conversation_id: 11 });
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe("/api/v1/conversations/11");
      expect(requests[0]?.params).toMatchObject({ auto_mark_as_read: false });

      const payload = parseJsonResult(result);
      const messages = payload.messages as Array<Record<string, unknown>>;
      expect(messages[0]).toMatchObject({ author_id: 5000, author_name: "Mr. Smith", body: "Sure Student 1, come by after class." });
      expect(messages[1]).toMatchObject({
        author_id: 1001,
        author_name: "Student 1",
        body: "Hi, this is Student 1. Student 2 and I have a question.",
      });
      expect(messages[1]?.attachments).toEqual([
        { id: 77, display_name: "Student 1 lab.pdf", content_type: "application/pdf", size: 1234 },
      ]);
      const forwarded = messages[1]?.forwarded_messages as Array<Record<string, unknown>>;
      expect(forwarded[0]).toMatchObject({ author_id: 1002, author_name: null, body: "Forwarded from Student 2" });
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("omits messages when include_messages=false", async () => {
      const { harness } = buildHarness([{ status: 200, data: detail }, SELF, ...SCRUBBER_ROSTER]);
      const payload = parseJsonResult(await harness.call("get_conversation_details", { conversation_id: "11", include_messages: false }));
      expect(payload).not.toHaveProperty("messages");
      expect(payload.participants).toEqual([
        { id: 5000, name: "Mr. Smith" },
        { id: 1001, name: "Student 1" },
      ]);
    });

    it("rejects a non-numeric conversation id before any Canvas call", async () => {
      const { harness, requests } = buildHarness([]);
      const result = await harness.call("get_conversation_details", { conversation_id: "11/../../users" });
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(0);
    });

    it("surfaces a 404 as a tool error", async () => {
      const { harness } = buildHarness([{ status: 404, data: { errors: [{ message: "not found" }] } }]);
      const result = await harness.call("get_conversation_details", { conversation_id: 404 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/404/);
    });
  });

  describe("get_unread_count", () => {
    it("parses Canvas's string count", async () => {
      const { harness, requests } = buildHarness([{ status: 200, data: { unread_count: "3" } }]);
      const result = await harness.call("get_unread_count", {});
      expect(requests[0]?.url).toBe("/api/v1/conversations/unread_count");
      expect(parseJsonResult(result).unread_count).toBe(3);
    });

    it("returns a tool error on failure", async () => {
      const { harness } = buildHarness([{ status: 500, data: {} }]);
      expect((await harness.call("get_unread_count", {})).isError).toBe(true);
    });
  });

  describe("mark_conversations_read", () => {
    it("PUTs the deduplicated ids with event=mark_as_read", async () => {
      const { harness, requests } = buildHarness([{ status: 200, data: { id: 55, workflow_state: "queued" } }]);
      const result = await harness.call("mark_conversations_read", { conversation_ids: [11, "12", "11"] });
      expect(result.isError).toBeFalsy();
      expect(requests[0]).toMatchObject({
        method: "PUT",
        url: "/api/v1/conversations",
        data: { conversation_ids: ["11", "12"], event: "mark_as_read" },
      });
      expect(parseJsonResult(result)).toMatchObject({ marked_read: 2, progress: { id: 55, workflow_state: "queued" } });
    });

    it("rejects empty or non-numeric ids without calling Canvas", async () => {
      const { harness, requests } = buildHarness([]);
      expect((await harness.call("mark_conversations_read", { conversation_ids: [] })).isError).toBe(true);
      const bad = await harness.call("mark_conversations_read", { conversation_ids: ["12", "course_1"] });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toMatch(/course_1/);
      expect(requests).toHaveLength(0);
    });
  });
});
