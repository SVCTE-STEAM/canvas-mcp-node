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
import { registerOutcomeTools } from "../../src/tools/outcomes.js";

const COURSE_ID = 4242;
const BASE = "https://canvas.example.com";
const REAL_NAMES = /Grace|Park|Leo|Chen|Ivy|Lee|Sam|Fox/;

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-outcomes-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
});

function buildHarness(responses: FakeResponse[]) {
  const mock = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerOutcomeTools(harness.server as never, mock.client, anonymizer);
  return { harness, requests: mock.requests };
}

function textOf(result: ToolResponse): string {
  return result.content?.[0]?.text ?? "";
}

const RATINGS = [
  { points: 4, description: "Exceeds" },
  { points: 3, description: "Mastery" },
  { points: 2, description: "Near" },
  { points: 0, description: "Not yet" },
];

function outcome(id: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    description: `<p>Students can <strong>${title.toLowerCase()}</strong>.</p>`,
    points_possible: 4,
    mastery_points: 3,
    ratings: RATINGS,
    calculation_method: "decaying_average",
    calculation_int: 65,
    assessed: true,
    ...extra,
  };
}

const GROUPS: FakeResponse = {
  status: 200,
  data: [
    { id: 1, title: "Auto Tech 1", parent_outcome_group: null },
    { id: 2, title: "Safety", parent_outcome_group: { id: 1 } },
    { id: 3, title: "Shop tools", parent_outcome_group: { id: 2 } },
  ],
};

const LINKS: FakeResponse = {
  status: 200,
  data: [
    { outcome_group: { id: 3, title: "Shop tools" }, outcome: outcome(101, "Use a torque wrench") },
    { outcome_group: { id: 1, title: "Auto Tech 1" }, outcome: outcome(102, "Read a wiring diagram", { assessed: false }) },
    // Same outcome linked a second time into another group: must be listed once.
    { outcome_group: { id: 2, title: "Safety" }, outcome: outcome(101, "Use a torque wrench") },
  ],
};

function rollup(user: number, scores: Array<[number, number]>, status = "active", section = 7) {
  return {
    // The docs show a name on each rollup; it must never reach the output.
    name: `Real Name ${user}`,
    scores: scores.map(([outcomeId, score]) => ({ score, count: 2, title: "Torque lab", links: { outcome: String(outcomeId) } })),
    links: { user: String(user), section: String(section), status },
  };
}

const ROLLUPS_PAGE_1: FakeResponse = {
  status: 200,
  data: {
    rollups: [
      rollup(5001, [[101, 3.5], [102, 2]]),
      rollup(5001, [[101, 3.5], [102, 2]], "active", 8), // same student, second section
      rollup(5002, [[101, 2.4]]),
    ],
    meta: { pagination: { next: `${BASE}/api/v1/courses/${COURSE_ID}/outcome_rollups?page=2&per_page=100` } },
  },
  headers: { link: `<${BASE}/api/v1/courses/${COURSE_ID}/outcome_rollups?page=2&per_page=100>; rel="next"` },
};

const ROLLUPS_PAGE_2: FakeResponse = {
  status: 200,
  data: {
    rollups: [rollup(5003, []), rollup(5004, [[101, 4]], "completed")],
    meta: { pagination: {} },
  },
};

describe("get_course_outcomes", () => {
  it("registers one read-only tool", () => {
    const { harness } = buildHarness([]);
    expect([...harness.tools.keys()]).toEqual(["get_course_outcomes"]);
    expect(harness.tools.get("get_course_outcomes")?.description).toMatch(/^Read-only\./);
  });

  it("lists outcomes once each with group paths, plain-text descriptions and the rating scale", async () => {
    const { harness, requests } = buildHarness([LINKS, GROUPS]);
    const result = await harness.call("get_course_outcomes", { course_identifier: COURSE_ID });
    const payload = parseJsonResult<{
      outcome_count: number;
      outcomes: Array<Record<string, unknown>>;
      mastery?: unknown;
    }>(result);

    expect(payload.outcome_count).toBe(2);
    expect(payload.outcomes.map((entry) => entry.id)).toEqual(["101", "102"]);
    const torque = payload.outcomes[0]!;
    expect(torque.group).toBe("Safety > Shop tools");
    expect(torque.description).toBe("Students can use a torque wrench.");
    expect(torque.mastery_points).toBe(3);
    expect(torque.ratings).toEqual(RATINGS);
    expect(torque.calculation_method).toBe("decaying_average");
    expect(torque.calculation_int).toBe(65);
    // Linked at the course's root group: no path.
    expect(payload.outcomes[1]!.group).toBeNull();
    expect(payload.outcomes[1]!.assessed).toBe(false);
    expect(payload.mastery).toBeUndefined();
    expect(textOf(result)).toContain("2 outcome(s) in 1 group(s); 1 assessed");

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET /api/v1/courses/${COURSE_ID}/outcome_group_links`,
      `GET /api/v1/courses/${COURSE_ID}/outcome_groups`,
    ]);
    expect(requests[0]!.params).toMatchObject({ outcome_style: "full" });
  });

  it("summary counts each active student once across pages and lists no students", async () => {
    const { harness, requests } = buildHarness([LINKS, GROUPS, ROLLUPS_PAGE_1, ROLLUPS_PAGE_2]);
    const result = await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, include_mastery: "summary" });
    const payload = parseJsonResult<{
      mastery: { active_students: number; outcomes: Array<Record<string, unknown>>; students?: unknown };
      warnings?: string[];
    }>(result);

    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(requests[2]!.url).toBe(`/api/v1/courses/${COURSE_ID}/outcome_rollups`);
    expect(requests[3]!.url).toBe(`/api/v1/courses/${COURSE_ID}/outcome_rollups?page=2&per_page=100`);

    // 5001, 5002, 5003 are active; 5004's enrollment is concluded.
    expect(payload.mastery.active_students).toBe(3);
    expect(payload.mastery.outcomes).toEqual([
      {
        outcome_id: "101",
        title: "Use a torque wrench",
        mastery_points: 3,
        students_scored: 2,
        mastered: 1,
        not_yet: 1,
        no_score: 1,
        average: 2.95,
      },
      {
        outcome_id: "102",
        title: "Read a wiring diagram",
        mastery_points: 3,
        students_scored: 1,
        mastered: 0,
        not_yet: 1,
        no_score: 2,
        average: 2,
      },
    ]);
    expect(payload.mastery.students).toBeUndefined();
    expect(payload.warnings).toEqual([
      "1 student(s) with inactive or concluded enrollments are left out of the counts.",
    ]);
    expect(textOf(result)).not.toMatch(/Real Name|500[1-4]/);
  });

  it("counts a student active in one section and inactive in another as active, in either row order", async () => {
    for (const order of [
      ["inactive", "active"],
      ["active", "inactive"],
    ]) {
      const rollups: FakeResponse = {
        status: 200,
        data: {
          rollups: [rollup(6001, [[101, 3]], order[0], 7), rollup(6001, [[101, 3]], order[1], 8), rollup(6002, [], "inactive")],
        },
      };
      const { harness } = buildHarness([LINKS, GROUPS, rollups]);
      const payload = parseJsonResult<{
        mastery: { active_students: number; outcomes: Array<{ mastered: number }> };
        warnings: string[];
      }>(await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, include_mastery: "summary" }));
      expect(payload.mastery.active_students).toBe(1);
      expect(payload.mastery.outcomes[0]!.mastered).toBe(1);
      expect(payload.warnings).toEqual([
        "1 student(s) with inactive or concluded enrollments are left out of the counts.",
      ]);
    }
  });

  it("students mode lists pseudonyms with Canvas ids and scores, never names", async () => {
    const { harness } = buildHarness([LINKS, GROUPS, ROLLUPS_PAGE_1, ROLLUPS_PAGE_2]);
    const result = await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, include_mastery: "students" });
    const payload = parseJsonResult<{ mastery: { students: Array<Record<string, unknown>> } }>(result);

    expect(payload.mastery.students).toEqual([
      { user_id: "5001", student: "Student 1", scores: { "101": 3.5, "102": 2 } },
      { user_id: "5002", student: "Student 2", scores: { "101": 2.4 } },
      { user_id: "5003", student: "Student 3", scores: {} },
    ]);
    expect(textOf(result)).not.toMatch(/Real Name/);
    expect(textOf(result)).toContain("per-student scores included");
  });

  it("anonymous=false without the operator opt-in still pseudonymizes and warns", async () => {
    const { harness, requests } = buildHarness([LINKS, GROUPS, ROLLUPS_PAGE_1, ROLLUPS_PAGE_2]);
    const result = await harness.call("get_course_outcomes", {
      course_identifier: COURSE_ID,
      include_mastery: "students",
      anonymous: false,
    });
    const payload = parseJsonResult<{ mastery: { students: Array<{ student: string }> }; warnings: string[] }>(result);

    expect(payload.mastery.students.map((entry) => entry.student)).toEqual(["Student 1", "Student 2", "Student 3"]);
    expect(payload.warnings.some((warning) => warning.includes("CANVAS_MCP_ALLOW_DEANONYMIZE"))).toBe(true);
    // No roster fetch: real names are never loaded when they can't be shown.
    expect(requests.some((request) => request.url.includes("/users"))).toBe(false);
  });

  it("anonymous=false with the operator opt-in shows roster names", async () => {
    process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
    const roster: FakeResponse = {
      status: 200,
      data: [
        { id: 5001, name: "Grace Park" },
        { id: 5002, name: "Leo Chen" },
        { id: 5003, name: "Ivy Lee" },
      ],
    };
    const { harness } = buildHarness([LINKS, GROUPS, ROLLUPS_PAGE_1, ROLLUPS_PAGE_2, roster]);
    const result = await harness.call("get_course_outcomes", {
      course_identifier: COURSE_ID,
      include_mastery: "students",
      anonymous: false,
    });
    const payload = parseJsonResult<{ mastery: { students: Array<{ student: string }> } }>(result);
    expect(payload.mastery.students.map((entry) => entry.student)).toEqual(["Grace Park", "Ivy Lee", "Leo Chen"]);
  });

  it("outcome_ids filters the list, is passed to Canvas, and reports ids not in the course", async () => {
    const rollups: FakeResponse = { status: 200, data: { rollups: [rollup(5001, [[101, 3]])] } };
    const { harness, requests } = buildHarness([LINKS, GROUPS, rollups]);
    const result = await harness.call("get_course_outcomes", {
      course_identifier: COURSE_ID,
      include_mastery: "summary",
      outcome_ids: [101, "999"],
    });
    const payload = parseJsonResult<{ outcomes: Array<{ id: string }>; warnings: string[] }>(result);

    expect(payload.outcomes.map((entry) => entry.id)).toEqual(["101"]);
    expect(requests[2]!.params).toMatchObject({ "outcome_ids[]": ["101", "999"] });
    expect(payload.warnings).toContain("Not linked to this course: outcome id(s) 999.");
  });

  it("rejects a non-numeric outcome id before calling Canvas", async () => {
    const { harness, requests } = buildHarness([]);
    const result = await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, outcome_ids: ["torque"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('outcome_ids must be numeric Canvas ids (got "torque")');
    expect(requests).toHaveLength(0);
  });

  it("keeps the outcome list when Canvas refuses the mastery results", async () => {
    const { harness } = buildHarness([LINKS, GROUPS, { status: 403, data: { errors: [{ message: "unauthorized" }] } }]);
    const result = await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, include_mastery: "summary" });
    const payload = parseJsonResult<{ outcome_count: number; mastery?: unknown; warnings: string[] }>(result);
    expect(payload.outcome_count).toBe(2);
    expect(payload.mastery).toBeUndefined();
    expect(payload.warnings[0]).toMatch(/refused the student mastery results/);
  });

  it("surfaces other Canvas failures as a tool error", async () => {
    const { harness } = buildHarness([LINKS, GROUPS, { status: 500, data: {} }]);
    const result = await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, include_mastery: "summary" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^get_course_outcomes: .*outcome_rollups failed: 500/);
  });

  it("reports mastered as null when an outcome has no mastery threshold", async () => {
    const links: FakeResponse = {
      status: 200,
      data: [{ outcome_group: { id: 1 }, outcome: outcome(103, "Weld a bead", { mastery_points: null, ratings: null }) }],
    };
    const rollups: FakeResponse = { status: 200, data: { rollups: [rollup(5001, [[103, 2]])] } };
    const { harness } = buildHarness([links, GROUPS, rollups]);
    const result = await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, include_mastery: "summary" });
    const payload = parseJsonResult<{
      outcomes: Array<{ ratings: unknown[] }>;
      mastery: { outcomes: Array<{ mastered: unknown; not_yet: unknown; average: unknown }> };
      warnings: string[];
    }>(result);
    expect(payload.outcomes[0]!.ratings).toEqual([]);
    expect(payload.mastery.outcomes[0]).toMatchObject({ mastered: null, not_yet: null, average: 2 });
    expect(payload.warnings.some((warning) => warning.includes("no mastery threshold"))).toBe(true);
  });

  it("skips the results call when the course has no outcomes", async () => {
    const { harness, requests } = buildHarness([{ status: 200, data: [] }, { status: 200, data: [] }]);
    const result = await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, include_mastery: "students" });
    expect(textOf(result)).toContain("no outcomes are linked to this course");
    expect(requests).toHaveLength(2);
  });

  it("never sends anything but GET requests", async () => {
    const { harness, requests } = buildHarness([LINKS, GROUPS, ROLLUPS_PAGE_1, ROLLUPS_PAGE_2]);
    await harness.call("get_course_outcomes", { course_identifier: COURSE_ID, include_mastery: "students" });
    expect(new Set(requests.map((request) => request.method))).toEqual(new Set(["GET"]));
  });

  it("clips long descriptions and flags the cut", async () => {
    const long = "word ".repeat(400);
    const links: FakeResponse = {
      status: 200,
      data: [{ outcome_group: { id: 1 }, outcome: outcome(104, "Long one", { description: `<p>${long}</p>` }) }],
    };
    const { harness } = buildHarness([links, GROUPS]);
    const payload = parseJsonResult<{ outcomes: Array<{ description: string; description_truncated?: boolean }> }>(
      await harness.call("get_course_outcomes", { course_identifier: COURSE_ID }),
    );
    expect(payload.outcomes[0]!.description).toHaveLength(600);
    expect(payload.outcomes[0]!.description_truncated).toBe(true);
    expect(REAL_NAMES.test(JSON.stringify(payload))).toBe(false);
  });
});
