import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMockCanvas } from "./_helpers/mockCanvas.js";
import { Anonymizer } from "../src/anonymizer.js";
import { loadSkills } from "../src/skills.js";
import { registerAllTools } from "../src/registerTools.js";

interface RegisteredTool {
  name: string;
  annotations?: Record<string, unknown>;
}

let anonRoot: string;
let tools: RegisteredTool[];

beforeAll(async () => {
  anonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-anon-annotations-"));
  tools = [];
  const server = {
    registerTool: (name: string, config: { annotations?: Record<string, unknown> }) => {
      tools.push({ name, annotations: config.annotations });
    },
    registerPrompt: () => undefined,
  };
  registerAllTools(server as never, {
    canvas: buildMockCanvas().client,
    anonymizer: new Anonymizer({ rootDir: anonRoot }),
    schoolConfig: null,
    skills: await loadSkills(path.resolve("skills")),
    codeExecution: true,
  });
});

afterAll(async () => {
  await fs.rm(anonRoot, { recursive: true, force: true });
});

// Claude's connector Permissions tab groups tools as read-only or write/delete from
// these hints; an unlabeled tool lands with the writes, so teachers can't
// "Always allow" it together with the other read-only tools.
describe("tool annotations", () => {
  it("registers every tool once", () => {
    const names = tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(100);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool declares readOnlyHint and openWorldHint, and every write also declares destructiveHint and idempotentHint", () => {
    const problems = tools.flatMap((tool) => {
      const hints = tool.annotations;
      if (!hints) return [`${tool.name}: no annotations`];
      const missing = ["readOnlyHint", "openWorldHint"].filter((key) => typeof hints[key] !== "boolean");
      if (hints.readOnlyHint === false) {
        missing.push(...["destructiveHint", "idempotentHint"].filter((key) => typeof hints[key] !== "boolean"));
      }
      return missing.length > 0 ? [`${tool.name}: missing ${missing.join(", ")}`] : [];
    });
    expect(problems).toEqual([]);
  });

  it("list_ and get_ tools are read-only", () => {
    const wrong = tools
      .filter((tool) => /^(list|get)_/.test(tool.name) && tool.annotations?.readOnlyHint !== true)
      .map((tool) => tool.name);
    expect(wrong).toEqual([]);
  });

  it("tools that create, change, send or delete are never labeled read-only", () => {
    const writePrefix = /^(create|add|update|edit|bulk|grade|send|post|reply|assign|fix|mark|delete|download|execute)_/;
    const wrong = tools
      .filter((tool) => writePrefix.test(tool.name) && tool.annotations?.readOnlyHint !== false)
      .map((tool) => tool.name);
    expect(wrong).toEqual([]);
  });

  it("delete tools, grading writes and rubric attachments are marked destructive", () => {
    // Attaching a grading rubric makes Canvas drop any rubric already on the assignment.
    const mustBeDestructive = (name: string) =>
      /^delete_/.test(name) || /^(bulk_)?grade_/.test(name) || name === "create_rubric" || name === "create_rubric_association";
    const wrong = tools
      .filter((tool) => mustBeDestructive(tool.name) && tool.annotations?.destructiveHint !== true)
      .map((tool) => tool.name);
    expect(wrong).toEqual([]);
  });

  it("local-only reads are not marked as talking to Canvas", () => {
    const local = ["get_skill", "list_page_templates", "list_competencies", "get_school_info", "get_anonymization_status"];
    for (const name of local) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
  });
});
