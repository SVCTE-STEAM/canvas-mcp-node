import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadSkills, parseSkill } from "../src/skills.js";
import { registerSkillTools, SERVER_INSTRUCTIONS } from "../src/tools/skills.js";
import { buildToolHarness } from "./_helpers/mockCanvas.js";

const REPO_SKILLS = path.resolve("skills");

describe("bundled skills", () => {
  it("loads every skills/<name>/SKILL.md with matching names and real descriptions", async () => {
    const warnings: string[] = [];
    const skills = await loadSkills(REPO_SKILLS, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual([
      "canvas-accessibility-auditor",
      "canvas-course-builder",
      "canvas-course-qc",
      "canvas-discussion-facilitator",
      "canvas-morning-check",
      "canvas-peer-review-manager",
      "grade-submissions",
      "plan-assessment",
      "plan-course",
      "plan-lesson",
      "plan-module",
      "post-lesson-page",
      "post-quiz",
      "setup-rubric",
    ]);
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(40);
      expect(skill.body).not.toMatch(/^---/);
      expect(skill.body.length).toBeGreaterThan(200);
    }
  });

  it("returns [] with a warning when the directory is missing", async () => {
    const warnings: string[] = [];
    expect(await loadSkills(path.join(os.tmpdir(), "no-such-skills-dir-xyz"), (m) => warnings.push(m))).toEqual([]);
    expect(warnings[0]).toMatch(/not found/);
  });

  it("skips malformed or misnamed skills without failing the rest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-"));
    try {
      await fs.mkdir(path.join(root, "good"));
      await fs.writeFile(path.join(root, "good", "SKILL.md"), "---\nname: good\ndescription: Does a thing well.\n---\nBody");
      await fs.mkdir(path.join(root, "nofront"));
      await fs.writeFile(path.join(root, "nofront", "SKILL.md"), "no frontmatter here");
      await fs.mkdir(path.join(root, "wrongname"));
      await fs.writeFile(path.join(root, "wrongname", "SKILL.md"), "---\nname: other\ndescription: x y z\n---\nBody");
      const warnings: string[] = [];
      const skills = await loadSkills(root, (m) => warnings.push(m));
      expect(skills.map((s) => s.name)).toEqual(["good"]);
      expect(warnings).toHaveLength(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("parseSkill strips CRLF frontmatter", () => {
    const skill = parseSkill("---\r\nname: a\r\ndescription: b c\r\n---\r\nHello", "x");
    expect(skill).toEqual({ name: "a", description: "b c", body: "Hello" });
  });
});

describe("registerSkillTools", () => {
  it("registers get_skill with the full catalog in its description and serves bodies", async () => {
    const skills = await loadSkills(REPO_SKILLS);
    const harness = buildToolHarness();
    registerSkillTools(harness.server as never, skills);
    const tool = harness.tools.get("get_skill");
    expect(tool).toBeDefined();
    for (const skill of skills) expect(tool?.description).toContain(`- ${skill.name}: `);

    const result = await harness.call("get_skill", { name: "canvas-morning-check" });
    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.text).toMatch(/^# Workflow: canvas-morning-check/);
    expect(result.content?.[0]?.text).toContain("send_conversation");

    const missing = await harness.call("get_skill", { name: "nope" });
    expect(missing.isError).toBe(true);
  });

  it("registers one prompt per skill that embeds the request and the workflow body", async () => {
    const skills = await loadSkills(REPO_SKILLS);
    const prompts = new Map<string, { config: { description?: string }; cb: (args: { request?: string }) => unknown }>();
    const harness = buildToolHarness();
    const server = {
      ...harness.server,
      registerPrompt: (name: string, config: { description?: string }, cb: (args: { request?: string }) => unknown) => {
        prompts.set(name, { config, cb });
      },
    };
    registerSkillTools(server as never, skills);
    expect([...prompts.keys()]).toEqual(skills.map((s) => s.name));
    const qc = prompts.get("canvas-course-qc")!;
    expect(qc.config.description?.length).toBeLessThan(skills.find((s) => s.name === "canvas-course-qc")!.description.length);
    const out = qc.cb({ request: "Check CULN-1" }) as { messages: Array<{ content: { text: string } }> };
    expect(out.messages[0].content.text).toContain("Check CULN-1");
    expect(out.messages[0].content.text).toContain("get_course_structure");
  });

  it("registers nothing when there are no skills", () => {
    const harness = buildToolHarness();
    registerSkillTools(harness.server as never, []);
    expect(harness.tools.size).toBe(0);
  });

  it("server instructions point the model at get_skill and the preview gate", () => {
    expect(SERVER_INSTRUCTIONS).toContain("get_skill");
    expect(SERVER_INSTRUCTIONS).toContain("confirmation_token");
  });
});
