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
import { registerPeerReviewTools } from "../../src/tools/peerReviews.js";
import { resetConfirmationTokens } from "../../src/tools/confirmGate.js";
import { PEER_REVIEW_SCRUB_NOTE, csvSafeCell, qualityScore, toCsv } from "../../src/tools/peerReviewCore.js";

const COURSE_ID = 60366;
const ASSIGNMENT_ID = 77;

function assignment(overrides: Record<string, unknown> = {}): FakeResponse {
  return {
    status: 200,
    data: {
      id: ASSIGNMENT_ID,
      name: "Essay 1",
      html_url: "https://canvas.example.com/courses/60366/assignments/77",
      due_at: "2020-01-01T00:00:00Z",
      peer_reviews: true,
      automatic_peer_reviews: true,
      anonymous_peer_reviews: false,
      peer_review_count: 2,
      ...overrides,
    },
  };
}

// Roster order fixes pseudonyms: Grace = Student 1, Ana = Student 2, Leo = Student 3.
const STUDENTS: FakeResponse = {
  status: 200,
  data: [
    { id: 1001, name: "Grace Park" },
    { id: 1002, name: "Ana Maria" },
    { id: 1003, name: "Leo Chen" },
  ],
};
const STAFF: FakeResponse = { status: 200, data: [{ id: 5000, name: "Mr. Smith" }] };

// Grace: 2/2 done. Ana: 1/2 (pending Leo). Leo: 0/2 (pending Grace, Ana).
const PEER_REVIEW_DATA = [
  { id: 1, assessor_id: 1001, user_id: 1002, asset_id: 9002, workflow_state: "completed" },
  { id: 2, assessor_id: 1001, user_id: 1003, asset_id: 9003, workflow_state: "completed" },
  { id: 3, assessor_id: 1002, user_id: 1001, asset_id: 9001, workflow_state: "completed" },
  { id: 4, assessor_id: 1002, user_id: 1003, asset_id: 9003, workflow_state: "assigned" },
  { id: 5, assessor_id: 1003, user_id: 1001, asset_id: 9001, workflow_state: "assigned" },
  { id: 6, assessor_id: 1003, user_id: 1002, asset_id: 9002, workflow_state: "assigned" },
];
const PEER_REVIEWS: FakeResponse = { status: 200, data: PEER_REVIEW_DATA };
const ALL_DONE: FakeResponse = {
  status: 200,
  data: PEER_REVIEW_DATA.map((review) => ({ ...review, workflow_state: "completed" })),
};

const THOUGHTFUL =
  "Grace, consider adding a clearer thesis in the first paragraph? I suggest you could improve the methods section with one more example.";
const HARSH = '=HYPERLINK("http://x.example") This is terrible and wrong, Leo Chen';
const TEACHER_NOTE = "Teacher note: strong draft overall.";

const SUBMISSIONS: FakeResponse = {
  status: 200,
  data: [
    {
      id: 9001,
      user_id: 1001,
      submitted_at: "2020-01-01T10:00:00Z",
      attempt: 1,
      workflow_state: "submitted",
      submission_comments: [
        { author_id: 1002, author_name: "Ana Maria", comment: THOUGHTFUL, created_at: "2020-01-03T10:00:00Z" },
        { author_id: 5000, author_name: "Mr. Smith", comment: TEACHER_NOTE, created_at: "2020-01-04T10:00:00Z" },
      ],
    },
    {
      id: 9002,
      user_id: 1002,
      submitted_at: "2020-01-01T11:00:00Z",
      attempt: 1,
      workflow_state: "submitted",
      submission_comments: [
        { author_id: 1001, author_name: "Grace Park", comment: "Good job", created_at: "2020-01-03T11:00:00Z" },
      ],
    },
    {
      id: 9003,
      user_id: 1003,
      submitted_at: "2020-01-01T12:00:00Z",
      attempt: 2,
      workflow_state: "submitted",
      submission_comments: [
        { author_id: 1001, author_name: "Grace Park", comment: HARSH, created_at: "2020-01-03T12:00:00Z" },
      ],
    },
  ],
};

const COMPLETION_SEQUENCE = (): FakeResponse[] => [assignment(), PEER_REVIEWS, STUDENTS];
const ANON_COMMENT_SEQUENCE = (): FakeResponse[] => [assignment(), PEER_REVIEWS, SUBMISSIONS, STAFF, STUDENTS];

const REAL_NAME_PARTS = ["Grace", "Park", "Ana", "Maria", "Leo", "Chen"];
function expectNoRealNames(serialized: string): void {
  for (const part of REAL_NAME_PARTS) expect(serialized).not.toMatch(new RegExp(`\\b${part}\\b`));
}

let anonRoot: string;
let anonymizer: Anonymizer;
let previousDeanonEnv: string | undefined;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-peer-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
  resetConfirmationTokens();
  previousDeanonEnv = process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
});
afterEach(async () => {
  if (previousDeanonEnv === undefined) delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
  else process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = previousDeanonEnv;
  await fs.rm(anonRoot, { recursive: true, force: true });
});

function setup(responses: FakeResponse[]) {
  const mock = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerPeerReviewTools(harness.server as never, mock.client, anonymizer);
  return { harness, requests: mock.requests, enqueue: mock.enqueue };
}

function text(result: ToolResponse): string {
  return result.content?.[0]?.text ?? "";
}

function posts(requests: RequestRecord[]): RequestRecord[] {
  return requests.filter((request) => request.method === "POST");
}

const BASE = { course_identifier: COURSE_ID, assignment_id: ASSIGNMENT_ID };

describe("registerPeerReviewTools", () => {
  it("registers all thirteen peer-review tools", () => {
    const { harness } = setup([]);
    expect([...harness.tools.keys()].sort()).toEqual([
      "analyze_peer_review_quality",
      "assign_peer_review",
      "extract_peer_review_dataset",
      "generate_peer_review_feedback_report",
      "generate_peer_review_report",
      "get_peer_review_assignments",
      "get_peer_review_comments",
      "get_peer_review_completion_analytics",
      "get_peer_review_followup_list",
      "identify_problematic_peer_reviews",
      "list_peer_reviews",
      "send_peer_review_followup_campaign",
      "send_peer_review_inbox_messages",
    ]);
  });
});

describe("list_peer_reviews", () => {
  it("groups by reviewee with pseudonyms and never requests name-bearing includes", async () => {
    const { harness, requests } = setup([PEER_REVIEWS, STUDENTS]);
    const result = await harness.call("list_peer_reviews", BASE);
    expect(result.isError).toBeFalsy();
    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/peer_reviews`);
    expect(requests[0]?.params?.["include[]"]).toBeUndefined();

    const payload = parseJsonResult(result);
    expect(payload.total_reviews).toBe(6);
    expect(payload.completed_reviews).toBe(3);
    expect(payload.anonymized).toBe(true);
    const reviewees = payload.reviewees as Array<{
      reviewee_id: string;
      reviewee_name: string;
      reviews: Array<{ reviewer_id: string; reviewer_name: string; status: string }>;
    }>;
    const leo = reviewees.find((entry) => entry.reviewee_id === "1003");
    expect(leo?.reviewee_name).toBe("Student 3");
    expect(leo?.reviews).toEqual([
      { reviewer_id: "1001", reviewer_name: "Student 1", status: "completed" },
      { reviewer_id: "1002", reviewer_name: "Student 2", status: "assigned" },
    ]);
    expectNoRealNames(text(result));
  });

  it("anonymous=false without the operator opt-in stays pseudonymized and warns", async () => {
    const { harness } = setup([PEER_REVIEWS, STUDENTS]);
    const result = await harness.call("list_peer_reviews", { ...BASE, anonymous: false });
    const payload = parseJsonResult(result);
    expect(payload.anonymized).toBe(true);
    expect((payload.warnings as string[])[0]).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
    expectNoRealNames(text(result));
  });

  it("anonymous=false with the operator opt-in returns real names", async () => {
    process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
    const { harness } = setup([PEER_REVIEWS, STUDENTS]);
    const payload = parseJsonResult(await harness.call("list_peer_reviews", { ...BASE, anonymous: false }));
    expect(payload.anonymized).toBe(false);
    expect(payload.warnings).toBeUndefined();
    const reviewees = payload.reviewees as Array<{ reviewee_id: string; reviewee_name: string }>;
    expect(reviewees.find((entry) => entry.reviewee_id === "1003")?.reviewee_name).toBe("Leo Chen");
  });

  it("surfaces a Canvas error as a tool error", async () => {
    const { harness } = setup([{ status: 404, data: { errors: [{ message: "The specified resource does not exist." }] } }]);
    const result = await harness.call("list_peer_reviews", BASE);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^list_peer_reviews: .*404/);
  });

  it("rejects a non-numeric assignment_id before calling Canvas", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call("list_peer_reviews", { course_identifier: COURSE_ID, assignment_id: "../users" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/assignment_id must be a numeric Canvas id/);
    expect(requests).toHaveLength(0);
  });

  it("returns an empty result without fetching the roster when there are no peer reviews", async () => {
    const { harness, requests } = setup([{ status: 200, data: [] }]);
    const payload = parseJsonResult(await harness.call("list_peer_reviews", BASE));
    expect(payload.total_reviews).toBe(0);
    expect(requests).toHaveLength(1);
  });
});

describe("get_peer_review_assignments", () => {
  it("returns the mapping with settings and pseudonymized names", async () => {
    const { harness } = setup([assignment(), PEER_REVIEWS, STUDENTS]);
    const result = await harness.call("get_peer_review_assignments", BASE);
    const payload = parseJsonResult(result);
    const info = payload.assignment_info as Record<string, unknown>;
    expect(info.total_reviews_assigned).toBe(6);
    expect(info.peer_review_settings).toEqual({ anonymous: false, automatic: true, reviews_per_student: 2 });
    const rows = payload.assignments as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      peer_review_id: 1,
      reviewer_id: "1001",
      reviewer_name: "Student 1",
      reviewee_id: "1002",
      reviewee_name: "Student 2",
      status: "completed",
      submission_id: "9002",
    });
    expectNoRealNames(text(result));
  });

  it("include_names=false skips the roster; include_submission_details adds submission metadata", async () => {
    const { harness, requests } = setup([assignment(), PEER_REVIEWS, SUBMISSIONS]);
    const payload = parseJsonResult(
      await harness.call("get_peer_review_assignments", { ...BASE, include_names: false, include_submission_details: true }),
    );
    expect(requests.map((request) => request.url)).toEqual([
      `/api/v1/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}`,
      `/api/v1/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/peer_reviews`,
      `/api/v1/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/submissions`,
    ]);
    const rows = payload.assignments as Array<Record<string, unknown>>;
    expect(rows[1]).not.toHaveProperty("reviewer_name");
    expect(rows[1]?.submission).toEqual({
      submitted_at: "2020-01-01T12:00:00Z",
      attempt: 2,
      workflow_state: "submitted",
      late: null,
    });
  });
});

describe("get_peer_review_completion_analytics", () => {
  it("computes summary and status groups with pending reviewees", async () => {
    const { harness } = setup(COMPLETION_SEQUENCE());
    const result = await harness.call("get_peer_review_completion_analytics", BASE);
    const payload = parseJsonResult(result);
    expect(payload.summary).toEqual({
      total_students_enrolled: 3,
      students_with_submissions: 3,
      total_reviews_assigned: 6,
      reviews_completed: 3,
      completion_rate_percent: 50,
      students_all_complete: 1,
      students_partial_complete: 1,
      students_none_complete: 1,
      reviews_per_student: 2,
    });
    const groups = payload.completion_groups as Record<string, Array<Record<string, unknown>>>;
    expect(groups.none_complete).toEqual([
      {
        student_id: "1003",
        student_name: "Student 3",
        completed_count: 0,
        assigned_count: 2,
        completion_rate: 0,
        pending_reviews: [
          { reviewee_id: "1001", reviewee_name: "Student 1" },
          { reviewee_id: "1002", reviewee_name: "Student 2" },
        ],
      },
    ]);
    expect(groups.partial_complete?.[0]).toMatchObject({ student_id: "1002", completion_rate: 50 });
    expect(groups.all_complete?.[0]).not.toHaveProperty("pending_reviews");
    expectNoRealNames(text(result));
  });

  it("include_student_details=false returns the summary only; group_by_status=false returns a flat list", async () => {
    const summaryOnly = setup(COMPLETION_SEQUENCE());
    const brief = parseJsonResult(
      await summaryOnly.harness.call("get_peer_review_completion_analytics", { ...BASE, include_student_details: false }),
    );
    expect(brief).not.toHaveProperty("completion_groups");
    expect(brief).not.toHaveProperty("students");

    const flat = setup(COMPLETION_SEQUENCE());
    const payload = parseJsonResult(
      await flat.harness.call("get_peer_review_completion_analytics", { ...BASE, group_by_status: false }),
    );
    const students = payload.students as Array<{ student_id: string; status: string }>;
    expect(students.map((student) => [student.student_id, student.status])).toEqual([
      ["1003", "none_complete"],
      ["1002", "partial_complete"],
      ["1001", "all_complete"],
    ]);
  });
});

describe("get_peer_review_followup_list", () => {
  it("filters by priority and gives anonymized contact emails without fetching real ones", async () => {
    const { harness, requests } = setup(COMPLETION_SEQUENCE());
    const result = await harness.call("get_peer_review_followup_list", {
      ...BASE,
      priority_filter: "urgent",
      include_contact_info: true,
    });
    const payload = parseJsonResult(result);
    expect(requests[2]?.params?.["include[]"]).toBeUndefined();
    const categories = payload.followup_categories as Record<string, { count: number; students?: Array<Record<string, unknown>> }>;
    expect(Object.keys(categories)).toEqual(["urgent"]);
    expect(categories.urgent?.count).toBe(1);
    expect(categories.urgent?.students?.[0]).toMatchObject({
      student_id: "1003",
      student_name: "Student 3",
      contact_email: "student3@anonymized.local",
      recommended_action: "Send urgent reminder",
    });
    expect((payload.assignment_info as Record<string, unknown>).past_threshold).toBe(true);
    expectNoRealNames(text(result));
  });

  it("rejects an unknown priority_filter without calling Canvas", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call("get_peer_review_followup_list", { ...BASE, priority_filter: "critical" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/priority_filter must be one of/);
    expect(requests).toHaveLength(0);
  });
});

describe("generate_peer_review_report", () => {
  it("returns an anonymized markdown report with action items", async () => {
    const { harness } = setup(COMPLETION_SEQUENCE());
    const result = await harness.call("generate_peer_review_report", BASE);
    expect(result.isError).toBeFalsy();
    const report = text(result);
    expect(report).toContain("# Peer Review Completion Report");
    expect(report).toContain("| Peer Reviews Completed | 3 | 50% |");
    expect(report).toContain("- Student 3 (ID: 1003): assigned to review Student 1 and Student 2 (0/2 complete)");
    expect(report).toContain("- Student 2 (ID: 1002): 1/2 complete, pending review of Student 3");
    expect(report).toContain("## Timeline");
    expectNoRealNames(report);
  });

  it("csv format returns one row per reviewer with priority levels", async () => {
    const { harness } = setup(COMPLETION_SEQUENCE());
    const csv = text(await harness.call("generate_peer_review_report", { ...BASE, report_format: "csv" }));
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "student_id,student_name,assigned_count,completed_count,completion_rate,status,pending_reviews,priority_level",
    );
    expect(lines[1]).toBe("1003,Student 3,2,0,0,none_complete,Student 1 (1001); Student 2 (1002),urgent");
    expect(lines[3]).toBe("1001,Student 1,2,2,100,all_complete,,low");
  });

  it("rejects an unsupported report_format", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call("generate_peer_review_report", { ...BASE, report_format: "pdf" });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("get_peer_review_comments", () => {
  it("attaches each reviewer's own comment, drops teacher comments, and scrubs names by default", async () => {
    const { harness, requests } = setup(ANON_COMMENT_SEQUENCE());
    const result = await harness.call("get_peer_review_comments", BASE);
    expect(result.isError).toBeFalsy();
    expect(requests[2]?.params?.["include[]"]).toEqual(["submission_comments"]);

    const payload = parseJsonResult(result);
    expect(payload.anonymized).toBe(true);
    expect(payload.warnings).toContain(PEER_REVIEW_SCRUB_NOTE);
    const reviews = payload.peer_reviews as Array<Record<string, unknown>>;
    const review3 = reviews.find((review) => review.review_id === 3);
    expect(review3).toMatchObject({
      reviewer_id: "1002",
      reviewer_name: "Student 2",
      reviewee_id: "1001",
      reviewee_name: "Student 1",
      word_count: 22,
      comment_count: 1,
    });
    expect(review3?.comment_text).toBe(THOUGHTFUL.replace("Grace", "Student 1"));
    expect(reviews.find((review) => review.review_id === 2)?.comment_text).toContain("wrong, Student 3");
    expect(reviews.find((review) => review.review_id === 5)?.comment_text).toBe("");
    expect(payload.summary_statistics).toMatchObject({ total_reviews: 6, comments_with_text: 3, empty_comments: 3 });

    const serialized = text(result);
    expect(serialized).not.toContain("Teacher note");
    expectNoRealNames(serialized);
  });

  it("anonymize_students=false without the opt-in stays scrubbed and warns", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const result = await harness.call("get_peer_review_comments", { ...BASE, anonymize_students: false });
    const payload = parseJsonResult(result);
    expect(payload.anonymized).toBe(true);
    expect((payload.warnings as string[])[0]).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
    expectNoRealNames(text(result));
  });

  it("anonymize_students=false with the opt-in returns raw text and real names", async () => {
    process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
    const { harness, requests } = setup([assignment(), PEER_REVIEWS, SUBMISSIONS, STUDENTS]);
    const payload = parseJsonResult(
      await harness.call("get_peer_review_comments", { ...BASE, anonymize_students: false, include_submission_context: true }),
    );
    expect(requests).toHaveLength(4);
    const reviews = payload.peer_reviews as Array<Record<string, unknown>>;
    const review3 = reviews.find((review) => review.review_id === 3);
    expect(review3?.comment_text).toBe(THOUGHTFUL);
    expect(review3?.reviewer_name).toBe("Ana Maria");
    expect(review3?.submission).toEqual({ submission_id: 9001, submitted_at: "2020-01-01T10:00:00Z", attempt: 1 });
  });

  it("surfaces an assignment lookup failure as a tool error", async () => {
    const { harness } = setup([{ status: 404, data: { errors: [{ message: "not found" }] } }]);
    const result = await harness.call("get_peer_review_comments", BASE);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/get_peer_review_comments: .*404/);
  });
});

describe("analyze_peer_review_quality", () => {
  it("scores completed reviews, excludes unstarted ones, and returns scrubbed flagged previews", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const result = await harness.call("analyze_peer_review_quality", BASE);
    const payload = parseJsonResult(result);
    expect(payload.excluded_unstarted_reviews).toBe(3);
    expect(payload.overall_analysis).toEqual({
      total_reviews_analyzed: 3,
      quality_distribution: { high_quality: 1, medium_quality: 0, low_quality: 2 },
      average_quality_score: 2.2,
    });
    const metrics = payload.detailed_metrics as Record<string, Record<string, number>>;
    expect(metrics.word_count_stats).toEqual({ mean: 10.7, median: 8, std_dev: 10.3, min: 2, max: 22 });
    const flagged = payload.flagged_reviews as Array<Record<string, unknown>>;
    expect(flagged.map((flag) => [flag.review_id, flag.flag_reason, flag.quality_score])).toEqual([
      [1, "low_quality", 0.6],
      [2, "low_quality", 1],
    ]);
    expect(flagged[1]?.comment).toContain("Student 3");
    expect(flagged[0]?.reviewer_name).toBe("Student 1");
    expect(payload.recommendations).toContain(
      "2 reviews flagged as low quality - may need instructor follow-up",
    );
    expectNoRealNames(text(result));
  });

  it("generate_report=false returns the overall numbers only", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const payload = parseJsonResult(await harness.call("analyze_peer_review_quality", { ...BASE, generate_report: false }));
    expect(payload.flagged_count).toBe(2);
    expect(payload).not.toHaveProperty("flagged_reviews");
    expect(payload).not.toHaveProperty("detailed_metrics");
  });

  it("rejects malformed analysis_criteria before calling Canvas", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call("analyze_peer_review_quality", { ...BASE, analysis_criteria: "{not json" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/analysis_criteria must be valid JSON/);
    expect(requests).toHaveLength(0);
  });
});

describe("identify_problematic_peer_reviews", () => {
  it("flags short, generic, low-quality and harsh reviews with scrubbed previews", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const result = await harness.call("identify_problematic_peer_reviews", BASE);
    const payload = parseJsonResult(result);
    expect(payload.total_reviews_analyzed).toBe(3);
    expect(payload.flag_summary).toEqual({ too_short: 2, generic_language: 1, low_quality: 2, potentially_harsh: 1 });
    const flagged = payload.flagged_reviews as Array<Record<string, unknown>>;
    expect(flagged.map((flag) => [flag.review_id, flag.flags])).toEqual([
      [1, ["too_short", "generic_language", "low_quality"]],
      [2, ["too_short", "low_quality", "potentially_harsh"]],
    ]);
    expect(flagged[1]).toMatchObject({ reviewer_name: "Student 1", reviewee_name: "Student 3" });
    expect(flagged[1]?.comment_preview).toContain("Student 3");
    expectNoRealNames(text(result));
  });

  it("applies custom criteria and flags identical comments as duplicates", async () => {
    const copyPaste = "Strong argument but cite sources";
    const submissions: FakeResponse = {
      status: 200,
      data: [
        { id: 9001, user_id: 1001, submission_comments: [{ author_id: 1002, comment: copyPaste }] },
        { id: 9002, user_id: 1002, submission_comments: [{ author_id: 1001, comment: `${copyPaste}  ` }] },
        { id: 9003, user_id: 1003, submission_comments: [{ author_id: 1001, comment: "Unique remark here, thanks" }] },
      ],
    };
    const { harness } = setup([assignment(), PEER_REVIEWS, submissions, STAFF, STUDENTS]);
    const payload = parseJsonResult(
      await harness.call("identify_problematic_peer_reviews", {
        ...BASE,
        criteria: JSON.stringify({ min_word_count: 1, generic_phrases: [], max_quality_score: 0 }),
      }),
    );
    const flagged = payload.flagged_reviews as Array<{ review_id: number; flags: string[] }>;
    expect(flagged.map((flag) => [flag.review_id, flag.flags])).toEqual([
      [1, ["duplicate_comment"]],
      [3, ["duplicate_comment"]],
    ]);
  });

  it("rejects criteria with the wrong value types", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call("identify_problematic_peer_reviews", {
      ...BASE,
      criteria: { generic_phrases: "good job" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/generic_phrases must be an array of strings/);
    expect(requests).toHaveLength(0);
  });
});

describe("extract_peer_review_dataset", () => {
  it("returns anonymized CSV inline with formula-injection neutralized", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const result = await harness.call("extract_peer_review_dataset", BASE);
    expect(result.isError).toBeFalsy();
    const body = text(result);
    expect(body).toContain(
      "review_id,reviewer_id,reviewer_name,reviewee_id,reviewee_name,status,comment_text,word_count,character_count,timestamp,quality_score",
    );
    expect(body).toContain(
      `2,1001,Student 1,1003,Student 3,completed,"'=HYPERLINK(""http://x.example"") This is terrible and wrong, Student 3",8,`,
    );
    expect(body).toContain("6,1003,Student 3,1002,Student 2,assigned,,0,0,,0");
    expectNoRealNames(body);
  });

  it("json format includes per-review records and quality analytics", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const payload = parseJsonResult(await harness.call("extract_peer_review_dataset", { ...BASE, output_format: "json" }));
    const reviews = payload.peer_reviews as Array<Record<string, unknown>>;
    expect(reviews).toHaveLength(6);
    expect(reviews.find((review) => review.review_id === 3)?.quality_score).toBe(4.9);
    expect((payload.quality_analytics as Record<string, unknown>).flagged_count).toBe(2);
    expectNoRealNames(JSON.stringify(payload));
  });

  it("anonymize_data=false without the opt-in stays anonymized and says so", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const body = text(await harness.call("extract_peer_review_dataset", { ...BASE, anonymize_data: false }));
    expect(body).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
    expectNoRealNames(body);
  });

  it("rejects an unsupported output_format", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call("extract_peer_review_dataset", { ...BASE, output_format: "xlsx" });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("generate_peer_review_feedback_report", () => {
  it("comprehensive report includes metrics, flagged issues and scrubbed samples", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const report = text(await harness.call("generate_peer_review_feedback_report", BASE));
    expect(report).toContain("# Peer Review Quality Report: Essay 1");
    expect(report).toContain("- **Average Quality Score:** 2.2/5.0");
    expect(report).toContain("- **Potentially Harsh:** 1 reviews");
    expect(report).toContain("## Sample Low-Quality Reviews");
    expect(report).toContain("- **Reviewer:** Student 1");
    expect(report).not.toContain("Per-Reviewer Breakdown");
    expectNoRealNames(report);
  });

  it("individual report adds a per-reviewer table; include_student_names without opt-in stays pseudonymized", async () => {
    const { harness } = setup(ANON_COMMENT_SEQUENCE());
    const report = text(
      await harness.call("generate_peer_review_feedback_report", {
        ...BASE,
        report_type: "individual",
        include_student_names: true,
      }),
    );
    expect(report).toContain("| Student 1 | 1001 | 2 | 5 | 0.8 |");
    expect(report).toContain("| Student 2 | 1002 | 1 | 22 | 4.9 |");
    expect(report).not.toContain("## Sample Low-Quality Reviews");
    expect(report).toMatch(/CANVAS_MCP_ALLOW_DEANONYMIZE/);
    expectNoRealNames(report);
  });

  it("rejects an unsupported format_type", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call("generate_peer_review_feedback_report", { ...BASE, format_type: "html" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Only markdown is supported/);
    expect(requests).toHaveLength(0);
  });
});

describe("assign_peer_review", () => {
  const SUBMISSION_FOR_LEO: FakeResponse = { status: 200, data: { id: 9003, user_id: 1003, workflow_state: "submitted" } };
  const CREATED: FakeResponse = { status: 200, data: { id: 321, workflow_state: "assigned", assessor_id: 1001, user_id: 1003 } };
  const ARGS = { ...BASE, reviewer_id: 1001, reviewee_id: 1003 };

  it("preview returns pseudonyms and a token and writes nothing", async () => {
    const { harness, requests } = setup([STUDENTS, SUBMISSION_FOR_LEO]);
    const result = await harness.call("assign_peer_review", ARGS);
    const payload = parseJsonResult(result);
    expect(payload.preview_only).toBe(true);
    expect(typeof payload.confirmation_token).toBe("string");
    expect(payload.reviewer).toEqual({ user_id: "1001", name: "Student 1" });
    expect(payload.reviewee).toEqual({ user_id: "1003", name: "Student 3" });
    expect(payload.submission_id).toBe(9003);
    expect(posts(requests)).toHaveLength(0);
    expectNoRealNames(text(result));
  });

  it("confirm with the token creates the peer review once; a replayed token is refused", async () => {
    const { harness, requests } = setup([
      STUDENTS,
      SUBMISSION_FOR_LEO,
      STUDENTS,
      SUBMISSION_FOR_LEO,
      CREATED,
      STUDENTS,
      SUBMISSION_FOR_LEO,
    ]);
    const token = parseJsonResult(await harness.call("assign_peer_review", ARGS)).confirmation_token as string;

    const confirmed = await harness.call("assign_peer_review", { ...ARGS, confirmation_token: token });
    expect(confirmed.isError).toBeFalsy();
    expect(parseJsonResult(confirmed)).toMatchObject({ peer_review_id: 321, status: "assigned" });
    const writes = posts(requests);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/submissions/9003/peer_reviews`);
    expect(writes[0]?.data).toEqual({ user_id: 1001 });

    const replay = await harness.call("assign_peer_review", { ...ARGS, confirmation_token: token });
    expect(replay.isError).toBe(true);
    expect(text(replay)).toMatch(/already used/);
    expect(posts(requests)).toHaveLength(1);
  });

  it("changing the arguments after the preview voids the token", async () => {
    const SUBMISSION_FOR_ANA: FakeResponse = { status: 200, data: { id: 9002, user_id: 1002 } };
    const { harness, requests } = setup([STUDENTS, SUBMISSION_FOR_LEO, STUDENTS, SUBMISSION_FOR_ANA]);
    const token = parseJsonResult(await harness.call("assign_peer_review", ARGS)).confirmation_token as string;
    const result = await harness.call("assign_peer_review", { ...ARGS, reviewee_id: 1002, confirmation_token: token });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Arguments changed since the preview/);
    expect(posts(requests)).toHaveLength(0);
  });

  it("refuses an unknown token", async () => {
    const { harness, requests } = setup([STUDENTS, SUBMISSION_FOR_LEO]);
    const result = await harness.call("assign_peer_review", { ...ARGS, confirmation_token: "deadbeef" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No peer review was assigned/);
    expect(posts(requests)).toHaveLength(0);
  });

  it("refuses when the reviewee has no submission record and never creates one", async () => {
    const { harness, requests } = setup([STUDENTS, { status: 404, data: { errors: [{ message: "not found" }] } }]);
    const result = await harness.call("assign_peer_review", ARGS);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no submission was created/);
    expect(posts(requests)).toHaveLength(0);
  });

  it("refuses a reviewer who is not an enrolled student", async () => {
    const { harness, requests } = setup([STUDENTS]);
    const result = await harness.call("assign_peer_review", { ...ARGS, reviewer_id: 5000 });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Not enrolled as a student .*5000/);
    expect(requests).toHaveLength(1);
  });

  it("refuses identical reviewer and reviewee without calling Canvas", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call("assign_peer_review", { ...ARGS, reviewee_id: 1001 });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("re-resolves a course code on every call (bypassCache) for the write path", async () => {
    const COURSES: FakeResponse = { status: 200, data: [{ id: COURSE_ID, course_code: "ENG-101", name: "English" }] };
    const { harness, requests } = setup([
      COURSES,
      STUDENTS,
      SUBMISSION_FOR_LEO,
      COURSES,
      STUDENTS,
      SUBMISSION_FOR_LEO,
      CREATED,
    ]);
    const args = { ...ARGS, course_identifier: "ENG-101" };
    const preview = parseJsonResult(await harness.call("assign_peer_review", args));
    expect(preview.course_code).toBe("ENG-101");
    const confirmed = await harness.call("assign_peer_review", {
      ...args,
      confirmation_token: preview.confirmation_token as string,
    });
    expect(confirmed.isError).toBeFalsy();
    expect(requests.filter((request) => request.url === "/api/v1/courses")).toHaveLength(2);
    expect(posts(requests)).toHaveLength(1);
  });
});

describe("send_peer_review_inbox_messages", () => {
  const PERMS: FakeResponse = { status: 200, data: { manage_grades: true } };
  const SENT: FakeResponse = { status: 200, data: [{ id: 555 }] };
  const ARGS = { ...BASE, recipient_ids: ["1003", 1002] };
  const PREVIEW_SEQUENCE = (): FakeResponse[] => [PERMS, assignment(), STUDENTS, STAFF];

  it("preview shows pseudonyms and the {first_name} template and sends nothing", async () => {
    const { harness, requests } = setup(PREVIEW_SEQUENCE());
    const result = await harness.call("send_peer_review_inbox_messages", ARGS);
    const payload = parseJsonResult(result);
    expect(payload.preview_only).toBe(true);
    expect(payload.recipients).toEqual([
      { user_id: "1003", name: "Student 1" },
      { user_id: "1002", name: "Student 2" },
    ]);
    expect(payload.subject_template).toBe("Peer Review Reminder: Essay 1");
    expect(payload.body_template).toContain("Hi {first_name},");
    expect(payload.body_template).toContain("https://canvas.example.com/courses/60366/assignments/77");
    expect(payload.personalized).toBe(true);
    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/permissions`);
    expect(posts(requests)).toHaveLength(0);
    expectNoRealNames(text(result));
  });

  it("confirm sends one personalized message per recipient; output stays anonymized; replay is refused", async () => {
    const { harness, requests } = setup([...PREVIEW_SEQUENCE(), ...PREVIEW_SEQUENCE(), SENT, SENT, ...PREVIEW_SEQUENCE()]);
    const token = parseJsonResult(await harness.call("send_peer_review_inbox_messages", ARGS)).confirmation_token as string;

    const result = await harness.call("send_peer_review_inbox_messages", { ...ARGS, confirmation_token: token });
    expect(result.isError).toBeFalsy();
    const payload = parseJsonResult(result);
    expect(payload).toMatchObject({ sent: 2, failed: 0 });
    expectNoRealNames(text(result));

    const writes = posts(requests);
    expect(writes).toHaveLength(2);
    expect(writes.every((write) => write.url === "/api/v1/conversations")).toBe(true);
    const first = writes[0]?.data as Record<string, unknown>;
    expect(first.recipients).toEqual(["1003"]);
    expect(first.body).toContain("Hi Leo,");
    expect(first.context_code).toBe(`course_${COURSE_ID}`);
    expect((writes[1]?.data as Record<string, unknown>).body).toContain("Hi Ana,");

    const replay = await harness.call("send_peer_review_inbox_messages", { ...ARGS, confirmation_token: token });
    expect(replay.isError).toBe(true);
    expect(posts(requests)).toHaveLength(2);
  });

  it("a changed custom_message or a renamed assignment voids the token", async () => {
    const { harness, requests } = setup([
      ...PREVIEW_SEQUENCE(),
      ...PREVIEW_SEQUENCE(),
      PERMS,
      assignment({ name: "Essay 1 (revised)" }),
      STUDENTS,
      STAFF,
    ]);
    const token = parseJsonResult(await harness.call("send_peer_review_inbox_messages", ARGS)).confirmation_token as string;

    const edited = await harness.call("send_peer_review_inbox_messages", {
      ...ARGS,
      custom_message: "Different text",
      confirmation_token: token,
    });
    expect(edited.isError).toBe(true);
    expect(text(edited)).toMatch(/Nothing was sent/);

    const renamed = await harness.call("send_peer_review_inbox_messages", { ...ARGS, confirmation_token: token });
    expect(renamed.isError).toBe(true);
    expect(text(renamed)).toMatch(/Arguments changed since the preview/);
    expect(posts(requests)).toHaveLength(0);
  });

  it("refuses recipients who are not enrolled in the course", async () => {
    const { harness, requests } = setup(PREVIEW_SEQUENCE());
    const result = await harness.call("send_peer_review_inbox_messages", { ...BASE, recipient_ids: ["1003", "424242"] });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not enrolled .*424242.*Nothing was sent/);
    expect(posts(requests)).toHaveLength(0);
  });

  it("refuses when the token lacks manage_grades", async () => {
    const { harness, requests } = setup([{ status: 200, data: { manage_grades: false } }]);
    const result = await harness.call("send_peer_review_inbox_messages", ARGS);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/manage_grades/);
    expect(requests).toHaveLength(1);
  });
});

describe("send_peer_review_followup_campaign", () => {
  const SENT: FakeResponse = { status: 200, data: [{ id: 777 }] };
  const CAMPAIGN_SEQUENCE = (reviews: FakeResponse = PEER_REVIEWS): FakeResponse[] => [
    assignment(),
    reviews,
    STUDENTS,
    STUDENTS,
    STAFF,
  ];

  it("preview plans urgent and partial batches with pseudonyms and sends nothing", async () => {
    const { harness, requests } = setup(CAMPAIGN_SEQUENCE());
    const result = await harness.call("send_peer_review_followup_campaign", BASE);
    const payload = parseJsonResult(result);
    expect(payload.preview_only).toBe(true);
    const batches = payload.planned_reminders as Array<Record<string, unknown>>;
    expect(batches.map((batch) => [batch.label, batch.recipients])).toEqual([
      ["urgent", [{ user_id: "1003", name: "Student 3" }]],
      ["partial", [{ user_id: "1002", name: "Student 2" }]],
    ]);
    expect(batches[0]?.subject_template).toBe("URGENT: Peer Review: Essay 1");
    expect((payload.analytics_summary as Record<string, unknown>).completion_rate_percent).toBe(50);
    expect(posts(requests)).toHaveLength(0);
    expectNoRealNames(text(result));
  });

  it("confirm sends both batches once; replay is refused", async () => {
    const { harness, requests } = setup([
      ...CAMPAIGN_SEQUENCE(),
      ...CAMPAIGN_SEQUENCE(),
      SENT,
      SENT,
      ...CAMPAIGN_SEQUENCE(),
    ]);
    const token = parseJsonResult(await harness.call("send_peer_review_followup_campaign", BASE)).confirmation_token as string;
    const result = await harness.call("send_peer_review_followup_campaign", { ...BASE, confirmation_token: token });
    expect(result.isError).toBeFalsy();
    const payload = parseJsonResult(result);
    expect(payload.summary).toMatchObject({ urgent_reminders_sent: 1, partial_reminders_sent: 1, total_reminders_sent: 2 });
    expectNoRealNames(text(result));

    const writes = posts(requests);
    expect(writes).toHaveLength(2);
    expect((writes[0]?.data as Record<string, unknown>).recipients).toEqual(["1003"]);
    expect((writes[0]?.data as Record<string, unknown>).body).toContain("Hi Leo,");
    expect((writes[0]?.data as Record<string, unknown>).subject).toBe("URGENT: Peer Review: Essay 1");

    const replay = await harness.call("send_peer_review_followup_campaign", { ...BASE, confirmation_token: token });
    expect(replay.isError).toBe(true);
    expect(posts(requests)).toHaveLength(2);
  });

  it("a completion shift between preview and confirm voids the token", async () => {
    const drifted: FakeResponse = {
      status: 200,
      data: PEER_REVIEW_DATA.map((review) => (review.id === 5 ? { ...review, workflow_state: "completed" } : review)),
    };
    const { harness, requests } = setup([...CAMPAIGN_SEQUENCE(), ...CAMPAIGN_SEQUENCE(drifted)]);
    const token = parseJsonResult(await harness.call("send_peer_review_followup_campaign", BASE)).confirmation_token as string;
    const result = await harness.call("send_peer_review_followup_campaign", { ...BASE, confirmation_token: token });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Nothing was sent/);
    expect(posts(requests)).toHaveLength(0);
  });

  it("reports nothing to send, without a token, when every review is complete", async () => {
    const { harness, requests } = setup([assignment(), ALL_DONE, STUDENTS]);
    const result = await harness.call("send_peer_review_followup_campaign", BASE);
    const payload = parseJsonResult(result);
    expect(payload.nothing_to_send).toBe(true);
    expect(payload).not.toHaveProperty("confirmation_token");
    expect(requests).toHaveLength(3);
  });
});

describe("peerReviewCore helpers", () => {
  it("csvSafeCell neutralizes formula prefixes, including behind leading whitespace", () => {
    expect(csvSafeCell("=1+1")).toBe("'=1+1");
    expect(csvSafeCell("  @SUM(A1)")).toBe("'  @SUM(A1)");
    expect(csvSafeCell("plain")).toBe("plain");
    expect(csvSafeCell(null)).toBe("");
    expect(toCsv(["a", "b"], [['x,"y"', 1]])).toBe('a,b\n"x,""y""",1');
  });

  it("qualityScore matches the Python heuristic on reference comments", () => {
    expect(qualityScore("")).toBe(0);
    expect(qualityScore("Good job")).toBeCloseTo(0.6);
    expect(qualityScore(THOUGHTFUL)).toBeCloseTo(4.9);
  });
});
