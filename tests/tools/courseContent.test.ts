import { beforeEach, describe, expect, it } from "vitest";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type FakeResponse,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { htmlToText, registerCourseContentTools } from "../../src/tools/courseContent.js";
import { resetConfirmationTokens } from "../../src/tools/confirmGate.js";

const COURSE_ID = 60366;
const COURSE_CODE = "DSGN_9_120251";

const ENROLLMENTS: FakeResponse = {
  status: 200,
  data: [{ id: COURSE_ID, course_code: COURSE_CODE, name: "Design 9" }],
};

function setup(responses: FakeResponse[] = []) {
  const { client, requests } = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerCourseContentTools(harness.server as never, client);
  return { harness, requests };
}

function errorText(result: ToolResponse): string {
  expect(result.isError).toBe(true);
  return result.content?.[0]?.text ?? "";
}

function writes(requests: Array<{ method: string }>): Array<{ method: string }> {
  return requests.filter((request) => request.method !== "GET");
}

beforeEach(() => {
  resetConfirmationTokens();
});

describe("registerCourseContentTools", () => {
  it("registers the nine course-content tools", () => {
    const { harness } = setup();
    expect([...harness.tools.keys()].sort()).toEqual([
      "bulk_update_pages",
      "get_course_content_overview",
      "get_course_structure",
      "get_front_page",
      "get_syllabus",
      "list_course_files",
      "list_module_items",
      "update_page_settings",
      "update_syllabus",
    ]);
  });
});

describe("htmlToText", () => {
  it("strips tags, drops script/style, keeps block breaks, decodes entities", () => {
    const text = htmlToText(
      "<h2>Grading</h2><script>alert(1)</script><p>A&nbsp;=&nbsp;90&amp;up &lt;tag&gt; &#8212; &#x41;</p><ul><li>One</li><li>Two</li></ul>",
    );
    expect(text).toBe("Grading\nA = 90&up <tag> — A\nOne\nTwo");
  });

  it("leaves oversized numeric entities as written instead of throwing", () => {
    expect(htmlToText("<p>&#99999999;</p>")).toBe("&#99999999;");
  });
});

describe("get_course_structure", () => {
  const MODULES: FakeResponse = {
    status: 200,
    data: [
      {
        id: 1,
        name: "Week 1",
        position: 1,
        published: true,
        items_count: 2,
        prerequisite_module_ids: [],
        require_sequential_progress: false,
        items: [
          { id: 10, title: "Overview", type: "Page", position: 1, published: true, page_url: "week-1-overview", indent: 0 },
          {
            id: 11,
            title: "HW 1",
            type: "Assignment",
            position: 2,
            published: false,
            content_id: 501,
            content_details: { due_at: "2026-09-08T23:59:00Z", points_possible: 10 },
          },
        ],
      },
      {
        id: 2,
        name: "Week 2",
        position: 2,
        published: false,
        items_count: 1,
        items: [{ id: 20, title: "Quiz 2", type: "Quiz", position: 1, published: true, content_id: 777 }],
      },
      { id: 3, name: "Week 3", position: 3, published: true, items_count: 0, items: [] },
      { id: 4, name: "Big Module", position: 4, published: true, items_count: 2 },
    ],
  };
  const BIG_MODULE_ITEMS: FakeResponse = {
    status: 200,
    data: [
      { id: 40, title: "Reading", type: "ExternalUrl", position: 1, published: true, external_url: "https://example.com" },
      { id: 41, title: "Notes", type: "File", position: 2, published: true, content_id: 900 },
    ],
  };

  it("returns the module tree with due dates and QC summary counts", async () => {
    const { harness, requests } = setup([MODULES, BIG_MODULE_ITEMS]);
    const result = await harness.call("get_course_structure", { course_identifier: COURSE_ID });
    expect(result.isError).toBeFalsy();

    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/modules`);
    expect(requests[0]?.params).toMatchObject({ "include[]": ["items", "content_details"] });
    // Canvas leaves `items` off large modules; those are fetched individually.
    expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/modules/4/items`);
    expect(requests[1]?.params).toMatchObject({ "include[]": ["content_details"] });
    expect(writes(requests)).toHaveLength(0);

    const payload = parseJsonResult(result) as {
      summary: Record<string, unknown>;
      modules: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>;
    };
    expect(payload.summary).toEqual({
      total_modules: 4,
      total_items: 5,
      unpublished_modules: 1,
      unpublished_items: 1,
      empty_modules: 1,
      published_items_in_unpublished_modules: 1,
      item_types: { Page: 1, Assignment: 1, Quiz: 1, ExternalUrl: 1, File: 1 },
    });
    const hw = payload.modules[0]!.items[1]!;
    expect(hw).toMatchObject({ id: 11, type: "Assignment", published: false, due_at: "2026-09-08T23:59:00Z", points_possible: 10 });
    // Compact: no null/empty filler fields on modules or items.
    expect(payload.modules[0]).not.toHaveProperty("prerequisite_module_ids");
    expect(payload.modules[0]).not.toHaveProperty("require_sequential_progress");
    expect(payload.modules[0]!.items[0]).not.toHaveProperty("indent");
    expect(payload.modules[3]!.items).toHaveLength(2);
  });

  it("include_unpublished=false drops unpublished modules and items", async () => {
    const { harness } = setup([MODULES, BIG_MODULE_ITEMS]);
    const result = await harness.call("get_course_structure", {
      course_identifier: COURSE_ID,
      include_unpublished: false,
    });
    const payload = parseJsonResult(result) as { summary: Record<string, unknown>; modules: Array<{ id: number }> };
    expect(payload.modules.map((module) => module.id)).toEqual([1, 3, 4]);
    expect(payload.summary).toMatchObject({ total_items: 3, unpublished_modules: 0, unpublished_items: 0 });
  });

  it("flags a module whose items could not be read instead of calling it empty", async () => {
    const { harness } = setup([
      { status: 200, data: [{ id: 4, name: "Big Module", published: true, items_count: 300 }] },
      { status: 403, data: { message: "forbidden" } },
    ]);
    const result = await harness.call("get_course_structure", { course_identifier: COURSE_ID });
    const payload = parseJsonResult(result) as {
      summary: Record<string, unknown>;
      modules: Array<Record<string, unknown>>;
      warnings: string[];
    };
    expect(payload.modules[0]).toMatchObject({ items_unavailable: true, items_count: 0 });
    expect(payload.summary.empty_modules).toBe(0);
    expect(payload.warnings[0]).toMatch(/Module 4: items could not be read/);
  });

  it("returns an error result when the modules request fails", async () => {
    const { harness } = setup([{ status: 404, data: { errors: [{ message: "The specified resource does not exist." }] } }]);
    const text = errorText(await harness.call("get_course_structure", { course_identifier: COURSE_ID }));
    expect(text).toMatch(/^get_course_structure: .*404/);
  });
});

describe("list_module_items", () => {
  it("lists items with content details and the module name", async () => {
    const { harness, requests } = setup([
      {
        status: 200,
        data: [
          { id: 11, title: "HW 1", type: "Assignment", published: true, content_id: 501, content_details: { due_at: "2026-09-08T23:59:00Z", points_possible: 10 } },
        ],
      },
      { status: 200, data: { id: 1, name: "Week 1" } },
    ]);
    const result = await harness.call("list_module_items", { course_identifier: COURSE_ID, module_id: "1" });
    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/modules/1/items`);
    expect(requests[0]?.params).toMatchObject({ "include[]": ["content_details"] });
    expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/modules/1`);
    const payload = parseJsonResult(result) as { module_name: string; count: number; items: Array<Record<string, unknown>> };
    expect(payload.module_name).toBe("Week 1");
    expect(payload.count).toBe(1);
    expect(payload.items[0]).toMatchObject({ due_at: "2026-09-08T23:59:00Z", points_possible: 10 });
  });

  it("omits content_details when include_content_details=false and tolerates a failed module-name lookup", async () => {
    const { harness, requests } = setup([
      { status: 200, data: [{ id: 12, title: "Intro", type: "SubHeader" }] },
      { status: 500, data: {} },
    ]);
    const result = await harness.call("list_module_items", {
      course_identifier: COURSE_ID,
      module_id: 1,
      include_content_details: false,
    });
    expect(requests[0]?.params).not.toHaveProperty("include[]");
    const payload = parseJsonResult(result) as { module_name: string | null; items: Array<Record<string, unknown>> };
    expect(payload.module_name).toBeNull();
    expect(payload.items[0]).toMatchObject({ id: 12, type: "SubHeader", published: true });
  });

  it("rejects a non-numeric module_id before any request", async () => {
    const { harness, requests } = setup();
    const text = errorText(await harness.call("list_module_items", { course_identifier: COURSE_ID, module_id: "1/../../users" }));
    expect(text).toMatch(/module_id must be a numeric Canvas id/);
    expect(requests).toHaveLength(0);
  });
});

describe("get_course_content_overview", () => {
  it("summarizes pages, modules, and a syllabus preview", async () => {
    const longSyllabus = `<h1>Syllabus</h1><p>${"x".repeat(1500)}</p>`;
    const { harness, requests } = setup([
      { status: 200, data: { id: COURSE_ID, name: "Design 9", course_code: COURSE_CODE, syllabus_body: longSyllabus } },
      {
        status: 200,
        data: [
          { url: "home", title: "Home", published: true, front_page: true, updated_at: "2026-08-01T00:00:00Z" },
          { url: "week-1", title: "Week 1", published: true, updated_at: "2026-08-10T00:00:00Z" },
          { url: "draft", title: "Draft", published: false, updated_at: "2026-08-20T00:00:00Z" },
        ],
      },
      {
        status: 200,
        data: [
          { id: 1, name: "Week 1", published: true, items_count: 2, items: [{ id: 10, type: "Page" }, { id: 11, type: "Assignment" }] },
          { id: 2, name: "Week 2", published: false, items_count: 1 },
        ],
      },
      { status: 200, data: [{ id: 20, type: "Quiz" }] },
    ]);
    const result = await harness.call("get_course_content_overview", { course_identifier: COURSE_ID });
    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.text).toMatch(new RegExp(`^Content overview for ${COURSE_CODE}`));
    expect(requests[0]?.params).toMatchObject({ "include[]": ["syllabus_body"] });
    expect(requests[3]?.url).toBe(`/api/v1/courses/${COURSE_ID}/modules/2/items`);

    const payload = parseJsonResult(result) as Record<string, Record<string, unknown>>;
    expect(payload.course_code).toBe(COURSE_CODE);
    expect(payload.pages).toMatchObject({
      total: 3,
      published: 2,
      unpublished: 1,
      front_page: { title: "Home", url: "home" },
    });
    expect((payload.pages!.recent_published as Array<{ url: string }>).map((page) => page.url)).toEqual(["week-1", "home"]);
    expect(payload.modules).toMatchObject({
      total: 2,
      published: 1,
      unpublished: 1,
      modules_analyzed_for_items: 2,
      total_items: 3,
      item_types: { Page: 1, Assignment: 1, Quiz: 1 },
    });
    expect(payload.syllabus).toMatchObject({ has_content: true, preview_truncated: true });
    expect((payload.syllabus!.preview as string).length).toBe(1000);
    expect(payload.syllabus!.preview as string).not.toContain("<");
  });

  it("reports a failed section without failing the whole overview", async () => {
    const { harness } = setup([
      { status: 200, data: { id: COURSE_ID, name: "Design 9", course_code: COURSE_CODE } },
      { status: 401, data: { message: "pages tab disabled" } },
    ]);
    const result = await harness.call("get_course_content_overview", {
      course_identifier: COURSE_ID,
      include_modules: false,
      include_syllabus: false,
    });
    const payload = parseJsonResult(result) as Record<string, Record<string, unknown>>;
    expect(payload.pages!.error).toMatch(/401/);
    expect(payload).not.toHaveProperty("modules");
    expect(payload).not.toHaveProperty("syllabus");
  });

  it("returns an error result when the course itself cannot be read", async () => {
    const { harness } = setup([{ status: 404, data: {} }]);
    expect(errorText(await harness.call("get_course_content_overview", { course_identifier: COURSE_ID }))).toMatch(/404/);
  });
});

describe("get_syllabus", () => {
  const SYLLABUS = "<h2>Policies</h2><p>Late work loses 10%.</p>";

  it("returns plain text by default", async () => {
    const { harness, requests } = setup([
      { status: 200, data: { id: COURSE_ID, course_code: COURSE_CODE, syllabus_body: SYLLABUS } },
    ]);
    const result = await harness.call("get_syllabus", { course_identifier: COURSE_ID });
    expect(requests[0]?.params).toMatchObject({ "include[]": ["syllabus_body"] });
    const payload = parseJsonResult(result);
    expect(payload).toMatchObject({ course_code: COURSE_CODE, has_content: true, text: "Policies\nLate work loses 10%." });
    expect(payload).not.toHaveProperty("html");
  });

  it("output_format=both with max_chars cuts both sections and flags it", async () => {
    const { harness } = setup([{ status: 200, data: { id: COURSE_ID, syllabus_body: SYLLABUS } }]);
    const result = await harness.call("get_syllabus", { course_identifier: COURSE_ID, output_format: "both", max_chars: 8 });
    const payload = parseJsonResult(result);
    expect(payload).toMatchObject({ text: "Policies", html: "<h2>Poli", truncated_at: 8 });
  });

  it("reports an empty syllabus", async () => {
    const { harness } = setup([{ status: 200, data: { id: COURSE_ID, syllabus_body: "  " } }]);
    expect(parseJsonResult(await harness.call("get_syllabus", { course_identifier: COURSE_ID }))).toMatchObject({
      has_content: false,
    });
  });

  it("rejects a non-positive max_chars before any request", async () => {
    const { harness, requests } = setup();
    expect(errorText(await harness.call("get_syllabus", { course_identifier: COURSE_ID, max_chars: 0 }))).toMatch(/max_chars/);
    expect(requests).toHaveLength(0);
  });
});

describe("update_syllabus", () => {
  const OLD = `<p>${"Old policy. ".repeat(40)}</p>`;
  const NEW = "<p>New grading policy: A = 90%.</p>";
  const courseWith = (body: string): FakeResponse => ({
    status: 200,
    data: { id: COURSE_ID, course_code: COURSE_CODE, syllabus_body: body },
  });

  async function preview(harness: ReturnType<typeof setup>["harness"], args: Record<string, unknown>) {
    const result = await harness.call("update_syllabus", args);
    expect(result.isError).toBeFalsy();
    return parseJsonResult(result) as Record<string, unknown> & { confirmation_token: string };
  }

  it("preview writes nothing and shows old vs new length and ~300-char previews", async () => {
    const { harness, requests } = setup([courseWith(OLD)]);
    const result = await harness.call("update_syllabus", { course_identifier: COURSE_ID, syllabus_body: NEW });
    expect(result.content?.[0]?.text).toMatch(/^PREVIEW ONLY — nothing was written/);
    expect(writes(requests)).toHaveLength(0);
    const payload = parseJsonResult(result);
    expect(payload).toMatchObject({
      preview_only: true,
      action: "update_syllabus",
      mode: "replace",
      current_length: OLD.length,
      new_length: NEW.length,
      new_preview: "New grading policy: A = 90%.",
    });
    expect((payload.current_preview as string).length).toBe(301);
    expect(payload.current_preview as string).toMatch(/…$/);
    expect(payload.warning).toMatch(/no revision history/);
    expect(typeof payload.confirmation_token).toBe("string");
  });

  it("confirms with the token: PUTs the body, re-resolves with bypassCache, and verifies by read-back", async () => {
    const { harness, requests } = setup([
      ENROLLMENTS,
      courseWith(OLD),
      ENROLLMENTS,
      courseWith(OLD),
      { status: 200, data: { id: COURSE_ID } },
      courseWith(`<link rel="stylesheet" href="theme.css">${NEW}`),
    ]);
    const args = { course_identifier: COURSE_CODE, syllabus_body: NEW };
    const { confirmation_token } = await preview(harness, args);

    const result = await harness.call("update_syllabus", { ...args, confirmation_token });
    expect(result.isError).toBeFalsy();
    // Course code resolved against the enrollment list on BOTH calls — no cache on writes.
    expect(requests.filter((request) => request.url === "/api/v1/courses")).toHaveLength(2);
    const put = writes(requests);
    expect(put).toHaveLength(1);
    expect(put[0]).toMatchObject({
      method: "PUT",
      url: `/api/v1/courses/${COURSE_ID}`,
      data: { course: { syllabus_body: NEW } },
    });
    expect(parseJsonResult(result)).toMatchObject({ verified: true, previous_length: OLD.length, course_code: COURSE_CODE });
  });

  it("requires a token that was actually issued", async () => {
    const { harness, requests } = setup([courseWith(OLD)]);
    const text = errorText(
      await harness.call("update_syllabus", { course_identifier: COURSE_ID, syllabus_body: NEW, confirmation_token: "made-up" }),
    );
    expect(text).toMatch(/unknown, expired|Nothing was changed/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("changed arguments void the token", async () => {
    const { harness, requests } = setup([courseWith(OLD), courseWith(OLD)]);
    const { confirmation_token } = await preview(harness, { course_identifier: COURSE_ID, syllabus_body: NEW });
    const text = errorText(
      await harness.call("update_syllabus", {
        course_identifier: COURSE_ID,
        syllabus_body: "<p>Something else entirely</p>",
        confirmation_token,
      }),
    );
    expect(text).toMatch(/Arguments changed since the preview/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("a syllabus edited by someone else between preview and confirm voids the token", async () => {
    const { harness, requests } = setup([courseWith(OLD), courseWith("<p>Co-teacher edit</p>")]);
    const args = { course_identifier: COURSE_ID, syllabus_body: NEW };
    const { confirmation_token } = await preview(harness, args);
    const text = errorText(await harness.call("update_syllabus", { ...args, confirmation_token }));
    expect(text).toMatch(/syllabus itself changed/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("the token is single-use", async () => {
    const { harness, requests } = setup([
      courseWith(OLD),
      courseWith(OLD),
      { status: 200, data: {} },
      courseWith(NEW),
      courseWith(OLD),
    ]);
    const args = { course_identifier: COURSE_ID, syllabus_body: NEW };
    const { confirmation_token } = await preview(harness, args);
    expect((await harness.call("update_syllabus", { ...args, confirmation_token })).isError).toBeFalsy();
    const text = errorText(await harness.call("update_syllabus", { ...args, confirmation_token }));
    expect(text).toMatch(/already used/);
    expect(writes(requests)).toHaveLength(1);
  });

  it("append mode previews the added block and writes existing + addition", async () => {
    const { harness, requests } = setup([
      courseWith("<p>Existing</p>"),
      courseWith("<p>Existing</p>"),
      { status: 200, data: {} },
      courseWith("<p>Existing</p>\n<p>Office hours: Tue</p>"),
    ]);
    const args = { course_identifier: COURSE_ID, syllabus_body: "<p>Office hours: Tue</p>", mode: "append" };
    const previewPayload = await preview(harness, args);
    expect(previewPayload.added_preview).toBe("Office hours: Tue");
    expect(previewPayload).not.toHaveProperty("warning");
    await harness.call("update_syllabus", { ...args, confirmation_token: previewPayload.confirmation_token });
    expect(writes(requests)[0]?.data).toEqual({
      course: { syllabus_body: "<p>Existing</p>\n<p>Office hours: Tue</p>" },
    });
  });

  it("warns when the read-back does not contain what was sent", async () => {
    const { harness } = setup([courseWith(OLD), courseWith(OLD), { status: 200, data: {} }, courseWith(OLD)]);
    const args = { course_identifier: COURSE_ID, syllabus_body: NEW };
    const { confirmation_token } = await preview(harness, args);
    const result = await harness.call("update_syllabus", { ...args, confirmation_token });
    expect(result.content?.[0]?.text).toMatch(/NOT confirmed/);
    const payload = parseJsonResult(result) as { verified: boolean; warnings: string[] };
    expect(payload.verified).toBe(false);
    expect(payload.warnings[0]).toMatch(/does not contain the text sent/);
  });

  it("refuses an empty body before any request", async () => {
    const { harness, requests } = setup();
    expect(errorText(await harness.call("update_syllabus", { course_identifier: COURSE_ID, syllabus_body: "   " }))).toMatch(
      /<p><\/p>/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("get_front_page", () => {
  it("returns the front page", async () => {
    const { harness, requests } = setup([
      { status: 200, data: { url: "home", title: "Home", published: true, body: "<p>Welcome</p>", updated_at: "2026-08-01T00:00:00Z" } },
    ]);
    const payload = parseJsonResult(await harness.call("get_front_page", { course_identifier: COURSE_ID }));
    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/front_page`);
    expect(payload).toMatchObject({ has_front_page: true, url: "home", title: "Home", published: true, body: "<p>Welcome</p>" });
  });

  it("reports has_front_page=false when Canvas has none (404)", async () => {
    const { harness } = setup([{ status: 404, data: { message: "No front page has been set" } }]);
    const result = await harness.call("get_front_page", { course_identifier: COURSE_ID });
    expect(result.isError).toBeFalsy();
    expect(parseJsonResult(result)).toEqual({ course_id: COURSE_ID, has_front_page: false });
  });

  it("surfaces other errors", async () => {
    const { harness } = setup([{ status: 403, data: { message: "unauthorized" } }]);
    expect(errorText(await harness.call("get_front_page", { course_identifier: COURSE_ID }))).toMatch(/403/);
  });
});

describe("update_page_settings", () => {
  const PAGE = { url: "week-1", title: "Week 1", published: true, front_page: false, editing_roles: "teachers" };

  it("refuses published=true without touching Canvas", async () => {
    const { harness, requests } = setup();
    const text = errorText(
      await harness.call("update_page_settings", { course_identifier: COURSE_ID, page_url_or_id: "week-1", published: true }),
    );
    expect(text).toMatch(/never publishes/);
    expect(text).toMatch(/Publish the page\(s\) in Canvas/);
    expect(requests).toHaveLength(0);
  });

  it("unpublishes an existing page with only the requested settings", async () => {
    const { harness, requests } = setup([
      ENROLLMENTS,
      { status: 200, data: PAGE },
      { status: 200, data: { ...PAGE, published: false, editing_roles: "teachers,students" } },
    ]);
    const result = await harness.call("update_page_settings", {
      course_identifier: COURSE_CODE,
      page_url_or_id: "week-1",
      published: false,
      editing_roles: "teachers,students",
    });
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe("/api/v1/courses");
    expect(requests[1]).toMatchObject({ method: "GET", url: `/api/v1/courses/${COURSE_ID}/pages/week-1` });
    expect(requests[2]).toMatchObject({
      method: "PUT",
      url: `/api/v1/courses/${COURSE_ID}/pages/week-1`,
      data: { wiki_page: { published: false, editing_roles: "teachers,students" } },
    });
    const payload = parseJsonResult(result) as { changed: string[]; page: Record<string, unknown>; course_code: string };
    expect(payload.course_code).toBe(COURSE_CODE);
    expect(payload.changed).toEqual(["published", "editing_roles"]);
    expect(payload.page.published).toBe(false);
  });

  it("does not PUT to a slug that matches no page (Canvas would create one)", async () => {
    const { harness, requests } = setup([{ status: 404, data: {} }]);
    const text = errorText(
      await harness.call("update_page_settings", { course_identifier: COURSE_ID, page_url_or_id: "typo", editing_roles: "teachers" }),
    );
    expect(text).toMatch(/was not found.*Nothing was changed/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("refuses to make an unpublished page the front page", async () => {
    const { harness, requests } = setup([{ status: 200, data: { ...PAGE, published: false } }]);
    const text = errorText(
      await harness.call("update_page_settings", { course_identifier: COURSE_ID, page_url_or_id: "week-1", front_page: true }),
    );
    expect(text).toMatch(/is unpublished.*Publish it in Canvas first/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("errors when no settings are passed, or the slug has a path separator", async () => {
    const { harness, requests } = setup();
    expect(errorText(await harness.call("update_page_settings", { course_identifier: COURSE_ID, page_url_or_id: "week-1" }))).toMatch(
      /no changes specified/,
    );
    expect(
      errorText(
        await harness.call("update_page_settings", { course_identifier: COURSE_ID, page_url_or_id: "../files", published: false }),
      ),
    ).toMatch(/not a page URL slug/);
    expect(requests).toHaveLength(0);
  });

  it("warns that notify_of_update cannot be confirmed", async () => {
    const { harness } = setup([{ status: 200, data: PAGE }, { status: 200, data: PAGE }]);
    const result = await harness.call("update_page_settings", {
      course_identifier: COURSE_ID,
      page_url_or_id: "week-1",
      notify_of_update: true,
    });
    const payload = parseJsonResult(result) as { warnings: string[] };
    expect(payload.warnings[0]).toMatch(/cannot be confirmed/);
  });
});

describe("bulk_update_pages", () => {
  const PAGE_LIST: FakeResponse = {
    status: 200,
    data: [
      { page_id: 1, url: "home", title: "Home", published: true, front_page: true, editing_roles: "teachers" },
      { page_id: 2, url: "week-1", title: "Week 1", published: true, editing_roles: "teachers" },
      { page_id: 3, url: "week-2", title: "Week 2", published: true, editing_roles: "teachers" },
    ],
  };
  const ARGS = { course_identifier: COURSE_ID, page_urls: "week-1, week-2, nope", published: false };

  it("refuses published=true without touching Canvas or issuing a token", async () => {
    const { harness, requests } = setup();
    const text = errorText(
      await harness.call("bulk_update_pages", { course_identifier: COURSE_ID, page_urls: "week-1", published: true }),
    );
    expect(text).toMatch(/never publishes/);
    expect(text).not.toMatch(/confirmation_token/);
    expect(requests).toHaveLength(0);
  });

  it("preview lists each page with its current state and the change, and writes nothing", async () => {
    const { harness, requests } = setup([PAGE_LIST]);
    const result = await harness.call("bulk_update_pages", ARGS);
    expect(result.content?.[0]?.text).toMatch(/^PREVIEW ONLY — nothing was written\. Would set published=false on 2 page\(s\)/);
    expect(writes(requests)).toHaveLength(0);
    const payload = parseJsonResult(result) as Record<string, unknown> & { pages: Array<Record<string, unknown>> };
    expect(payload.changes).toEqual({ published: false });
    expect(payload.pages).toEqual([
      { url: "week-1", title: "Week 1", published: true, editing_roles: "teachers" },
      { url: "week-2", title: "Week 2", published: true, editing_roles: "teachers" },
    ]);
    expect(payload.not_found).toEqual(["nope"]);
    expect(typeof payload.confirmation_token).toBe("string");
  });

  it("preview flags the front page, which Canvas will not unpublish", async () => {
    const { harness } = setup([PAGE_LIST]);
    const payload = parseJsonResult(
      await harness.call("bulk_update_pages", { course_identifier: COURSE_ID, page_urls: ["home"], published: false }),
    ) as { pages: Array<Record<string, unknown>>; warnings: string[] };
    expect(payload.pages[0]?.blocked).toMatch(/front page/);
    expect(payload.warnings[0]).toMatch(/front page/);
  });

  it("confirm PUTs only existing pages, skips unknown slugs, and never sends published=true", async () => {
    const { harness, requests } = setup([
      PAGE_LIST,
      PAGE_LIST,
      { status: 200, data: { url: "week-1", title: "Week 1", published: false } },
      { status: 200, data: { url: "week-2", title: "Week 2", published: false } },
    ]);
    const { confirmation_token } = parseJsonResult(await harness.call("bulk_update_pages", ARGS)) as {
      confirmation_token: string;
    };
    const result = await harness.call("bulk_update_pages", { ...ARGS, confirmation_token });
    expect(result.isError).toBeFalsy();
    const puts = writes(requests) as Array<{ method: string; url?: string; data?: unknown }>;
    expect(puts.map((request) => request.url)).toEqual([
      `/api/v1/courses/${COURSE_ID}/pages/week-1`,
      `/api/v1/courses/${COURSE_ID}/pages/week-2`,
    ]);
    for (const put of puts) expect(put.data).toEqual({ wiki_page: { published: false } });
    expect(parseJsonResult(result)).toMatchObject({ requested: 3, succeeded: 2, failed: 0, skipped_not_found: ["nope"] });
  });

  it("requires an issued token", async () => {
    const { harness, requests } = setup();
    const text = errorText(await harness.call("bulk_update_pages", { ...ARGS, confirmation_token: "forged" }));
    expect(text).toMatch(/No pages were updated/);
    expect(requests).toHaveLength(0);
  });

  it("changed arguments void the token", async () => {
    const { harness, requests } = setup([PAGE_LIST]);
    const { confirmation_token } = parseJsonResult(await harness.call("bulk_update_pages", ARGS)) as {
      confirmation_token: string;
    };
    const text = errorText(
      await harness.call("bulk_update_pages", { ...ARGS, page_urls: "week-1, week-2, home", confirmation_token }),
    );
    expect(text).toMatch(/Arguments changed since the preview/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("the token is single-use", async () => {
    const { harness, requests } = setup([
      PAGE_LIST,
      PAGE_LIST,
      { status: 200, data: { url: "week-1", published: false } },
    ]);
    const args = { course_identifier: COURSE_ID, page_urls: "week-1", published: false };
    const { confirmation_token } = parseJsonResult(await harness.call("bulk_update_pages", args)) as {
      confirmation_token: string;
    };
    expect((await harness.call("bulk_update_pages", { ...args, confirmation_token })).isError).toBeFalsy();
    expect(errorText(await harness.call("bulk_update_pages", { ...args, confirmation_token }))).toMatch(/already used/);
    expect(writes(requests)).toHaveLength(1);
  });

  it("keeps going when one page fails and reports it", async () => {
    const { harness } = setup([
      PAGE_LIST,
      PAGE_LIST,
      { status: 400, data: { errors: [{ message: "cannot unpublish" }] } },
      { status: 200, data: { url: "week-2", title: "Week 2", published: false } },
    ]);
    const args = { course_identifier: COURSE_ID, page_urls: ["week-1", "week-2"], editing_roles: "teachers", published: false };
    const { confirmation_token } = parseJsonResult(await harness.call("bulk_update_pages", args)) as {
      confirmation_token: string;
    };
    const payload = parseJsonResult(await harness.call("bulk_update_pages", { ...args, confirmation_token })) as {
      succeeded: number;
      failed: number;
      failures: Array<{ url: string; error: string }>;
    };
    expect(payload.succeeded).toBe(1);
    expect(payload.failed).toBe(1);
    expect(payload.failures[0]).toMatchObject({ url: "week-1" });
    expect(payload.failures[0]?.error).toMatch(/cannot unpublish/);
  });

  it("errors when nothing would change", async () => {
    const { harness, requests } = setup();
    expect(errorText(await harness.call("bulk_update_pages", { course_identifier: COURSE_ID, page_urls: "week-1" }))).toMatch(
      /no changes specified/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("list_course_files", () => {
  it("lists file metadata with sort/order/search and no download URLs", async () => {
    const { harness, requests } = setup([
      {
        status: 200,
        data: [
          {
            id: 900,
            display_name: "Syllabus.pdf",
            filename: "syllabus.pdf",
            size: 1_572_864,
            "content-type": "application/pdf",
            updated_at: "2026-08-01T00:00:00Z",
            url: "https://canvas.example.com/files/900/download?verifier=SECRET",
            locked: true,
            hidden: false,
          },
        ],
      },
    ]);
    const result = await harness.call("list_course_files", {
      course_identifier: COURSE_ID,
      search_term: "syll",
      sort: "name",
      order: "asc",
    });
    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/files`);
    expect(requests[0]?.params).toMatchObject({ sort: "name", order: "asc", search_term: "syll" });
    const payload = parseJsonResult(result) as { count: number; files: Array<Record<string, unknown>> };
    expect(payload.count).toBe(1);
    expect(payload.files[0]).toEqual({
      id: 900,
      name: "Syllabus.pdf",
      size: "1.5 MB",
      content_type: "application/pdf",
      updated_at: "2026-08-01T00:00:00Z",
      locked: true,
    });
    expect(result.content?.[0]?.text).not.toContain("verifier");
  });

  it("defaults to updated_at desc", async () => {
    const { harness, requests } = setup([{ status: 200, data: [] }]);
    await harness.call("list_course_files", { course_identifier: COURSE_ID });
    expect(requests[0]?.params).toMatchObject({ sort: "updated_at", order: "desc" });
  });

  it("surfaces Canvas errors", async () => {
    const { harness } = setup([{ status: 403, data: { message: "user not authorized to perform that action" } }]);
    expect(errorText(await harness.call("list_course_files", { course_identifier: COURSE_ID }))).toMatch(/403.*not authorized/);
  });
});
