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
import { registerAllTools } from "./registerTools.js";
import { SERVER_INSTRUCTIONS } from "./tools/skills.js";
import { loadSkills } from "./skills.js";
import { isCodeExecutionEnabled } from "./featureFlags.js";

const SERVER_NAME = "canvas-mcp-svcte";
const SERVER_VERSION = "1.2.1";

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

  registerAllTools(server, {
    canvas,
    anonymizer,
    schoolConfig,
    skills,
    codeExecution: isCodeExecutionEnabled(),
  });

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
