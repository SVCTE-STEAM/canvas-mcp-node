import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type FakeResponse,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { Anonymizer } from "../../src/anonymizer.js";
import { CanvasClient } from "../../src/canvasClient.js";
import { registerDiscussionEntryTools } from "../../src/tools/discussionEntries.js";
import { DISCUSSION_SCRUB_NOTE } from "../../src/tools/discussionAnonymizer.js";
import { resetConfirmationTokens } from "../../src/tools/confirmGate.js";

const COURSE_ID = 60366;
const TOPICS = `/api/v1/courses/${COURSE_ID}/discussion_topics`;

const STAFF_PAGE: FakeResponse = { status: 200, data: [{ id: 5000, name: "Mr. Smith" }] };
const STUDENT_PAGE: FakeResponse = {
  status: 200,
  data: [
    { id: 1001, name: "Grace Park" },
    { id: 1002, name: "Ana Maria" },
    { id: 1003, name: "Ben Cho" },
  ],
};

const TOPIC: FakeResponse = {
  status: 200,
  data: { id: 42, title: "Week 5 debate", published: true, locked: false, is_announcement: false },
};

const LONG_TEXT = "x".repeat(400);

const ENTRIES: FakeResponse = {
  status: 200,
  data: [
    {
      id: 101,
      user_id: 1001,
      user_name: "Grace Park",
      message: "<p>I agree with <b>Ana Maria</b>!</p><p>Also Gr&#97;ce here.</p>",
      created_at: "2026-05-02T09:00:00Z",
      recent_replies: [{ id: 201, user_id: 1002, user_name: "Ana Maria", message: "<p>Thanks Grace</p>" }],
      has_more_replies: false,
      attachment: { display_name: "Grace_Park_essay.pdf" },
    },
    {
      id: 102,
      user_id: 5000,
      user_name: "Mr. Smith",
      message: `<p>${LONG_TEXT}</p>`,
      created_at: "2026-05-02T10:00:00Z",
    },
  ],
};

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-disc-entries-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
  resetConfirmationTokens();
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
});

function buildHarness(responses: FakeResponse[]) {
  const mock = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerDiscussionEntryTools(harness.server as never, mock.client, anonymizer);
  return { harness, requests: mock.requests, enqueue: mock.enqueue };
}

function expectNoRawStudentNames(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  for (const fragment of ["Grace", "Park", "Ana", "Maria", "Ben Cho"]) {
    expect(serialized).not.toContain(fragment);
  }
}

function errorText(result: ToolResponse): string {
  return result.content?.[0]?.text ?? "";
}

describe("registerDiscussionEntryTools", () => {
  it("registers exactly the four entry tools", () => {
    const { harness } = buildHarness([]);
    expect([...harness.tools.keys()].sort()).toEqual([
      "get_discussion_entry_details",
      "list_discussion_entries",
      "post_discussion_entry",
      "reply_to_discussion_entry",
    ]);
  });
});

describe("list_discussion_entries", () => {
  it("anonymizes authors and bodies (including entity-encoded names), trims previews, and summarizes participation", async () => {
    const { harness, requests } = buildHarness([TOPIC, ENTRIES, STAFF_PAGE, STUDENT_PAGE, STUDENT_PAGE]);
    const result = await harness.call("list_discussion_entries", { course_identifier: COURSE_ID, topic_id: 42 });

    expect(requests.map((request) => request.url)).toEqual([
      `${TOPICS}/42`,
      `${TOPICS}/42/entries`,
      `/api/v1/courses/${COURSE_ID}/users`,
      `/api/v1/courses/${COURSE_ID}/users`,
      `/api/v1/courses/${COURSE_ID}/users`,
    ]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);

    const payload = parseJsonResult(result);
    expect(payload.anonymized).toBe(true);
    expect(payload.warnings).toContain(DISCUSSION_SCRUB_NOTE);
    const entries = payload.entries as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({
      id: 101,
      user_id: 1001,
      user_name: "Student 1",
      message: "I agree with Student 2! Also Student 1 here.",
      reply_count: 1,
    });
    expect(entries[0]).not.toHaveProperty("replies");
    expect(entries[1]?.user_name).toBe("Mr. Smith");
    expect(String(entries[1]?.message)).toHaveLength(303);
    expect(String(entries[1]?.message).endsWith("...")).toBe(true);

    const participation = payload.participation as {
      authors: Array<{ user_id: number; name: string; entries: number; replies: number }>;
      roster_size: number;
      students_participated: number;
      students_without_posts: Array<{ user_id: string; name: string }>;
    };
    expect(participation.authors).toEqual(
      expect.arrayContaining([
        { user_id: 1001, name: "Student 1", entries: 1, replies: 0 },
        { user_id: 1002, name: "Student 2", entries: 0, replies: 1 },
        { user_id: 5000, name: "Mr. Smith", entries: 1, replies: 0 },
      ]),
    );
    expect(participation.roster_size).toBe(3);
    expect(participation.students_participated).toBe(2);
    expect(participation.students_without_posts).toEqual([{ user_id: "1003", name: "Student 3" }]);

    expectNoRawStudentNames(payload);
    expect(errorText(result)).not.toContain("Grace");
  });

  it("fetches complete replies when include_replies=true and returns full text with include_full_content", async () => {
    const entries: FakeResponse = {
      status: 200,
      data: [
        {
          id: 101,
          user_id: 1001,
          user_name: "Grace Park",
          message: `<p>${LONG_TEXT}</p>`,
          recent_replies: [{ id: 201, user_id: 1002, user_name: "Ana Maria", message: "first" }],
          has_more_replies: true,
        },
        { id: 102, user_id: 1003, user_name: "Ben Cho", message: "<p>No replies yet</p>" },
      ],
    };
    const replies101: FakeResponse = {
      status: 200,
      data: [
        { id: 201, user_id: 1002, user_name: "Ana Maria", message: "first" },
        { id: 202, user_id: 1003, user_name: "Ben Cho", message: "<p>second, Grace</p>" },
      ],
    };
    const replies102: FakeResponse = { status: 200, data: [] };
    const { harness, requests } = buildHarness([TOPIC, entries, replies101, replies102, STAFF_PAGE, STUDENT_PAGE]);

    const result = await harness.call("list_discussion_entries", {
      course_identifier: COURSE_ID,
      topic_id: 42,
      include_replies: true,
      include_full_content: true,
      include_non_participants: false,
    });

    expect(requests.map((request) => request.url).slice(0, 4)).toEqual([
      `${TOPICS}/42`,
      `${TOPICS}/42/entries`,
      `${TOPICS}/42/entries/101/replies`,
      `${TOPICS}/42/entries/102/replies`,
    ]);
    expect(requests).toHaveLength(6);
    const payload = parseJsonResult(result);
    const shown = payload.entries as Array<{ message: string; reply_count: number; replies: Array<Record<string, unknown>> }>;
    expect(shown[0]?.message).toBe(LONG_TEXT);
    expect(shown[0]?.reply_count).toBe(2);
    expect(shown[0]?.replies).toEqual([
      { id: 201, user_id: 1002, user_name: "Student 2", created_at: null, message: "first" },
      { id: 202, user_id: 1003, user_name: "Student 3", created_at: null, message: "second, Student 1" },
    ]);
    expect(shown[1]?.replies).toEqual([]);
    expect((payload.participation as { students_without_posts: unknown }).students_without_posts).toBeNull();
    expect(payload.warnings).not.toContainEqual(expect.stringContaining("partial"));
    expectNoRawStudentNames(payload);
  });

  it("warns that counts are partial when Canvas truncated embedded replies and include_replies is off", async () => {
    const entries: FakeResponse = {
      status: 200,
      data: [{ id: 101, user_id: 1001, user_name: "Grace Park", message: "hi", recent_replies: [], has_more_replies: true }],
    };
    const { harness } = buildHarness([TOPIC, entries, STAFF_PAGE, STUDENT_PAGE]);
    const payload = parseJsonResult(
      await harness.call("list_discussion_entries", {
        course_identifier: COURSE_ID,
        topic_id: 42,
        include_non_participants: false,
      }),
    );
    expect(payload.warnings).toContainEqual(expect.stringContaining("partial"));
    expect((payload.entries as Array<Record<string, unknown>>)[0]?.has_more_replies).toBe(true);
  });

  it("forces anonymization with a warning when anonymous=false lacks the operator opt-in", async () => {
    const { harness } = buildHarness([TOPIC, ENTRIES, STAFF_PAGE, STUDENT_PAGE, STUDENT_PAGE]);
    const payload = parseJsonResult(
      await harness.call("list_discussion_entries", { course_identifier: COURSE_ID, topic_id: 42, anonymous: false }),
    );
    expect(payload.anonymized).toBe(true);
    expect(payload.warnings).toContainEqual(expect.stringContaining("CANVAS_MCP_ALLOW_DEANONYMIZE"));
    expectNoRawStudentNames(payload);
  });

  it("returns real names without any scrub fetch when the operator opted in and anonymous=false", async () => {
    process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
    const { harness, requests } = buildHarness([TOPIC, ENTRIES, STUDENT_PAGE]);
    const payload = parseJsonResult(
      await harness.call("list_discussion_entries", { course_identifier: COURSE_ID, topic_id: 42, anonymous: false }),
    );
    expect(requests).toHaveLength(3);
    expect(payload.anonymized).toBe(false);
    expect((payload.entries as Array<{ user_name: string }>)[0]?.user_name).toBe("Grace Park");
    expect((payload.participation as { students_without_posts: unknown }).students_without_posts).toEqual([
      { user_id: "1003", name: "Ben Cho" },
    ]);
  });

  it("rejects a non-numeric topic_id before any request (no path injection)", async () => {
    const { harness, requests } = buildHarness([]);
    const result = await harness.call("list_discussion_entries", { course_identifier: COURSE_ID, topic_id: "42/../../users" });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("topic_id must be a numeric Canvas id");
    expect(requests).toHaveLength(0);
  });

  it("surfaces an entries 403 as a structured error naming the tool", async () => {
    const { harness } = buildHarness([TOPIC, { status: 403, data: { errors: [{ message: "forbidden" }] } }]);
    const result = await harness.call("list_discussion_entries", { course_identifier: COURSE_ID, topic_id: 42 });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/^list_discussion_entries: /);
    expect(errorText(result)).toContain("403");
  });

  it("explains anonymous discussions that Canvas REST will not serve", async () => {
    const { harness } = buildHarness([
      { status: 200, data: { id: 42, title: "Anon", anonymous_state: "full_anonymity" } },
      { status: 404, data: { errors: [{ message: "not found" }] } },
    ]);
    const result = await harness.call("list_discussion_entries", { course_identifier: COURSE_ID, topic_id: 42 });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("anonymous discussion");
  });

  it("reads a group discussion under /groups/:id and measures participation against the group's members", async () => {
    const group: FakeResponse = { status: 200, data: { id: 77, course_id: COURSE_ID } };
    const groupMembers: FakeResponse = {
      status: 200,
      data: [
        { id: 1001, name: "Grace Park" },
        { id: 1003, name: "Ben Cho" },
      ],
    };
    const entries: FakeResponse = { status: 200, data: [{ id: 301, user_id: 1001, user_name: "Grace Park", message: "hi" }] };
    const { harness, requests } = buildHarness([group, TOPIC, entries, STAFF_PAGE, STUDENT_PAGE, groupMembers]);
    const payload = parseJsonResult(
      await harness.call("list_discussion_entries", { course_identifier: COURSE_ID, topic_id: 42, group_id: 77 }),
    );
    expect(requests.map((request) => request.url)).toEqual([
      "/api/v1/groups/77",
      "/api/v1/groups/77/discussion_topics/42",
      "/api/v1/groups/77/discussion_topics/42/entries",
      `/api/v1/courses/${COURSE_ID}/users`,
      `/api/v1/courses/${COURSE_ID}/users`,
      "/api/v1/groups/77/users",
    ]);
    const participation = payload.participation as { roster_size: number; students_without_posts: unknown };
    expect(participation.roster_size).toBe(2);
    expect(participation.students_without_posts).toEqual([{ user_id: "1003", name: "Student 3" }]);
    expectNoRawStudentNames(payload);
  });

  it("refuses a group that belongs to another course", async () => {
    const { harness, requests } = buildHarness([{ status: 200, data: { id: 77, course_id: 99999 } }]);
    const result = await harness.call("list_discussion_entries", { course_identifier: COURSE_ID, topic_id: 42, group_id: 77 });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("does not belong to course");
    expect(requests).toHaveLength(1);
  });
});

describe("get_discussion_entry_details", () => {
  const PARENT = {
    id: 101,
    user_id: 1001,
    user_name: "Grace Park",
    message: "<p>Long thought about Ana Maria's point.</p>",
    created_at: "2026-05-02T09:00:00Z",
    updated_at: "2026-05-02T09:30:00Z",
    read_state: "read",
  };

  it("returns the full entry and all replies, anonymized", async () => {
    const { harness, requests } = buildHarness([
      TOPIC,
      { status: 200, data: [PARENT] },
      { status: 200, data: [{ id: 201, user_id: 1002, user_name: "Ana Maria", message: "Thanks Grace" }] },
      STAFF_PAGE,
      STUDENT_PAGE,
    ]);
    const result = await harness.call("get_discussion_entry_details", {
      course_identifier: COURSE_ID,
      topic_id: 42,
      entry_id: 101,
    });
    expect(requests[1]?.url).toBe(`${TOPICS}/42/entry_list`);
    expect(requests[1]?.params).toMatchObject({ "ids[]": ["101"] });
    expect(requests[2]?.url).toBe(`${TOPICS}/42/entries/101/replies`);
    expect(requests.some((request) => request.url.endsWith("/view"))).toBe(false);

    const payload = parseJsonResult(result);
    expect(payload.entry).toMatchObject({
      id: 101,
      user_id: 1001,
      user_name: "Student 1",
      message: "Long thought about Student 2's point.",
      read_state: "read",
      updated_at: "2026-05-02T09:30:00Z",
    });
    expect(payload.reply_count).toBe(1);
    expect(payload.replies).toEqual([
      { id: 201, user_id: 1002, user_name: "Student 2", created_at: null, message: "Thanks Student 1" },
    ]);
    expectNoRawStudentNames(payload);
  });

  it("falls back to scanning /entries (including embedded replies) when entry_list has no match", async () => {
    const { harness, requests } = buildHarness([
      TOPIC,
      { status: 200, data: [] },
      {
        status: 200,
        data: [{ ...PARENT, recent_replies: [{ id: 201, user_id: 1002, user_name: "Ana Maria", message: "Nested" }] }],
      },
      STAFF_PAGE,
      STUDENT_PAGE,
    ]);
    const payload = parseJsonResult(
      await harness.call("get_discussion_entry_details", {
        course_identifier: COURSE_ID,
        topic_id: 42,
        entry_id: 201,
        include_replies: false,
      }),
    );
    expect(requests[2]?.url).toBe(`${TOPICS}/42/entries`);
    expect(requests.some((request) => request.url.endsWith("/replies"))).toBe(false);
    expect(payload.entry).toMatchObject({ id: 201, user_name: "Student 2", message: "Nested" });
    expect(payload.replies).toBeNull();
  });

  it("errors when the entry does not exist", async () => {
    const { harness } = buildHarness([TOPIC, { status: 200, data: [] }, { status: 200, data: [] }]);
    const result = await harness.call("get_discussion_entry_details", {
      course_identifier: COURSE_ID,
      topic_id: 42,
      entry_id: 999,
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("entry 999 was not found");
  });
});

describe("post_discussion_entry (confirmation gate)", () => {
  const ARGS = { course_identifier: COURSE_ID, topic_id: 42, message: "<p>Great discussion so far, everyone.</p>" };
  const CREATED: FakeResponse = { status: 200, data: { id: 555, created_at: "2026-05-03T12:00:00Z", user_name: "Mr. Smith" } };

  async function preview(harness: ReturnType<typeof buildHarness>["harness"], args: Record<string, unknown> = ARGS) {
    const result = await harness.call("post_discussion_entry", args);
    return parseJsonResult(result);
  }

  it("preview shows the topic and exact message, issues a token, and writes nothing", async () => {
    const { harness, requests } = buildHarness([TOPIC]);
    const payload = await preview(harness);
    expect(payload.preview_only).toBe(true);
    expect(payload.topic).toMatchObject({ id: 42, title: "Week 5 debate", locked: false });
    expect(payload.message).toBe(ARGS.message);
    expect(typeof payload.confirmation_token).toBe("string");
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("posts exactly the approved message with the token", async () => {
    const { harness, requests, enqueue } = buildHarness([TOPIC]);
    const { confirmation_token } = await preview(harness);
    enqueue(CREATED);
    const result = await harness.call("post_discussion_entry", { ...ARGS, confirmation_token });
    const payload = parseJsonResult(result);
    expect(payload.posted).toBe(true);
    expect(payload.entry).toEqual({ id: 555, created_at: "2026-05-03T12:00:00Z" });
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`${TOPICS}/42/entries`);
    expect(posts[0]?.data).toEqual({ message: ARGS.message });
  });

  it("refuses an unknown token without writing", async () => {
    const { harness, requests } = buildHarness([]);
    const result = await harness.call("post_discussion_entry", { ...ARGS, confirmation_token: "not-a-real-token" });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("Nothing was posted");
    expect(requests).toHaveLength(0);
  });

  it("voids the token when the message changes after the preview", async () => {
    const { harness, requests } = buildHarness([TOPIC]);
    const { confirmation_token } = await preview(harness);
    const result = await harness.call("post_discussion_entry", {
      ...ARGS,
      message: "<p>Something the teacher never saw.</p>",
      confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("Arguments changed");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("voids the token when the topic changes after the preview", async () => {
    const { harness, requests } = buildHarness([TOPIC]);
    const { confirmation_token } = await preview(harness);
    const result = await harness.call("post_discussion_entry", { ...ARGS, topic_id: 43, confirmation_token });
    expect(result.isError).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("is single-use: a replayed token cannot post twice", async () => {
    const { harness, requests, enqueue } = buildHarness([TOPIC]);
    const { confirmation_token } = await preview(harness);
    enqueue(CREATED);
    expect((await harness.call("post_discussion_entry", { ...ARGS, confirmation_token })).isError).toBeFalsy();
    const replay = await harness.call("post_discussion_entry", { ...ARGS, confirmation_token });
    expect(replay.isError).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("re-resolves a course code on every call (bypassCache) for preview and write", async () => {
    const courses: FakeResponse = { status: 200, data: [{ id: COURSE_ID, course_code: "ENG-101", name: "English" }] };
    const { harness, requests, enqueue } = buildHarness([courses, TOPIC]);
    const args = { ...ARGS, course_identifier: "ENG-101" };
    const { confirmation_token } = await preview(harness, args);
    enqueue(courses);
    enqueue(CREATED);
    const result = await harness.call("post_discussion_entry", { ...args, confirmation_token });
    expect(result.isError).toBeFalsy();
    expect(requests.filter((request) => request.url === "/api/v1/courses")).toHaveLength(2);
    expect(requests.at(-1)?.url).toBe(`${TOPICS}/42/entries`);
  });

  it("warns when the message contains a pseudonym students would see literally", async () => {
    const { harness } = buildHarness([TOPIC]);
    const payload = await preview(harness, { ...ARGS, message: "Nice point, Student 3!" });
    expect(payload.warnings).toContainEqual(expect.stringContaining("pseudonym"));
  });

  it("never auto-retries the POST (a retry could publish a duplicate entry to students)", async () => {
    const mock = buildMockCanvas([TOPIC]);
    const retrying = new CanvasClient({
      baseUrl: "https://canvas.example.com",
      apiToken: "test-token",
      axiosInstance: mock.client.axios,
      maxRetries: 2,
    });
    const harness = buildToolHarness();
    registerDiscussionEntryTools(harness.server as never, retrying, anonymizer);
    const { confirmation_token } = parseJsonResult(await harness.call("post_discussion_entry", ARGS));
    mock.enqueue({ status: 503, data: {} });
    mock.enqueue(CREATED);
    const result = await harness.call("post_discussion_entry", { ...ARGS, confirmation_token });
    expect(result.isError).toBe(true);
    expect(mock.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("rejects an empty message before any request", async () => {
    const { harness, requests } = buildHarness([]);
    const result = await harness.call("post_discussion_entry", { ...ARGS, message: "   " });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("reply_to_discussion_entry (confirmation gate)", () => {
  const ARGS = { course_identifier: COURSE_ID, topic_id: 42, entry_id: 101, message: "<p>Can you say more about that?</p>" };
  const PARENT: FakeResponse = {
    status: 200,
    data: [
      {
        id: 101,
        user_id: 1001,
        user_name: "Grace Park",
        message: "<p>I think Ana Maria is right about the ending.</p>",
        created_at: "2026-05-02T09:00:00Z",
      },
    ],
  };
  const PREVIEW_RESPONSES = [TOPIC, PARENT, STAFF_PAGE, STUDENT_PAGE];

  it("preview shows the parent author as a pseudonym with a scrubbed excerpt and writes nothing", async () => {
    const { harness, requests } = buildHarness(PREVIEW_RESPONSES);
    const result = await harness.call("reply_to_discussion_entry", ARGS);
    const payload = parseJsonResult(result);
    expect(payload.preview_only).toBe(true);
    expect(payload.parent_entry).toEqual({
      id: 101,
      author: "Student 1",
      created_at: "2026-05-02T09:00:00Z",
      excerpt: "I think Student 2 is right about the ending.",
    });
    expect(payload.message).toBe(ARGS.message);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expectNoRawStudentNames(payload);
    expect(errorText(result)).not.toContain("Grace");
  });

  it("posts the reply to the parent entry with a valid token", async () => {
    const { harness, requests, enqueue } = buildHarness(PREVIEW_RESPONSES);
    const { confirmation_token } = parseJsonResult(await harness.call("reply_to_discussion_entry", ARGS));
    enqueue({ status: 200, data: { id: 777, created_at: "2026-05-03T12:00:00Z" } });
    const payload = parseJsonResult(await harness.call("reply_to_discussion_entry", { ...ARGS, confirmation_token }));
    expect(payload.reply).toEqual({ id: 777, created_at: "2026-05-03T12:00:00Z" });
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`${TOPICS}/42/entries/101/replies`);
    expect(posts[0]?.data).toEqual({ message: ARGS.message });
  });

  it("voids the token when the target entry changes", async () => {
    const { harness, requests } = buildHarness(PREVIEW_RESPONSES);
    const { confirmation_token } = parseJsonResult(await harness.call("reply_to_discussion_entry", ARGS));
    const result = await harness.call("reply_to_discussion_entry", { ...ARGS, entry_id: 102, confirmation_token });
    expect(result.isError).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("does not accept a token issued by post_discussion_entry", async () => {
    const { harness, requests } = buildHarness([TOPIC]);
    const { confirmation_token } = parseJsonResult(
      await harness.call("post_discussion_entry", { course_identifier: COURSE_ID, topic_id: 42, message: ARGS.message }),
    );
    const result = await harness.call("reply_to_discussion_entry", { ...ARGS, confirmation_token });
    expect(result.isError).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("refuses to preview a reply to an entry that does not exist", async () => {
    const { harness, requests } = buildHarness([TOPIC, { status: 200, data: [] }, { status: 200, data: [] }]);
    const result = await harness.call("reply_to_discussion_entry", ARGS);
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("nothing to reply to");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });
});
