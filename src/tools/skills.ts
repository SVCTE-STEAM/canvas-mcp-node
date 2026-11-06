import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Skill } from "../skills.js";
import { errorResult, textResult } from "./toolHelpers.js";

/** First sentence, for the short prompt-menu label. */
function firstSentence(text: string): string {
  const cut = text.search(/(?<=[.!?])\s/);
  return cut > 0 ? text.slice(0, cut) : text;
}

export function skillCatalog(skills: Skill[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

export const SERVER_INSTRUCTIONS =
  "Canvas for Teachers (teacher-only Canvas LMS tools). It includes built-in teacher workflows " +
  "(morning check, course QC, accessibility audit, planning and posting lessons, assessments, modules, " +
  "courses and quizzes, rubrics, grading, discussions, peer reviews, course copy and scaffolding). " +
  "When the teacher's request matches one, call get_skill with that workflow's name FIRST and follow " +
  "the instructions it returns; the get_skill description lists every workflow and when to use it. " +
  "Students appear as pseudonyms (Student 3); never ask the teacher for real names. Tools that write " +
  "something students will see first return a PREVIEW and a confirmation_token: show the preview and " +
  "only call again with the token after the teacher approves.";

type PromptCapableServer = Pick<McpServer, "registerTool"> & Partial<Pick<McpServer, "registerPrompt">>;

export function registerSkillTools(server: PromptCapableServer, skills: Skill[]): void {
  if (skills.length === 0) return;
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const names = skills.map((skill) => skill.name) as [string, ...string[]];

  server.registerTool(
    "get_skill",
    {
      description:
        "Load a built-in teacher workflow (step-by-step instructions for doing a common Canvas job well). " +
        "Call this FIRST whenever the teacher's request matches one of the workflows below, then follow the " +
        "returned instructions exactly. If a workflow mentions another workflow by name, load that one with " +
        "get_skill too.\n\nWorkflows:\n" +
        skillCatalog(skills),
      inputSchema: {
        name: z.enum(names).describe("Workflow name from the list in this tool's description."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const { name } = input as { name: string };
      const skill = byName.get(name);
      if (!skill) {
        return errorResult(new Error(`Unknown workflow "${name}". Available: ${names.join(", ")}.`), {
          context: "get_skill",
        });
      }
      return textResult(`# Workflow: ${skill.name}\n\n${skill.body}`);
    },
  );

  if (typeof server.registerPrompt !== "function") return;
  for (const skill of skills) {
    server.registerPrompt(
      skill.name,
      {
        title: skill.name,
        description: firstSentence(skill.description),
        argsSchema: {
          request: z
            .string()
            .optional()
            .describe("What you want done, e.g. 'Morning check for AUTO-1 AM'. Leave blank to be asked."),
        },
      },
      ({ request }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Use the "${skill.name}" workflow below for this request: ` +
                `${request && request.trim() ? request.trim() : "(ask me what I need first)"}\n\n` +
                skill.body,
            },
          },
        ],
      }),
    );
  }
}
