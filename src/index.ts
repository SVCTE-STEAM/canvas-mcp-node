#!/usr/bin/env node
import "dotenv/config";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CanvasClient } from "./canvasClient.js";
import { Anonymizer } from "./anonymizer.js";
import { loadSchoolConfig, type SchoolConfig } from "./schoolConfig.js";
import { registerCompetencyTools } from "./tools/competencies.js";
import { registerSchoolInfoTools } from "./tools/school.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerModuleTools } from "./tools/modules.js";
import { registerPageTools } from "./tools/pages.js";
import { registerQuizTools } from "./tools/quizzes.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerRubricTools } from "./tools/rubrics.js";
import { registerUserTools } from "./tools/users.js";
import { registerSubmissionTools } from "./tools/submissions.js";
import { registerDiscussionTools } from "./tools/discussions.js";
import { registerGradingTools } from "./tools/grading.js";
import { registerCodeExecutionTools } from "./tools/code_exec.js";
import { registerAnonymizationTools } from "./tools/anonymization.js";
import { registerCourseContentTools } from "./tools/courseContent.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerOutcomeTools } from "./tools/outcomes.js";
import { registerOutcomeRubricTools } from "./tools/outcomeRubrics.js";
import { registerDiscussionEntryTools } from "./tools/discussionEntries.js";
import { registerContentMigrationTools } from "./tools/contentMigrations.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerPeerReviewTools } from "./tools/peerReviews.js";
import { registerAccessibilityTools } from "./tools/accessibility.js";
import { registerSkillTools, SERVER_INSTRUCTIONS } from "./tools/skills.js";
import { loadSkills } from "./skills.js";
import { isCodeExecutionEnabled } from "./featureFlags.js";

const SERVER_NAME = "canvas-mcp-svcte";
const SERVER_VERSION = "1.2.0";

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bundled unbranded preset (plain lesson / assessment / module-outcomes
 * templates, no competency framework). Layout inside an installed .mcpb:
 *   <install>/server/index.js, <install>/configs/generic.json
 */
function bundledSchoolConfigPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "configs", "generic.json");
}

/** <install>/skills/<name>/SKILL.md — the teacher workflows bundled in the .mcpb. */
function bundledSkillsDir(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "skills");
}

/**
 * Resolve the school config: SCHOOL_CONFIG (a teacher-chosen file) wins;
 * otherwise the bundled generic preset, so the planning skills always find
 * lesson/assessment templates. Claude Desktop passes an empty string when the
 * optional file field is left blank, which lands on the bundled preset.
 */
async function resolveSchoolConfig(): Promise<SchoolConfig | null> {
  const explicit = process.env.SCHOOL_CONFIG?.trim();
  if (explicit) {
    if (await pathExists(explicit)) {
      return loadSchoolConfig({ configPath: explicit });
    }
    process.stderr.write(
      `[${SERVER_NAME}] SCHOOL_CONFIG="${explicit}" did not resolve to a readable file; using the bundled generic preset.\n`,
    );
  }
  const bundled = bundledSchoolConfigPath();
  if (await pathExists(bundled)) {
    return loadSchoolConfig({ configPath: bundled });
  }
  return null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    process.stderr.write(
      `[${SERVER_NAME}] Missing required environment variable: ${name}\n`,
    );
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const canvasApiUrl = requireEnv("CANVAS_API_URL");
  const canvasApiToken = requireEnv("CANVAS_API_TOKEN");

  const canvas = new CanvasClient({
    baseUrl: canvasApiUrl,
    apiToken: canvasApiToken,
  });

  const anonymizer = new Anonymizer();
  await anonymizer.init();

  const schoolConfig = await resolveSchoolConfig();
  if (schoolConfig) {
    process.stderr.write(
      `[${SERVER_NAME}] loaded school config${schoolConfig.schoolName ? `: ${schoolConfig.schoolName}` : ""}\n`,
    );
  } else {
    process.stderr.write(
      `[${SERVER_NAME}] no school config loaded — running in generic mode (list_competencies, page templates will report 'not configured').\n`,
    );
  }

  const skills = await loadSkills(bundledSkillsDir(), (message) =>
    process.stderr.write(`[${SERVER_NAME}] ${message}\n`),
  );
  process.stderr.write(`[${SERVER_NAME}] loaded ${skills.length} built-in teacher workflow(s)\n`);

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Phase 2 tools — anonymizer is wired into every student-data tool before
  // those tools become callable (FERPA gate per plan).
  registerCourseTools(server, canvas);
  registerModuleTools(server, canvas);
  registerPageTools(server, canvas, schoolConfig);
  registerQuizTools(server, canvas);
  registerAssignmentTools(server, canvas, anonymizer, schoolConfig);
  registerRubricTools(server, canvas);
  registerUserTools(server, canvas, anonymizer);
  registerSubmissionTools(server, canvas, anonymizer);
  registerDiscussionTools(server, canvas, anonymizer);
  registerGradingTools(server, canvas);
  registerAnonymizationTools(server, canvas, anonymizer);
  registerCompetencyTools(server, schoolConfig);
  registerSchoolInfoTools(server, schoolConfig);
  registerCourseContentTools(server, canvas);
  registerMessagingTools(server, canvas, anonymizer);
  registerAnalyticsTools(server, canvas, anonymizer);
  registerOutcomeTools(server, canvas, anonymizer);
  registerOutcomeRubricTools(server, canvas);
  registerDiscussionEntryTools(server, canvas, anonymizer);
  registerContentMigrationTools(server, canvas);
  registerGroupTools(server, canvas, anonymizer);
  registerPeerReviewTools(server, canvas, anonymizer);
  registerAccessibilityTools(server, canvas);
  registerSkillTools(server, skills);
  // execute_typescript runs model-written code on the teacher's machine. Off by
  // default for the distributed installer; a power user opts in from the
  // install dialog.
  if (isCodeExecutionEnabled()) {
    registerCodeExecutionTools(server, anonymizer);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} listening on stdio\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[${SERVER_NAME}] fatal: ${message}\n`);
  process.exit(1);
});
