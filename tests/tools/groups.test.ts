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
import { GROUP_NAME_SCRUB_NOTE, registerGroupTools } from "../../src/tools/groups.js";

const COURSE_ID = 60366;

const STAFF_PAGE: FakeResponse = { status: 200, data: [{ id: 5000, name: "Mr. Smith" }] };
const STUDENT_PAGE: FakeResponse = {
  status: 200,
  data: [
    { id: 1001, name: "Grace Park" },
    { id: 1002, name: "Ana Maria" },
    { id: 1003, name: "Ben Cho" },
  ],
};
const GROUPS: FakeResponse = {
  status: 200,
  data: [
    { id: 1, name: "Grace's crew", group_category_id: 10, members_count: 2 },
    { id: 2, name: "Lab Team B", group_category_id: 10, members_count: 2 },
  ],
};
const MEMBERS_1: FakeResponse = {
  status: 200,
  data: [
    { id: 1001, name: "Grace Park", email: "grace@school.edu" },
    { id: 1002, name: "Ana Maria", email: "ana@school.edu" },
  ],
};
const MEMBERS_2: FakeResponse = {
  status: 200,
  data: [
    { id: 1003, name: "Ben Cho", email: "ben@school.edu" },
    { id: 5000, name: "Mr. Smith", email: "smith@school.edu" },
  ],
};

let anonRoot: string;
let anonymizer: Anonymizer;
beforeEach(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-groups-"));
  anonymizer = new Anonymizer({ rootDir: anonRoot });
  await anonymizer.init();
});
afterEach(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
  delete process.env.CANVAS_MCP_ALLOW_DEANONYMIZE;
});

function buildHarness(responses: FakeResponse[]) {
  const mock = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerGroupTools(harness.server as never, mock.client, anonymizer);
  return { harness, requests: mock.requests };
}

function errorText(result: ToolResponse): string {
  return result.content?.[0]?.text ?? "";
}

function expectNoRawStudentData(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  for (const fragment of ["Grace", "Park", "Ana", "Maria", "Ben", "Cho", "@school.edu"]) {
    expect(serialized).not.toContain(fragment);
  }
}

describe("registerGroupTools", () => {
  it("registers list_groups and check_enrollment", () => {
    const { harness } = buildHarness([]);
    expect([...harness.tools.keys()].sort()).toEqual(["check_enrollment", "list_groups"]);
  });
});

describe("list_groups", () => {
  it("pseudonymizes student members with the course map, keeps staff, scrubs group names, and drops emails", async () => {
    const { harness, requests } = buildHarness([GROUPS, STAFF_PAGE, STUDENT_PAGE, MEMBERS_1, MEMBERS_2]);
    const result = await harness.call("list_groups", { course_identifier: COURSE_ID });

    expect(requests.map((request) => request.url)).toEqual([
      `/api/v1/courses/${COURSE_ID}/groups`,
      `/api/v1/courses/${COURSE_ID}/users`,
      `/api/v1/courses/${COURSE_ID}/users`,
      "/api/v1/groups/1/users",
      "/api/v1/groups/2/users",
    ]);
    const payload = parseJsonResult(result);
    expect(payload.anonymized).toBe(true);
    expect(payload.warnings).toContain(GROUP_NAME_SCRUB_NOTE);
    expect(payload.groups).toEqual([
      {
        id: 1,
        name: "Student 1's crew",
        group_category_id: 10,
        members_count: 2,
        members: [
          { id: 1001, name: "Student 1" },
          { id: 1002, name: "Student 2" },
        ],
      },
      {
        id: 2,
        name: "Lab Team B",
        group_category_id: 10,
        members_count: 2,
        members: [
          { id: 1003, name: "Student 3" },
          { id: 5000, name: "Mr. Smith" },
        ],
      },
    ]);
    expectNoRawStudentData(payload);
    expect(errorText(result)).not.toContain("Grace");
  });

  it("uses the same pseudonyms list_users would allocate for the course", async () => {
    await anonymizer.getOrAllocate(COURSE_ID, { id: 1003, name: "Ben Cho" });
    const { harness } = buildHarness([GROUPS, STAFF_PAGE, STUDENT_PAGE, MEMBERS_1, MEMBERS_2]);
    const payload = parseJsonResult(await harness.call("list_groups", { course_identifier: COURSE_ID }));
    const groups = payload.groups as Array<{ members: Array<{ id: number; name: string }> }>;
    expect(groups[1]?.members[0]).toEqual({ id: 1003, name: "Student 1" });
    expect(groups[0]?.members[0]).toEqual({ id: 1001, name: "Student 2" });
  });

  it("forces anonymization with a warning when anonymous=false lacks the operator opt-in", async () => {
    const { harness } = buildHarness([GROUPS, STAFF_PAGE, STUDENT_PAGE, MEMBERS_1, MEMBERS_2]);
    const payload = parseJsonResult(await harness.call("list_groups", { course_identifier: COURSE_ID, anonymous: false }));
    expect(payload.anonymized).toBe(true);
    expect(payload.warnings).toContainEqual(expect.stringContaining("CANVAS_MCP_ALLOW_DEANONYMIZE"));
    expectNoRawStudentData(payload);
  });

  it("returns real names (still no emails) when the operator opted in and anonymous=false", async () => {
    process.env.CANVAS_MCP_ALLOW_DEANONYMIZE = "true";
    const { harness, requests } = buildHarness([GROUPS, MEMBERS_1, MEMBERS_2]);
    const payload = parseJsonResult(await harness.call("list_groups", { course_identifier: COURSE_ID, anonymous: false }));
    expect(requests).toHaveLength(3);
    expect(payload.anonymized).toBe(false);
    const groups = payload.groups as Array<{ name: string; members: Array<{ name: string }> }>;
    expect(groups[0]?.name).toBe("Grace's crew");
    expect(groups[0]?.members[0]?.name).toBe("Grace Park");
    expect(JSON.stringify(payload)).not.toContain("@school.edu");
  });

  it("keeps listing other groups when one group's members cannot be read", async () => {
    const { harness } = buildHarness([
      GROUPS,
      STAFF_PAGE,
      STUDENT_PAGE,
      { status: 403, data: { errors: [{ message: "forbidden" }] } },
      MEMBERS_2,
    ]);
    const payload = parseJsonResult(await harness.call("list_groups", { course_identifier: COURSE_ID }));
    const groups = payload.groups as Array<{ members: unknown; members_error?: string }>;
    expect(groups[0]?.members).toBeNull();
    expect(groups[0]?.members_error).toContain("403");
    expect((groups[1]?.members as unknown[]).length).toBe(2);
  });

  it("reports no groups without fetching the roster", async () => {
    const { harness, requests } = buildHarness([{ status: 200, data: [] }]);
    const result = await harness.call("list_groups", { course_identifier: COURSE_ID });
    expect(requests).toHaveLength(1);
    expect(errorText(result)).toContain("no groups");
    expect(parseJsonResult(result).groups).toEqual([]);
  });

  it("surfaces a groups 403 as a structured error", async () => {
    const { harness } = buildHarness([{ status: 403, data: { errors: [{ message: "forbidden" }] } }]);
    const result = await harness.call("list_groups", { course_identifier: COURSE_ID });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/^list_groups: /);
  });
});

describe("check_enrollment", () => {
  function enrollment(
    userId: number,
    type: string,
    user: Record<string, unknown>,
    state = "active",
  ): Record<string, unknown> {
    return { id: userId * 10, type, enrollment_state: state, user: { id: userId, name: `Real Name ${userId}`, ...user } };
  }

  function roster(...rows: Array<Record<string, unknown>>): FakeResponse {
    return { status: 200, data: rows };
  }

  async function check(responses: FakeResponse[], args: Record<string, unknown>) {
    const { harness, requests } = buildHarness(responses);
    const result = await harness.call("check_enrollment", { course_identifier: COURSE_ID, ...args });
    return { result, requests };
  }

  it("answers YES on an exact login_id match, reading the whole roster without a type filter", async () => {
    const { result, requests } = await check(
      [roster(enrollment(1, "StudentEnrollment", { login_id: "jdoe" }), enrollment(2, "StudentEnrollment", { login_id: "asmith" }))],
      { net_id: "JDoe" },
    );
    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/enrollments`);
    expect(requests[0]?.params).toMatchObject({ "include[]": ["user"], "state[]": ["active"] });
    expect(requests[0]?.params).not.toHaveProperty("type[]");
    const payload = parseJsonResult(result);
    expect(payload).toMatchObject({
      answer: "YES",
      enrolled: true,
      enrollment: { type: "StudentEnrollment", enrollment_state: "active", matched_on: "login_id" },
      roles_held: ["StudentEnrollment"],
    });
    expect(JSON.stringify(payload)).not.toContain("Real Name");
    expect(errorText(result)).not.toContain("Real Name");
  });

  it("matches a bare id against an email-style login by local part", async () => {
    const { result } = await check([roster(enrollment(1, "StudentEnrollment", { login_id: "jdoe@school.edu" }))], {
      net_id: "jdoe",
    });
    expect(parseJsonResult(result)).toMatchObject({ answer: "YES", enrollment: { matched_on: "login_id" } });
  });

  it("answers NO but names the roles held when the person is enrolled in another role", async () => {
    const { result } = await check([roster(enrollment(1, "TeacherEnrollment", { login_id: "prof" }))], { net_id: "prof" });
    const payload = parseJsonResult(result);
    expect(payload).toMatchObject({ answer: "NO", enrolled: false, roles_held: ["TeacherEnrollment"] });
    expect(errorText(result)).toContain("They ARE enrolled in this course, as: TeacherEnrollment");
  });

  it("answers YES for role=any regardless of enrollment type", async () => {
    const { result } = await check([roster(enrollment(1, "TeacherEnrollment", { login_id: "prof" }))], {
      net_id: "prof",
      role: "any",
    });
    expect(parseJsonResult(result)).toMatchObject({ answer: "YES", enrollment: { type: "TeacherEnrollment" } });
  });

  it("answers a genuine NO when every row is readable and none matches", async () => {
    const { result } = await check([roster(enrollment(1, "StudentEnrollment", { login_id: "someone" }))], {
      net_id: "stranger",
    });
    expect(parseJsonResult(result)).toMatchObject({ answer: "NO", enrolled: false, roles_held: [] });
  });

  it("answers INDETERMINATE, never NO, when Canvas withheld login ids (permission-blind token)", async () => {
    const { result } = await check(
      [roster({ id: 10, type: "StudentEnrollment", enrollment_state: "active", user: { id: 1, name: "Grace Park" } })],
      { net_id: "jdoe" },
    );
    const payload = parseJsonResult(result);
    expect(payload).toMatchObject({ answer: "INDETERMINATE", enrolled: null });
    expect(JSON.stringify(payload)).not.toContain("Grace");
  });

  it("still answers an exact YES when unrelated rows are hidden (an exact match is self-proving)", async () => {
    const { result } = await check(
      [
        roster(
          enrollment(1, "StudentEnrollment", { login_id: "jdoe" }),
          { id: 20, type: "StudentEnrollment", enrollment_state: "active", user: { id: 2 } },
        ),
      ],
      { net_id: "jdoe" },
    );
    expect(parseJsonResult(result).answer).toBe("YES");
  });

  it("answers INDETERMINATE for a local-part match when another row is hidden", async () => {
    const { result } = await check(
      [
        roster(
          enrollment(1, "StudentEnrollment", { login_id: "jdoe@school.edu" }),
          { id: 20, type: "ObserverEnrollment", enrollment_state: "active", user: { id: 2 } },
        ),
      ],
      { net_id: "jdoe" },
    );
    expect(parseJsonResult(result).answer).toBe("INDETERMINATE");
  });

  it("answers AMBIGUOUS when a bare id matches two people by local part", async () => {
    const { result } = await check(
      [
        roster(
          enrollment(1, "StudentEnrollment", { login_id: "jdoe@a.edu" }),
          enrollment(2, "StudentEnrollment", { login_id: "jdoe@b.edu" }),
        ),
      ],
      { net_id: "jdoe" },
    );
    expect(parseJsonResult(result)).toMatchObject({ answer: "AMBIGUOUS", enrolled: null });
  });

  it("answers AMBIGUOUS when a qualified id meets only bare roster ids (domain cannot be verified)", async () => {
    const { result } = await check([roster(enrollment(1, "StudentEnrollment", { login_id: "jdoe" }))], {
      net_id: "jdoe@attacker.example",
    });
    expect(parseJsonResult(result).answer).toBe("AMBIGUOUS");
  });

  it("does not let a bare sis_user_id match back in for a user with a different qualified login", async () => {
    const { result } = await check(
      [roster(enrollment(1, "StudentEnrollment", { login_id: "jdoe@other.edu", sis_user_id: "jdoe" }))],
      { net_id: "jdoe@school.edu" },
    );
    expect(parseJsonResult(result)).toMatchObject({ answer: "NO", enrolled: false });
  });

  it("answers INDETERMINATE when the roster was truncated by the pagination cap", async () => {
    const pages: FakeResponse[] = Array.from({ length: 10 }, (_, index) => ({
      status: 200,
      data: [enrollment(index + 1, "StudentEnrollment", { login_id: `user${index}` })],
      headers: {
        link: `<https://canvas.example.com/api/v1/courses/${COURSE_ID}/enrollments?page=${index + 2}>; rel="next"`,
      },
    }));
    const { result } = await check(pages, { net_id: "absent" });
    expect(parseJsonResult(result).answer).toBe("INDETERMINATE");
  });

  it("omits the state filter when active_only=false", async () => {
    const { requests } = await check([roster(enrollment(1, "StudentEnrollment", { login_id: "jdoe" }, "completed"))], {
      net_id: "jdoe",
      active_only: false,
    });
    expect(requests[0]?.params).not.toHaveProperty("state[]");
  });

  it("reports a 403 roster read as unknown, not negative", async () => {
    const { result } = await check([{ status: 403, data: { errors: [{ message: "unauthorized" }] } }], { net_id: "jdoe" });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("UNKNOWN, not negative");
  });

  it.each(["John Smith", "", "a/b", "x".repeat(255)])("rejects net_id %j before any request", async (netId) => {
    const { result, requests } = await check([], { net_id: netId });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("rejects an unknown role before any request", async () => {
    const { result, requests } = await check([], { net_id: "jdoe", role: "principal" });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
