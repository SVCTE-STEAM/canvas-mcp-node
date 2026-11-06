import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Anonymizer } from "../../src/anonymizer.js";
import {
  hasPlaceholders,
  personalize,
  resolveRecipients,
  sendIndividualMessages,
  validateOutbound,
} from "../../src/tools/messagingShared.js";
import { buildMockCanvas } from "../_helpers/mockCanvas.js";

let tmpRoot: string;
let anonymizer: Anonymizer;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msgshared-"));
  anonymizer = new Anonymizer({ rootDir: tmpRoot });
  await anonymizer.init();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const roster = [
  { id: 11, name: "Maria Lopez" },
  { id: 12, name: "Dev Patel" },
];
const staff = [{ id: 99, name: "Ms. Teacher" }];

describe("personalize / placeholders", () => {
  it("fills {first_name} and {name} from the real name", () => {
    expect(personalize("Hi {first_name}, ({name})", "Maria Lopez")).toBe("Hi Maria, (Maria Lopez)");
  });
  it("falls back gracefully on an empty name", () => {
    expect(personalize("Hi {first_name}", "")).toBe("Hi there");
  });
  it("detects placeholders", () => {
    expect(hasPlaceholders("Hello {first_name}")).toBe(true);
    expect(hasPlaceholders("Hello class")).toBe(false);
  });
});

describe("validateOutbound", () => {
  it("rejects empty recipients, subject and body, and over-long subjects", () => {
    expect(validateOutbound([], "s", "b")).toMatch(/at least one/);
    expect(validateOutbound(["1"], " ", "b")).toMatch(/subject/);
    expect(validateOutbound(["1"], "s", "")).toMatch(/body/);
    expect(validateOutbound(["1"], "x".repeat(256), "b")).toMatch(/255/);
    expect(validateOutbound(["1"], "s", "b")).toBeNull();
  });
});

describe("resolveRecipients", () => {
  it("maps students to pseudonyms, keeps staff, and reports non-enrolled ids", async () => {
    const mock = buildMockCanvas([
      { status: 200, data: roster },
      { status: 200, data: staff },
    ]);
    const { recipients, unknown } = await resolveRecipients(mock.client, anonymizer, 5, ["11", 99, "12", "11", "4040"]);
    expect(unknown).toEqual(["4040"]);
    expect(recipients.map((r) => [r.id, r.role])).toEqual([
      ["11", "student"],
      ["99", "staff"],
      ["12", "student"],
    ]);
    const displays = recipients.map((r) => r.display).join(" ");
    expect(displays).not.toMatch(/Maria|Dev|Lopez|Patel/);
    expect(recipients[0].display).toMatch(/^Student \d+$/);
  });
});

describe("sendIndividualMessages", () => {
  it("sends one private conversation per recipient with server-side personalization", async () => {
    const mock = buildMockCanvas([
      { status: 200, data: roster },
      { status: 200, data: staff },
    ]);
    const { recipients } = await resolveRecipients(mock.client, anonymizer, 5, ["11", "12"]);
    mock.enqueue({ status: 200, data: [{ id: 501 }] });
    mock.enqueue({ status: 500, data: { errors: [{ message: "boom" }] } });

    const outcomes = await sendIndividualMessages(mock.client, 5, recipients, "Hi {first_name}", "Dear {name}, see you.");
    const posts = mock.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    const first = posts[0].data as Record<string, unknown>;
    expect(first.recipients).toEqual(["11"]);
    expect(first.subject).toBe("Hi Maria");
    expect(first.body).toBe("Dear Maria Lopez, see you.");
    expect(first.context_code).toBe("course_5");
    expect(first.force_new).toBe(true);
    expect(first.group_conversation).toBe(false);

    expect(outcomes[0]).toMatchObject({ ok: true, conversation_id: 501, user_id: "11" });
    expect(outcomes[1]).toMatchObject({ ok: false, user_id: "12" });
    expect(JSON.stringify(outcomes)).not.toMatch(/Maria|Dev|Lopez|Patel/);
  });
});
