import { beforeEach, describe, expect, it } from "vitest";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type FakeResponse,
  type RequestRecord,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { registerOutcomeRubricTools } from "../../src/tools/outcomeRubrics.js";
import { resetConfirmationTokens } from "../../src/tools/confirmGate.js";

const COURSE_ID = 4242;
const TOOL = "create_rubric_from_outcomes";

beforeEach(() => {
  resetConfirmationTokens();
});

function outcome(id: number, title: string, ratings: Array<{ points: number | null; description: string }>, mastery: number | null = 3) {
  return { id, title, description: `<p>${title}</p>`, mastery_points: mastery, points_possible: 4, ratings, calculation_method: "highest", assessed: false };
}

const TORQUE = outcome(101, "Use a torque wrench", [
  { points: 4, description: "Exceeds" },
  { points: 3, description: "Mastery" },
  { points: 2, description: "Near" },
  { points: 0, description: "Not yet" },
]);
// Deliberately out of order: rows must list ratings highest first.
const WIRING = outcome(102, "Read a wiring diagram", [
  { points: 0, description: "Not yet" },
  { points: 5, description: "Exceeds" },
  { points: 3, description: "Mastery" },
]);

const LINKS = (): FakeResponse => ({
  status: 200,
  data: [
    { outcome_group: { id: 2, title: "Safety" }, outcome: TORQUE },
    { outcome_group: { id: 1, title: "Course" }, outcome: WIRING },
    { outcome_group: { id: 1 }, outcome: outcome(103, "Weld a bead", []) },
  ],
});
const GROUPS = (): FakeResponse => ({
  status: 200,
  data: [
    { id: 1, title: "Auto Tech 1", parent_outcome_group: null },
    { id: 2, title: "Safety", parent_outcome_group: { id: 1 } },
  ],
});
const BRAKE_LAB = (): FakeResponse => ({ status: 200, data: { id: 301, name: "Brake lab", points_possible: 20, published: true } });
const TORQUE_QUIZ = (): FakeResponse => ({ status: 200, data: { id: 302, name: "Torque quiz", points_possible: 9, published: false } });
const HAS_RUBRIC = (): FakeResponse => ({
  status: 200,
  data: { id: 303, name: "Old project", points_possible: 10, published: true, rubric_settings: { id: 9, title: "Old rubric" }, rubric: [{}] },
});
const CREATED = (): FakeResponse => ({
  status: 200,
  data: {
    rubric: { id: 777, title: "Outcomes", points_possible: 9, data: [{ learning_outcome_id: 102 }, { learning_outcome_id: 101 }] },
    rubric_association: { id: 1, association_type: "Course", purpose: "bookmark" },
  },
});
const ASSOCIATED = (assignmentId: number): FakeResponse => ({
  status: 200,
  data: { rubric: { id: 777 }, rubric_association: { id: 50 + assignmentId, association_id: assignmentId, use_for_grading: false } },
});

function setup(responses: FakeResponse[]) {
  const mock = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerOutcomeRubricTools(harness.server as never, mock.client);
  return { harness, requests: mock.requests, enqueue: mock.enqueue };
}

function textOf(result: ToolResponse): string {
  return result.content?.[0]?.text ?? "";
}

function form(request: RequestRecord | undefined): URLSearchParams {
  expect(request?.data).toBeInstanceOf(URLSearchParams);
  return request!.data as URLSearchParams;
}

function writes(requests: RequestRecord[]): RequestRecord[] {
  return requests.filter((request) => request.method !== "GET");
}

const BASE_ARGS = { course_identifier: COURSE_ID, outcome_ids: [102, 101], assignment_ids: [301, 302] };

async function previewToken(harness: ReturnType<typeof setup>["harness"], args: Record<string, unknown>): Promise<string> {
  const preview = parseJsonResult<{ confirmation_token: string }>(await harness.call(TOOL, args));
  return preview.confirmation_token;
}

describe(TOOL, () => {
  it("registers as a non-read-only, two-step tool", () => {
    const { harness } = setup([]);
    const tool = harness.tools.get(TOOL);
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/PREVIEW/);
    expect(tool?.description).toMatch(/never replaced/);
  });

  it("previews rows in the requested order with ratings highest first, and writes nothing", async () => {
    const { harness, requests } = setup([LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ()]);
    const result = await harness.call(TOOL, BASE_ARGS);
    const preview = parseJsonResult<{
      preview_only: boolean;
      rubric: { title: string; total_points: number; rows: Array<Record<string, unknown>> };
      attach_to: Array<Record<string, unknown>>;
      use_for_grading: boolean;
      notes: string[];
      confirmation_token: string;
    }>(result);

    expect(writes(requests)).toEqual([]);
    expect(preview.preview_only).toBe(true);
    expect(textOf(result)).toMatch(/^PREVIEW ONLY — nothing was written\./);
    expect(preview.rubric.rows.map((row) => row.outcome_id)).toEqual(["102", "101"]);
    expect(preview.rubric.rows[0]).toMatchObject({ points: 5, mastery_points: 3, ratings: "5 Exceeds / 3 Mastery / 0 Not yet" });
    expect(preview.rubric.rows[1]).toMatchObject({ group: "Safety", points: 4 });
    expect(preview.rubric.total_points).toBe(9);
    expect(preview.rubric.title).toBe("Outcomes: Read a wiring diagram (+1 more)");
    expect(preview.attach_to.map((target) => target.assignment_id)).toEqual(["301", "302"]);
    expect(preview.use_for_grading).toBe(false);
    expect(preview.notes.join(" ")).toMatch(/Students can see the rubric/);
    expect(preview.notes.join(" ")).toMatch(/Grades and assignment points stay as they are/);
    expect(preview.confirmation_token).toMatch(/^[0-9a-f]{24}$/);
  });

  it("on approval creates the rubric linked to outcomes, then attaches it to each assignment", async () => {
    const { harness, requests, enqueue } = setup([LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ()]);
    const token = await previewToken(harness, BASE_ARGS);
    for (const response of [LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ(), CREATED(), ASSOCIATED(301), ASSOCIATED(302)]) enqueue(response);

    const result = await harness.call(TOOL, { ...BASE_ARGS, confirmation_token: token });
    const payload = parseJsonResult<{ rubric_id: string; rubric_url: string; attached: Array<Record<string, unknown>>; warnings?: string[] }>(result);

    const posted = writes(requests);
    expect(posted.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST /api/v1/courses/${COURSE_ID}/rubrics`,
      `POST /api/v1/courses/${COURSE_ID}/rubric_associations`,
      `POST /api/v1/courses/${COURSE_ID}/rubric_associations`,
    ]);

    const rubric = form(posted[0]);
    expect(rubric.get("rubric[title]")).toBe("Outcomes: Read a wiring diagram (+1 more)");
    expect(rubric.get("rubric[criteria][0][learning_outcome_id]")).toBe("102");
    expect(rubric.get("rubric[criteria][0][description]")).toBe("Read a wiring diagram");
    expect(rubric.get("rubric[criteria][0][points]")).toBe("5");
    expect(rubric.get("rubric[criteria][0][mastery_points]")).toBe("3");
    expect(rubric.get("rubric[criteria][0][ratings][0][description]")).toBe("Exceeds");
    expect(rubric.get("rubric[criteria][0][ratings][0][points]")).toBe("5");
    expect(rubric.get("rubric[criteria][0][ratings][2][points]")).toBe("0");
    expect(rubric.get("rubric[criteria][1][learning_outcome_id]")).toBe("101");
    expect(rubric.get("rubric[criteria][1][ratings][3][description]")).toBe("Not yet");
    expect(rubric.get("rubric_association[association_type]")).toBe("Course");
    expect(rubric.get("rubric_association[association_id]")).toBe(String(COURSE_ID));
    expect(rubric.get("rubric_association[purpose]")).toBe("bookmark");
    expect(rubric.get("rubric_association[use_for_grading]")).toBe("0");

    for (const [index, assignmentId] of [[1, "301"], [2, "302"]] as const) {
      const association = form(posted[index]);
      expect(association.get("rubric_association[rubric_id]")).toBe("777");
      expect(association.get("rubric_association[association_type]")).toBe("Assignment");
      expect(association.get("rubric_association[association_id]")).toBe(assignmentId);
      expect(association.get("rubric_association[purpose]")).toBe("grading");
      expect(association.get("rubric_association[use_for_grading]")).toBe("0");
    }

    expect(payload.rubric_id).toBe("777");
    expect(payload.rubric_url).toBe(`https://canvas.example.com/courses/${COURSE_ID}/rubrics/777`);
    expect(payload.attached.map((entry) => entry.attached)).toEqual([true, true]);
    expect(payload.warnings).toBeUndefined();
    expect(textOf(result)).toContain("attached to 2 of 2 assignment(s)");
  });

  it("refuses an unknown token without writing", async () => {
    const { harness, requests } = setup([LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ()]);
    const result = await harness.call(TOOL, { ...BASE_ARGS, confirmation_token: "deadbeef" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unknown, expired/);
    expect(writes(requests)).toEqual([]);
  });

  it("voids the token when the arguments change after the preview", async () => {
    const { harness, requests, enqueue } = setup([LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ()]);
    const token = await previewToken(harness, BASE_ARGS);
    for (const response of [LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ()]) enqueue(response);
    const result = await harness.call(TOOL, { ...BASE_ARGS, use_for_grading: true, confirmation_token: token });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Arguments changed since the preview/);
    expect(writes(requests)).toEqual([]);
  });

  it("voids the token when an assignment gains a rubric between preview and approval", async () => {
    const { harness, requests, enqueue } = setup([LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ()]);
    const token = await previewToken(harness, BASE_ARGS);
    const quizNowWithRubric: FakeResponse = {
      status: 200,
      data: { id: 302, name: "Torque quiz", points_possible: 9, rubric_settings: { id: 5, title: "Added by co-teacher" } },
    };
    for (const response of [LINKS(), GROUPS(), BRAKE_LAB(), quizNowWithRubric]) enqueue(response);
    const result = await harness.call(TOOL, { ...BASE_ARGS, confirmation_token: token });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Nothing was changed/);
    expect(writes(requests)).toEqual([]);
  });

  it("is single-use", async () => {
    const args = { course_identifier: COURSE_ID, outcome_ids: [101] };
    const { harness, requests, enqueue } = setup([LINKS(), GROUPS()]);
    const token = await previewToken(harness, args);
    for (const response of [LINKS(), GROUPS(), CREATED(), LINKS(), GROUPS()]) enqueue(response);
    expect((await harness.call(TOOL, { ...args, confirmation_token: token })).isError).toBeFalsy();
    const replay = await harness.call(TOOL, { ...args, confirmation_token: token });
    expect(replay.isError).toBe(true);
    expect(writes(requests)).toHaveLength(1);
  });

  it("skips an assignment that already has a rubric and never sends it to Canvas", async () => {
    const args = { course_identifier: COURSE_ID, outcome_ids: [101], assignment_ids: [303, 301] };
    const { harness, requests, enqueue } = setup([LINKS(), GROUPS(), HAS_RUBRIC(), BRAKE_LAB()]);
    const preview = parseJsonResult<{ attach_to: Array<{ assignment_id: string }>; skipped: Array<Record<string, unknown>>; confirmation_token: string; rubric: { title: string } }>(
      await harness.call(TOOL, args),
    );
    expect(preview.attach_to.map((target) => target.assignment_id)).toEqual(["301"]);
    expect(preview.skipped).toEqual([{ assignment_id: "303", name: "Old project", existing_rubric: "Old rubric" }]);
    expect(preview.rubric.title).toBe("Brake lab: Outcomes");

    for (const response of [LINKS(), GROUPS(), HAS_RUBRIC(), BRAKE_LAB(), CREATED(), ASSOCIATED(301)]) enqueue(response);
    await harness.call(TOOL, { ...args, confirmation_token: preview.confirmation_token });
    const associations = writes(requests).filter((request) => request.url.endsWith("/rubric_associations"));
    expect(associations.map((request) => form(request).get("rubric_association[association_id]"))).toEqual(["301"]);
  });

  it("refuses when every listed assignment already has a rubric", async () => {
    const { harness, requests } = setup([LINKS(), GROUPS(), HAS_RUBRIC()]);
    const result = await harness.call(TOOL, { course_identifier: COURSE_ID, outcome_ids: [101], assignment_ids: [303] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/already has a rubric.*never replaces a rubric/);
    expect(textOf(result)).not.toMatch(/confirmation_token/);
    expect(writes(requests)).toEqual([]);
  });

  it("refuses outcomes that are not linked to the course", async () => {
    const { harness, requests } = setup([LINKS(), GROUPS()]);
    const result = await harness.call(TOOL, { course_identifier: COURSE_ID, outcome_ids: [101, 999] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/outcome id\(s\) 999 are not linked to course 4242/);
    expect(writes(requests)).toEqual([]);
  });

  it("refuses an outcome with no rating scale", async () => {
    const { harness, requests } = setup([LINKS(), GROUPS()]);
    const result = await harness.call(TOOL, { course_identifier: COURSE_ID, outcome_ids: [103] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no rating scale.*Weld a bead \(id 103\)/);
    expect(writes(requests)).toEqual([]);
  });

  it("reports an assignment that is not in the course", async () => {
    const { harness } = setup([LINKS(), GROUPS(), { status: 404, data: { errors: [{ message: "not found" }] } }]);
    const result = await harness.call(TOOL, { course_identifier: COURSE_ID, outcome_ids: [101], assignment_ids: [999] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/assignment 999 was not found in course 4242/);
  });

  it("rejects non-numeric ids before calling Canvas", async () => {
    const { harness, requests } = setup([]);
    const result = await harness.call(TOOL, { course_identifier: COURSE_ID, outcome_ids: ["torque"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/outcome_ids must be numeric/);
    expect(requests).toHaveLength(0);
  });

  it("with use_for_grading, previews the points change and attaches for grading", async () => {
    const args = { ...BASE_ARGS, use_for_grading: true };
    const { harness, requests, enqueue } = setup([LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ()]);
    const preview = parseJsonResult<{ notes: string[]; attach_to: Array<Record<string, unknown>>; confirmation_token: string }>(
      await harness.call(TOOL, args),
    );
    // Brake lab is 20 points, the rubric totals 9; the quiz is already 9.
    expect(preview.notes.join(" ")).toContain("change the points of 1 assignment(s) to 9: Brake lab (20 → 9)");
    expect(preview.attach_to[0]).toMatchObject({ points_now: 20, points_after: 9 });

    for (const response of [LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ(), CREATED(), ASSOCIATED(301), ASSOCIATED(302)]) enqueue(response);
    await harness.call(TOOL, { ...args, confirmation_token: preview.confirmation_token });
    const associations = writes(requests).filter((request) => request.url.endsWith("/rubric_associations"));
    expect(associations.map((request) => form(request).get("rubric_association[use_for_grading]"))).toEqual(["1", "1"]);
  });

  it("stops when Canvas refuses the rubric with a 200 error body", async () => {
    const args = { course_identifier: COURSE_ID, outcome_ids: [101], assignment_ids: [301] };
    const { harness, requests, enqueue } = setup([LINKS(), GROUPS(), BRAKE_LAB()]);
    const token = await previewToken(harness, args);
    const refused: FakeResponse = { status: 200, data: { error: true, messages: ["This rubric has Outcomes aligned more than once"] } };
    for (const response of [LINKS(), GROUPS(), BRAKE_LAB(), refused]) enqueue(response);
    const result = await harness.call(TOOL, { ...args, confirmation_token: token });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Canvas refused to create the rubric: This rubric has Outcomes aligned more than once");
    expect(writes(requests)).toHaveLength(1);
  });

  it("reports a failed attachment and keeps going", async () => {
    const { harness, enqueue } = setup([LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ()]);
    const token = await previewToken(harness, BASE_ARGS);
    for (const response of [LINKS(), GROUPS(), BRAKE_LAB(), TORQUE_QUIZ(), CREATED(), { status: 500, data: {} }, ASSOCIATED(302)]) enqueue(response);
    const result = await harness.call(TOOL, { ...BASE_ARGS, confirmation_token: token });
    const payload = parseJsonResult<{ attached: Array<Record<string, unknown>>; warnings: string[] }>(result);
    expect(payload.attached.map((entry) => entry.attached)).toEqual([false, true]);
    expect(payload.attached[0]!.error).toMatch(/rubric_associations failed: 500/);
    expect(payload.warnings[0]).toMatch(/rubric exists \(id 777\) but was not attached to 1 assignment/);
    expect(textOf(result)).toContain("attached to 1 of 2 assignment(s)");
  });

  it("uses a repeated outcome once and says so", async () => {
    const args = { course_identifier: COURSE_ID, outcome_ids: [101, "101"] };
    const { harness } = setup([LINKS(), GROUPS()]);
    const preview = parseJsonResult<{ rubric: { rows: unknown[] }; notes: string[] }>(await harness.call(TOOL, args));
    expect(preview.rubric.rows).toHaveLength(1);
    expect(preview.notes.join(" ")).toContain("listed twice were used once: 101");
  });

  it("warns when Canvas did not link every row to its outcome", async () => {
    const args = { course_identifier: COURSE_ID, outcome_ids: [102, 101] };
    const { harness, enqueue } = setup([LINKS(), GROUPS()]);
    const token = await previewToken(harness, args);
    const partlyLinked: FakeResponse = {
      status: 200,
      data: { rubric: { id: 778, title: "x", points_possible: 9, data: [{ learning_outcome_id: 102 }, { learning_outcome_id: null }] } },
    };
    for (const response of [LINKS(), GROUPS(), partlyLinked]) enqueue(response);
    const payload = parseJsonResult<{ warnings: string[] }>(await harness.call(TOOL, { ...args, confirmation_token: token }));
    expect(payload.warnings[0]).toMatch(/only 1 of 2 row\(s\) are linked to outcomes/);
  });
});
