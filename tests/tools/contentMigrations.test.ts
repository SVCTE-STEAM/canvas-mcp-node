import { beforeEach, describe, expect, it } from "vitest";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type FakeResponse,
  type RequestRecord,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { CanvasClient } from "../../src/canvasClient.js";
import { registerContentMigrationTools } from "../../src/tools/contentMigrations.js";
import { resetConfirmationTokens } from "../../src/tools/confirmGate.js";

const SOURCE_ID = 100;
const TARGET_ID = 200;

const TARGET_COURSE: FakeResponse = {
  status: 200,
  data: { id: TARGET_ID, course_code: "BIO-101-F26", name: "Biology 101 (Fall 2026)" },
};
const SOURCE_COURSE: FakeResponse = {
  status: 200,
  data: { id: SOURCE_ID, course_code: "BIO-101-F25", name: "Biology 101 (Fall 2025)" },
};
const OCCUPANCY_EMPTY: FakeResponse[] = Array.from({ length: 5 }, () => ({ status: 200, data: [] }));
const PREVIEW_RESPONSES = [TARGET_COURSE, SOURCE_COURSE, ...OCCUPANCY_EMPTY];
const CREATED: FakeResponse = {
  status: 200,
  data: { id: 9001, workflow_state: "running", progress_url: "https://canvas.example.com/api/v1/progress/444" },
};

const ARGS = { target_course_identifier: TARGET_ID, source_course_identifier: SOURCE_ID };

beforeEach(() => {
  resetConfirmationTokens();
});

function buildHarness(responses: FakeResponse[]) {
  const mock = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerContentMigrationTools(harness.server as never, mock.client);
  return { harness, requests: mock.requests, enqueue: mock.enqueue };
}

function errorText(result: ToolResponse): string {
  return result.content?.[0]?.text ?? "";
}

function sourceCourseRequests(requests: RequestRecord[]): RequestRecord[] {
  return requests.filter((request) => request.url.startsWith(`/api/v1/courses/${SOURCE_ID}`));
}

describe("registerContentMigrationTools", () => {
  it("registers the two migration tools", () => {
    const { harness } = buildHarness([]);
    expect([...harness.tools.keys()].sort()).toEqual(["create_content_migration", "get_content_migration_status"]);
  });
});

describe("create_content_migration", () => {
  it("preview names both courses by code and name, the type, selective-import setting and occupancy, and writes nothing", async () => {
    const occupied: FakeResponse[] = [
      { status: 200, data: [{ id: 1 }, { id: 2 }] },
      { status: 200, data: [{ url: "home" }] },
      { status: 200, data: [] },
      { status: 403, data: { errors: [{ message: "nope" }] } },
      { status: 200, data: [] },
    ];
    const { harness, requests } = buildHarness([TARGET_COURSE, SOURCE_COURSE, ...occupied]);
    const result = await harness.call("create_content_migration", ARGS);
    const payload = parseJsonResult(result);

    expect(payload.preview_only).toBe(true);
    expect(payload.source_course).toEqual({ id: SOURCE_ID, course_code: "BIO-101-F25", name: "Biology 101 (Fall 2025)" });
    expect(payload.target_course).toEqual({ id: TARGET_ID, course_code: "BIO-101-F26", name: "Biology 101 (Fall 2026)" });
    expect(payload.migration_type).toBe("course_copy_importer");
    expect(payload.selective_import).toBe(false);
    expect(payload.date_shift_options).toBeNull();
    expect(payload.target_current_contents).toMatchObject({
      counts: { assignments: 2, pages: 1, modules: 0, discussions: null, files: 0 },
      total_items: 3,
      unavailable: ["discussions"],
    });
    expect(payload.warnings).toContainEqual(expect.stringContaining("may create duplicates"));
    expect(payload.warnings).toContainEqual(expect.stringContaining("discussions"));
    expect(typeof payload.confirmation_token).toBe("string");
    expect(errorText(result)).toContain("BIO-101-F25");

    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      `/api/v1/courses/${TARGET_ID}`,
      `/api/v1/courses/${SOURCE_ID}`,
      `/api/v1/courses/${TARGET_ID}/assignments`,
      `/api/v1/courses/${TARGET_ID}/pages`,
      `/api/v1/courses/${TARGET_ID}/modules`,
      `/api/v1/courses/${TARGET_ID}/discussion_topics`,
      `/api/v1/courses/${TARGET_ID}/files`,
    ]);
  });

  it("with the token, POSTs a full course copy into the target only and never touches the source", async () => {
    const { harness, requests, enqueue } = buildHarness(PREVIEW_RESPONSES);
    const { confirmation_token } = parseJsonResult(await harness.call("create_content_migration", ARGS));
    enqueue(CREATED);
    const payload = parseJsonResult(await harness.call("create_content_migration", { ...ARGS, confirmation_token }));

    expect(payload).toMatchObject({
      migration_created: true,
      migration_id: "9001",
      workflow_state: "running",
      source_course: { id: SOURCE_ID, course_code: "BIO-101-F25" },
      target_course: { id: TARGET_ID, course_code: "BIO-101-F26" },
      next_action: {
        tool: "get_content_migration_status",
        arguments: { course_identifier: TARGET_ID, migration_id: "9001" },
      },
    });
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("POST");
    expect(writes[0]?.url).toBe(`/api/v1/courses/${TARGET_ID}/content_migrations`);
    expect(writes[0]?.data).toEqual({
      migration_type: "course_copy_importer",
      settings: { source_course_id: String(SOURCE_ID) },
      selective_import: false,
    });
    expect(sourceCourseRequests(requests).map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET /api/v1/courses/${SOURCE_ID}`,
    ]);
  });

  it("sends normalized date-shift options when all four dates are given", async () => {
    const dates = {
      old_start_date: "2025-08-25",
      old_end_date: "2025-12-15",
      new_start_date: "2026-08-24T00:00:00-0500",
      new_end_date: "2026-12-14",
    };
    const { harness, requests, enqueue } = buildHarness(PREVIEW_RESPONSES);
    const previewPayload = parseJsonResult(await harness.call("create_content_migration", { ...ARGS, ...dates }));
    const expected = {
      shift_dates: true,
      old_start_date: "2025-08-25T00:00:00.000Z",
      old_end_date: "2025-12-15T00:00:00.000Z",
      new_start_date: "2026-08-24T05:00:00.000Z",
      new_end_date: "2026-12-14T00:00:00.000Z",
    };
    expect(previewPayload.date_shift_options).toEqual(expected);
    enqueue(CREATED);
    await harness.call("create_content_migration", {
      ...ARGS,
      ...dates,
      confirmation_token: previewPayload.confirmation_token,
    });
    expect(requests.at(-1)?.data).toMatchObject({ date_shift_options: expected });
  });

  it.each([
    [{ old_start_date: "2025-08-25" }, "none or all four"],
    [{ old_start_date: "2025-08-25", old_end_date: "2025-12-15", new_start_date: "soon", new_end_date: "2026-12-14" }, "Invalid: new_start_date"],
    [{ old_start_date: "2025-02-30", old_end_date: "2025-12-15", new_start_date: "2026-08-24", new_end_date: "2026-12-14" }, "Invalid: old_start_date"],
    [{ old_start_date: "2025-12-15", old_end_date: "2025-08-25", new_start_date: "2026-08-24", new_end_date: "2026-12-14" }, "old_start_date must be before"],
  ])("rejects bad date shifts %j before any request", async (dates, message) => {
    const { harness, requests } = buildHarness([]);
    const result = await harness.call("create_content_migration", { ...ARGS, ...dates });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(message);
    expect(requests).toHaveLength(0);
  });

  it("refuses a source that resolves to the target", async () => {
    const { harness, requests } = buildHarness([]);
    const result = await harness.call("create_content_migration", {
      target_course_identifier: TARGET_ID,
      source_course_identifier: String(TARGET_ID),
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("two different courses");
    expect(requests).toHaveLength(0);
  });

  it("surfaces an unreadable source course as an error and writes nothing", async () => {
    const { harness, requests } = buildHarness([TARGET_COURSE, { status: 404, data: { errors: [{ message: "missing" }] } }]);
    const result = await harness.call("create_content_migration", ARGS);
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("source course 100");
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  });

  it("requires a valid token: an unknown token requests nothing", async () => {
    const { harness, requests } = buildHarness([]);
    const result = await harness.call("create_content_migration", { ...ARGS, confirmation_token: "forged" });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("No migration was requested");
    expect(requests).toHaveLength(0);
  });

  it("voids the token when the source course changes after the preview", async () => {
    const { harness, requests } = buildHarness(PREVIEW_RESPONSES);
    const { confirmation_token } = parseJsonResult(await harness.call("create_content_migration", ARGS));
    const result = await harness.call("create_content_migration", {
      ...ARGS,
      source_course_identifier: 101,
      confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("Arguments changed");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("voids the token when the date shift changes after the preview", async () => {
    const { harness, requests } = buildHarness(PREVIEW_RESPONSES);
    const { confirmation_token } = parseJsonResult(await harness.call("create_content_migration", ARGS));
    const result = await harness.call("create_content_migration", {
      ...ARGS,
      old_start_date: "2025-08-25",
      old_end_date: "2025-12-15",
      new_start_date: "2026-08-24",
      new_end_date: "2026-12-14",
      confirmation_token,
    });
    expect(result.isError).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("is single-use: a replayed token cannot queue a second copy", async () => {
    const { harness, requests, enqueue } = buildHarness(PREVIEW_RESPONSES);
    const { confirmation_token } = parseJsonResult(await harness.call("create_content_migration", ARGS));
    enqueue(CREATED);
    expect((await harness.call("create_content_migration", { ...ARGS, confirmation_token })).isError).toBeFalsy();
    const replay = await harness.call("create_content_migration", { ...ARGS, confirmation_token });
    expect(replay.isError).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("reports a failed POST as unconfirmed and tells the teacher to check import history before retrying", async () => {
    const { harness, requests, enqueue } = buildHarness(PREVIEW_RESPONSES);
    const { confirmation_token } = parseJsonResult(await harness.call("create_content_migration", ARGS));
    enqueue({ status: 500, data: { errors: [{ message: "boom" }] } });
    const result = await harness.call("create_content_migration", { ...ARGS, confirmation_token });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("NOT confirmed");
    expect(errorText(result)).toContain("duplicate migration");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("never auto-retries the POST, even on a client configured to retry 5xx", async () => {
    const mock = buildMockCanvas(PREVIEW_RESPONSES);
    const retrying = new CanvasClient({
      baseUrl: "https://canvas.example.com",
      apiToken: "test-token",
      axiosInstance: mock.client.axios,
      maxRetries: 2,
    });
    const harness = buildToolHarness();
    registerContentMigrationTools(harness.server as never, retrying);
    const { confirmation_token } = parseJsonResult(await harness.call("create_content_migration", ARGS));
    mock.enqueue({ status: 503, data: {} });
    mock.enqueue(CREATED);
    const result = await harness.call("create_content_migration", { ...ARGS, confirmation_token });
    expect(result.isError).toBe(true);
    expect(mock.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("treats a response without a numeric migration id as unconfirmed", async () => {
    const { harness, enqueue } = buildHarness(PREVIEW_RESPONSES);
    const { confirmation_token } = parseJsonResult(await harness.call("create_content_migration", ARGS));
    enqueue({ status: 200, data: { workflow_state: "running" } });
    const result = await harness.call("create_content_migration", { ...ARGS, confirmation_token });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("numeric migration id");
  });
});

describe("get_content_migration_status", () => {
  const MIGRATION: FakeResponse = {
    status: 200,
    data: {
      id: 9001,
      migration_type: "course_copy_importer",
      workflow_state: "running",
      progress_url: "https://canvas.example.com/api/v1/progress/444",
    },
  };
  const ARGS_STATUS = { course_identifier: TARGET_ID, migration_id: 9001 };

  it("reports a running migration with poll_again", async () => {
    const { harness, requests } = buildHarness([
      MIGRATION,
      { status: 200, data: { id: 444, workflow_state: "running", completion: 40, message: null } },
    ]);
    const payload = parseJsonResult(await harness.call("get_content_migration_status", ARGS_STATUS));
    expect(requests.map((request) => request.url)).toEqual([
      `/api/v1/courses/${TARGET_ID}/content_migrations/9001`,
      "/api/v1/progress/444",
    ]);
    expect(payload).toMatchObject({ status: "running", terminal: false, poll_again: true });
    expect(payload.progress).toEqual({ id: 444, workflow_state: "running", completion: 40, message: null });
  });

  it("reports a clean completion after checking migration issues", async () => {
    const { harness, requests } = buildHarness([
      MIGRATION,
      { status: 200, data: { id: 444, workflow_state: "completed", completion: 100 } },
      { status: 200, data: [] },
    ]);
    const payload = parseJsonResult(await harness.call("get_content_migration_status", ARGS_STATUS));
    expect(requests[2]?.url).toBe(`/api/v1/courses/${TARGET_ID}/content_migrations/9001/migration_issues`);
    expect(payload).toMatchObject({
      status: "completed",
      terminal: true,
      poll_again: false,
      issues_checked: true,
      requires_review: false,
      issues: [],
    });
  });

  it("flags completed_with_issues and returns compact issues", async () => {
    const { harness } = buildHarness([
      MIGRATION,
      { status: 200, data: { id: 444, workflow_state: "completed", completion: 100 } },
      {
        status: 200,
        data: [
          {
            id: 1,
            issue_type: "warning",
            workflow_state: "active",
            description: "Missing link",
            fix_issue_html_url: "https://canvas.example.com/fix/1",
            error_report_html_url: "https://canvas.example.com/err/1",
          },
        ],
      },
    ]);
    const payload = parseJsonResult(await harness.call("get_content_migration_status", ARGS_STATUS));
    expect(payload.status).toBe("completed_with_issues");
    expect(payload.requires_review).toBe(true);
    expect(payload.issues).toEqual([
      {
        id: 1,
        issue_type: "warning",
        workflow_state: "active",
        description: "Missing link",
        fix_issue_html_url: "https://canvas.example.com/fix/1",
      },
    ]);
  });

  it("flags a failed migration for review", async () => {
    const { harness } = buildHarness([
      MIGRATION,
      { status: 200, data: { id: 444, workflow_state: "failed", message: "Import failed" } },
      { status: 200, data: [] },
    ]);
    const result = await harness.call("get_content_migration_status", ARGS_STATUS);
    const payload = parseJsonResult(result);
    expect(payload).toMatchObject({ status: "failed", terminal: true, requires_review: true });
    expect(errorText(result)).toContain("FAILED");
  });

  it("keeps a terminal answer but marks issues unchecked when the issues read fails", async () => {
    const { harness } = buildHarness([
      MIGRATION,
      { status: 200, data: { id: 444, workflow_state: "completed" } },
      { status: 403, data: {} },
    ]);
    const payload = parseJsonResult(await harness.call("get_content_migration_status", ARGS_STATUS));
    expect(payload).toMatchObject({ status: "completed", terminal: true, issues_checked: false, requires_review: true });
  });

  it("does not claim completion for an unknown progress state", async () => {
    const { harness } = buildHarness([MIGRATION, { status: 200, data: { id: 444, workflow_state: "paused" } }]);
    const payload = parseJsonResult(await harness.call("get_content_migration_status", ARGS_STATUS));
    expect(payload).toMatchObject({ status: "unknown", terminal: false, poll_again: false });
  });

  it("errors when the migration has no usable progress_url", async () => {
    const { harness } = buildHarness([{ status: 200, data: { id: 9001, progress_url: "https://canvas.example.com/elsewhere" } }]);
    const result = await harness.call("get_content_migration_status", ARGS_STATUS);
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("progress_url");
  });

  it("rejects a non-numeric migration_id before any request", async () => {
    const { harness, requests } = buildHarness([]);
    const result = await harness.call("get_content_migration_status", { course_identifier: TARGET_ID, migration_id: "9001/../x" });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("surfaces a missing migration as a structured error", async () => {
    const { harness } = buildHarness([{ status: 404, data: { errors: [{ message: "not found" }] } }]);
    const result = await harness.call("get_content_migration_status", ARGS_STATUS);
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/^get_content_migration_status: /);
    expect(errorText(result)).toContain("404");
  });
});
