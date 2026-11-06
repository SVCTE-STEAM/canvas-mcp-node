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
import { registerAnalyticsTools } from "../../src/tools/analytics.js";

const COURSE_ID = 60366;
const REAL_NAMES = /Grace|Park|Ana Maria|Leo Chen|Ivy Lee|Sam Fox/;

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-analytics-"));
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
  registerAnalyticsTools(harness.server as never, mock.client, anonymizer);
  return { harness, requests: mock.requests };
}

function textOf(result: ToolResponse): string {
  return result.content?.[0]?.text ?? "";
}

describe("registerAnalyticsTools", () => {
  it("registers both analytics tools", () => {
    const { harness } = buildHarness([]);
    expect([...harness.tools.keys()].sort()).toEqual(["get_assignment_analytics", "get_student_analytics"]);
  });

  describe("get_assignment_analytics", () => {
    const assignment: FakeResponse = {
      status: 200,
      data: { id: 77, name: "Essay 1", due_at: "2026-01-10T23:59:00Z", points_possible: 100, published: true },
    };
    const roster: FakeResponse = {
      status: 200,
      data: [
        { id: 1001, name: "Grace Park" },
        { id: 1002, name: "Ana Maria" },
        { id: 1003, name: "Leo Chen" },
        { id: 1004, name: "Ivy Lee" },
        { id: 1005, name: "Sam Fox" },
      ],
    };
    const submissions: FakeResponse = {
      status: 200,
      data: [
        { user_id: 1001, submitted_at: "2026-01-09T10:00:00Z", score: 95, late: false, missing: false },
        { user_id: 1002, submitted_at: "2026-01-11T10:00:00Z", score: 65, late: true, missing: false },
        { user_id: 1003, submitted_at: null, score: null, late: false, missing: true },
        { user_id: 1004, submitted_at: null, score: null, excused: true },
        // Test Student: not on the roster, must not skew the numbers.
        { user_id: 9999, submitted_at: "2026-01-09T10:00:00Z", score: 100, late: false },
      ],
    };

    it("computes counts, rates, score stats and grade buckets over roster students", async () => {
      const { harness, requests } = buildHarness([assignment, roster, submissions]);
      const result = await harness.call("get_assignment_analytics", { course_identifier: COURSE_ID, assignment_id: 77 });
      expect(result.isError).toBeFalsy();
      expect(requests.map((request) => request.url)).toEqual([
        `/api/v1/courses/${COURSE_ID}/assignments/77`,
        `/api/v1/courses/${COURSE_ID}/users`,
        `/api/v1/courses/${COURSE_ID}/assignments/77/submissions`,
      ]);
      expect(requests[1]?.params).toMatchObject({ "enrollment_type[]": ["student"] });

      const payload = parseJsonResult(result);
      expect(payload.assignment).toMatchObject({ id: 77, name: "Essay 1", points_possible: 100, past_due: true });
      expect(payload.counts).toEqual({
        total_students: 5,
        assigned: 4,
        not_assigned: 1,
        submitted: 2,
        on_time: 1,
        late: 1,
        missing: 1,
        not_submitted: 1,
        excused: 1,
        graded: 2,
        excluded_non_roster_submissions: 1,
      });
      expect(payload.rates).toEqual({
        submission_rate_pct: 66.7,
        on_time_pct_of_submitted: 50,
        late_pct_of_submitted: 50,
        missing_pct: 33.3,
        graded_pct: 66.7,
      });
      expect(payload.score_stats).toEqual({
        count: 2,
        mean: 80,
        median: 80,
        min: 65,
        max: 95,
        stdev: 21.21,
        mean_pct: 80,
        median_pct: 80,
      });
      expect(payload.grade_distribution).toEqual({ "90-100+": 1, "80-89": 0, "70-79": 0, "60-69": 1, below_60: 0 });
      expect(payload.high_scoring_count).toBe(1);
    });

    it("lists missing and low-scoring students as pseudonyms only", async () => {
      const { harness } = buildHarness([assignment, roster, submissions]);
      const result = await harness.call("get_assignment_analytics", { course_identifier: COURSE_ID, assignment_id: "77" });
      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(true);
      const without = payload.students_without_submission as { total: number; students: Array<Record<string, unknown>> };
      expect(without.total).toBe(1);
      expect(without.students).toEqual([{ user_id: "1003", name: "Student 1", missing: true }]);
      const low = payload.low_scoring_students as { students: Array<Record<string, unknown>> };
      expect(low.students).toEqual([{ user_id: "1002", name: "Student 2", score: 65, pct: 65 }]);
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("anonymous=false without the operator opt-in still pseudonymizes and warns", async () => {
      const { harness } = buildHarness([assignment, roster, submissions]);
      const result = await harness.call("get_assignment_analytics", {
        course_identifier: COURSE_ID,
        assignment_id: 77,
        anonymous: false,
      });
      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(true);
      expect((payload.warnings as string[])[0]).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("anonymous=false with the operator opt-in returns roster names", async () => {
      process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
      const { harness } = buildHarness([assignment, roster, submissions]);
      const payload = parseJsonResult(
        await harness.call("get_assignment_analytics", { course_identifier: COURSE_ID, assignment_id: 77, anonymous: false }),
      );
      const low = payload.low_scoring_students as { students: Array<{ name: string }> };
      expect(low.students[0]?.name).toBe("Ana Maria");
      expect(payload.warnings).toBeUndefined();
    });

    it("returns null score stats when nothing is graded", async () => {
      const { harness } = buildHarness([
        assignment,
        { status: 200, data: [{ id: 1001, name: "Grace Park" }] },
        { status: 200, data: [{ user_id: 1001, submitted_at: null, score: null, missing: false }] },
      ]);
      const payload = parseJsonResult(
        await harness.call("get_assignment_analytics", { course_identifier: COURSE_ID, assignment_id: 77 }),
      );
      expect(payload.score_stats).toBeNull();
      expect(payload.grade_distribution).toBeNull();
      expect((payload.rates as Record<string, unknown>).late_pct_of_submitted).toBeNull();
    });

    it("rejects a non-numeric assignment id before any Canvas call", async () => {
      const { harness, requests } = buildHarness([]);
      const result = await harness.call("get_assignment_analytics", { course_identifier: COURSE_ID, assignment_id: "77/../1" });
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(0);
    });

    it("surfaces a missing assignment as a tool error", async () => {
      const { harness } = buildHarness([{ status: 404, data: { errors: [{ message: "The specified resource does not exist." }] } }]);
      const result = await harness.call("get_assignment_analytics", { course_identifier: COURSE_ID, assignment_id: 77 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/get_assignment_analytics: .*404/);
    });
  });

  describe("get_student_analytics", () => {
    const summaries: FakeResponse = {
      status: 200,
      data: [
        {
          id: 1002,
          page_views: 100,
          max_page_views: 100,
          participations: 10,
          max_participations: 10,
          tardiness_breakdown: { on_time: 5, late: 0, missing: 0, floating: 0, total: 5 },
        },
        {
          id: 1001,
          page_views: 10,
          max_page_views: 100,
          participations: 2,
          max_participations: 10,
          tardiness_breakdown: { on_time: 3, late: 1, missing: 1, floating: 0, total: 5 },
        },
      ],
    };
    const enrollments: FakeResponse = {
      status: 200,
      data: [
        {
          user_id: 1001,
          user: { id: 1001, name: "Grace Park", sortable_name: "Park, Grace" },
          grades: { current_score: 72.5, current_grade: "C" },
        },
        {
          user_id: 1002,
          user: { id: 1002, name: "Ana Maria", sortable_name: "Maria, Ana" },
          grades: { current_score: 98, current_grade: "A" },
        },
      ],
    };

    it("ranks students lowest engagement first with pseudonyms and current scores", async () => {
      const { harness, requests } = buildHarness([summaries, enrollments]);
      const result = await harness.call("get_student_analytics", { course_identifier: COURSE_ID });
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/analytics/student_summaries`);
      expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/enrollments`);
      expect(requests[1]?.params).toMatchObject({ "type[]": ["StudentEnrollment"] });

      const payload = parseJsonResult(result);
      const students = payload.students as Array<Record<string, unknown>>;
      expect(students.map((student) => student.user_id)).toEqual(["1001", "1002"]);
      expect(students[0]).toEqual({
        user_id: "1001",
        name: expect.stringMatching(/^Student \d+$/),
        engagement_score: 28,
        page_views: 10,
        page_views_pct_of_max: 10,
        participations: 2,
        participations_pct_of_max: 20,
        on_time: 3,
        late: 1,
        missing: 1,
        floating: 0,
        total_assignments: 5,
        submit_rate_pct: 80,
        current_score: 72.5,
        current_grade: "C",
      });
      expect(students[1]?.engagement_score).toBe(100);
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("omits excluded sections and skips the enrollments call when no scores or names are needed", async () => {
      const { harness, requests } = buildHarness([summaries]);
      const payload = parseJsonResult(
        await harness.call("get_student_analytics", {
          course_identifier: COURSE_ID,
          include_access_stats: false,
          include_participation: false,
          include_current_score: false,
          sort_by: "name",
        }),
      );
      expect(requests).toHaveLength(1);
      const students = payload.students as Array<Record<string, unknown>>;
      expect(Object.keys(students[0]!).sort()).toEqual(
        ["engagement_score", "floating", "late", "missing", "name", "on_time", "submit_rate_pct", "total_assignments", "user_id"].sort(),
      );
      const names = students.map((student) => student.name as string);
      expect(names).toEqual([...names].sort());
    });

    it("with student_id filters every call and lists that student's missing and late assignments", async () => {
      const { harness, requests } = buildHarness([
        { status: 200, data: [(summaries.data as unknown[])[1]] },
        { status: 200, data: [(enrollments.data as unknown[])[0]] },
        {
          status: 200,
          data: [
            { assignment_id: 1, score: null, missing: true, late: false, assignment: { id: 1, name: "Lab 2", due_at: "2026-02-01T00:00:00Z", points_possible: 10, description: "<p>long</p>" } },
            { assignment_id: 2, score: 8, missing: false, late: true, assignment: { id: 2, name: "Quiz 1", due_at: "2026-02-03T00:00:00Z", points_possible: 10 } },
            { assignment_id: 3, score: null, missing: true, excused: true, assignment: { id: 3, name: "Excused" } },
            { assignment_id: 4, score: 10, missing: false, late: false, assignment: { id: 4, name: "Essay" } },
          ],
        },
      ]);
      const result = await harness.call("get_student_analytics", { course_identifier: COURSE_ID, student_id: 1001 });
      expect(result.isError).toBeFalsy();
      expect(requests[0]?.params).toMatchObject({ student_id: "1001" });
      expect(requests[1]?.params).toMatchObject({ user_id: "1001" });
      expect(requests[2]?.url).toBe(`/api/v1/courses/${COURSE_ID}/students/submissions`);
      expect(requests[2]?.params).toMatchObject({ "student_ids[]": ["1001"], "include[]": ["assignment"] });

      const payload = parseJsonResult(result);
      expect(payload.student_count).toBe(1);
      expect(payload.student_assignments).toEqual({
        missing_total: 1,
        missing: [{ assignment_id: 1, name: "Lab 2", due_at: "2026-02-01T00:00:00Z", points_possible: 10, score: null }],
        late_total: 1,
        late: [{ assignment_id: 2, name: "Quiz 1", due_at: "2026-02-03T00:00:00Z", points_possible: 10, score: 8 }],
      });
      expect(textOf(result)).not.toMatch(REAL_NAMES);
      expect(textOf(result)).not.toMatch(/long/);
    });

    it("rejects a pseudonym passed as student_id before any Canvas call", async () => {
      const { harness, requests } = buildHarness([]);
      const result = await harness.call("get_student_analytics", { course_identifier: COURSE_ID, student_id: "Student 3" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/not a pseudonym/);
      expect(requests).toHaveLength(0);
    });

    it("explains when Canvas Analytics is unavailable", async () => {
      const { harness } = buildHarness([{ status: 404, data: { errors: [{ message: "not found" }] } }]);
      const result = await harness.call("get_student_analytics", { course_identifier: COURSE_ID });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/analytics are unavailable/);
    });

    it("keeps going with a warning when enrollments cannot be fetched", async () => {
      const { harness } = buildHarness([summaries, { status: 500, data: {} }]);
      const result = await harness.call("get_student_analytics", { course_identifier: COURSE_ID });
      expect(result.isError).toBeFalsy();
      const payload = parseJsonResult(result);
      expect((payload.warnings as string[]).some((warning) => /current scores are unavailable/.test(warning))).toBe(true);
      expect((payload.students as Array<Record<string, unknown>>)[0]?.current_score).toBeNull();
    });

    it("anonymous=false without the operator opt-in still pseudonymizes and warns", async () => {
      const { harness } = buildHarness([summaries, enrollments]);
      const result = await harness.call("get_student_analytics", { course_identifier: COURSE_ID, anonymous: false });
      const payload = parseJsonResult(result);
      expect(payload.anonymized).toBe(true);
      expect((payload.warnings as string[])[0]).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
      expect(textOf(result)).not.toMatch(REAL_NAMES);
    });

    it("anonymous=false with the operator opt-in returns sortable names", async () => {
      process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
      const { harness } = buildHarness([summaries, enrollments]);
      const payload = parseJsonResult(
        await harness.call("get_student_analytics", { course_identifier: COURSE_ID, anonymous: false, include_current_score: false }),
      );
      const names = (payload.students as Array<{ name: string }>).map((student) => student.name);
      expect(names).toEqual(["Park, Grace", "Maria, Ana"]);
    });
  });
});
