import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { CanvasApiError } from "../types.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";
import {
  CONFIRMATION_TOKEN_PARAM,
  consumeConfirmationToken,
  previewResult,
} from "./confirmGate.js";

const MIGRATION_TYPE = "course_copy_importer";

// Selective import stays out, as in the Python server: Canvas's two-phase
// selective workflow (list importable items, then PUT a selection) needs live
// measurement before it can be exposed safely. Every copy is a full copy.
const SELECTIVE_IMPORT = false;

const OCCUPANCY_ENDPOINTS: ReadonlyArray<[label: string, suffix: string]> = [
  ["assignments", "assignments"],
  ["pages", "pages"],
  ["modules", "modules"],
  ["discussions", "discussion_topics"],
  ["files", "files"],
];

const ID_PARAM = z.union([z.string(), z.number()]);

const DATE_PARAM = z
  .string()
  .optional()
  .describe("ISO-8601 date (YYYY-MM-DD) or datetime. Date shifting needs all four date fields or none.");

const CREATE_MIGRATION_INPUT = {
  target_course_identifier: ID_PARAM.describe("Course code or Canvas id of the course that RECEIVES the copied content."),
  source_course_identifier: ID_PARAM.describe("Course code or Canvas id of the course to copy FROM (read only, never modified)."),
  old_start_date: DATE_PARAM,
  old_end_date: DATE_PARAM,
  new_start_date: DATE_PARAM,
  new_end_date: DATE_PARAM,
  confirmation_token: CONFIRMATION_TOKEN_PARAM,
};

const MIGRATION_STATUS_INPUT = {
  course_identifier: ID_PARAM.describe("Course code or Canvas id of the TARGET course (where the migration was created)."),
  migration_id: ID_PARAM.describe("The migration_id returned by create_content_migration."),
};

interface CanvasCourse {
  id: number;
  name?: string;
  course_code?: string;
  workflow_state?: string;
}

interface CanvasMigration {
  id?: number | string;
  migration_type?: string;
  workflow_state?: string;
  progress_url?: string | null;
  migration_issues_url?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

interface CanvasProgress {
  id?: number;
  workflow_state?: string;
  completion?: number | null;
  message?: string | null;
}

interface CanvasMigrationIssue {
  id?: number;
  issue_type?: string;
  workflow_state?: string;
  description?: string | null;
  fix_issue_html_url?: string | null;
}

function requireNumericId(tool: string, field: string, value: string | number): string {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new CanvasApiError({
      code: "VALIDATION",
      message: `${tool}: ${field} must be a numeric Canvas id, got ${JSON.stringify(String(value))}.`,
    });
  }
  return raw;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/;

/** Offset-less values are read as UTC, matching the Python server's parse_date. */
function parseShiftDate(raw: string): Date | null {
  const value = raw.trim();
  let iso: string;
  if (DATE_ONLY.test(value)) {
    iso = `${value}T00:00:00Z`;
  } else {
    const match = DATETIME.exec(value);
    if (!match) return null;
    const offset = match[3] ? match[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z";
    iso = `${match[1]}T${match[2]}${offset}`;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Date.parse rolls 2026-02-30 over to March; reject instead of shifting by a wrong anchor.
  if (DATE_ONLY.test(value) && new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return new Date(ms);
}

type DateShiftOptions = {
  shift_dates: true;
  old_start_date: string;
  old_end_date: string;
  new_start_date: string;
  new_end_date: string;
};

function normalizeDateOptions(args: {
  old_start_date?: string;
  old_end_date?: string;
  new_start_date?: string;
  new_end_date?: string;
}): DateShiftOptions | null {
  const fields = ["old_start_date", "old_end_date", "new_start_date", "new_end_date"] as const;
  const provided = fields.filter((field) => args[field] !== undefined && args[field] !== null && args[field]!.trim() !== "");
  if (provided.length === 0) return null;
  if (provided.length !== fields.length) {
    throw new CanvasApiError({
      code: "VALIDATION",
      message: "create_content_migration: provide either none or all four date-shift fields.",
    });
  }
  const parsed: Record<string, Date> = {};
  const invalid: string[] = [];
  for (const field of fields) {
    const date = parseShiftDate(args[field]!);
    if (date) parsed[field] = date;
    else invalid.push(field);
  }
  if (invalid.length > 0) {
    throw new CanvasApiError({
      code: "VALIDATION",
      message: `create_content_migration: each date-shift field must be a valid ISO-8601 date. Invalid: ${invalid.join(", ")}.`,
    });
  }
  if (parsed.old_start_date! >= parsed.old_end_date!) {
    throw new CanvasApiError({ code: "VALIDATION", message: "create_content_migration: old_start_date must be before old_end_date." });
  }
  if (parsed.new_start_date! >= parsed.new_end_date!) {
    throw new CanvasApiError({ code: "VALIDATION", message: "create_content_migration: new_start_date must be before new_end_date." });
  }
  return {
    shift_dates: true,
    old_start_date: parsed.old_start_date!.toISOString(),
    old_end_date: parsed.old_end_date!.toISOString(),
    new_start_date: parsed.new_start_date!.toISOString(),
    new_end_date: parsed.new_end_date!.toISOString(),
  };
}

async function fetchCourse(canvas: CanvasClient, courseId: number, label: string): Promise<CanvasCourse> {
  try {
    return await canvas.get<CanvasCourse>(`/api/v1/courses/${courseId}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CanvasApiError({
      code: error instanceof CanvasApiError ? error.code : "UNKNOWN",
      status: error instanceof CanvasApiError ? error.status : undefined,
      message: `create_content_migration: could not read the ${label} course ${courseId}: ${detail}`,
      canvasMessage: error instanceof CanvasApiError ? error.canvasMessage : undefined,
    });
  }
}

function courseView(course: CanvasCourse): Record<string, unknown> {
  return { id: course.id, course_code: course.course_code ?? null, name: course.name ?? null };
}

function courseRef(canvas: CanvasClient, courseId: number): Record<string, unknown> {
  return { id: courseId, course_code: canvas.getCachedCourseCode(courseId) ?? null };
}

async function targetOccupancy(canvas: CanvasClient, targetId: number): Promise<{
  counts: Record<string, number | null>;
  total_items: number;
  unavailable: string[];
  truncated: string[];
}> {
  const counts: Record<string, number | null> = {};
  const unavailable: string[] = [];
  const truncated: string[] = [];
  let total = 0;
  for (const [label, suffix] of OCCUPANCY_ENDPOINTS) {
    try {
      const result = await canvas.getPaginated<unknown>(`/api/v1/courses/${targetId}/${suffix}`);
      counts[label] = result.items.length;
      total += result.items.length;
      if (result.truncated) truncated.push(label);
    } catch {
      counts[label] = null;
      unavailable.push(label);
    }
  }
  return { counts, total_items: total, unavailable, truncated };
}

function occupancyWarnings(occupancy: Awaited<ReturnType<typeof targetOccupancy>>): string[] {
  const warnings: string[] = [];
  if (occupancy.total_items > 0) {
    warnings.push(
      `The target course already contains ${occupancy.total_items} item(s); a course copy ADDS to it and may create duplicates. ` +
        "These counts show occupancy, not a content-level diff.",
    );
  }
  if (occupancy.unavailable.length > 0) {
    warnings.push(`Some target contents could not be read, so the total is partial: ${occupancy.unavailable.join(", ")}.`);
  }
  if (occupancy.truncated.length > 0) {
    warnings.push(`Counts are lower bounds (pagination cap reached): ${occupancy.truncated.join(", ")}.`);
  }
  return warnings;
}

function nextStatusAction(courseId: number, migrationId: string): Record<string, unknown> {
  return {
    tool: "get_content_migration_status",
    arguments: { course_identifier: courseId, migration_id: migrationId },
  };
}

function unconfirmedStartError(sourceId: number, targetId: number, detail: string, cause?: CanvasApiError): CanvasApiError {
  return new CanvasApiError({
    code: cause?.code ?? "UNKNOWN",
    status: cause?.status,
    canvasMessage: cause?.canvasMessage,
    message:
      `create_content_migration: it is NOT confirmed whether Canvas created the migration record ` +
      `(source course ${sourceId} → target course ${targetId}; ${detail}). Check the target course's ` +
      "import history (Settings > Import Course Content) before trying again; a retry could queue a duplicate migration.",
  });
}

function progressIdFromUrl(progressUrl: unknown): string | null {
  if (typeof progressUrl !== "string" || progressUrl.trim() === "") return null;
  let pathname: string;
  try {
    pathname = new URL(progressUrl, "https://canvas.invalid").pathname;
  } catch {
    return null;
  }
  const match = /(?:^|\/)progress\/(\d+)$/.exec(pathname.replace(/\/+$/, ""));
  return match ? match[1]! : null;
}

export function registerContentMigrationTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "create_content_migration",
    {
      description:
        "Copy ALL content of a source course into a target course (Canvas course_copy_importer, full copy; selective import is not supported). " +
        "The source course is only read, never modified. The copy adds to the target and can create duplicates. Optional date shifting needs all four date fields or none. " +
        "TWO-STEP: the first call (no confirmation_token) returns a preview — source and target course, migration type, selective-import setting, date shift, and the target's current contents — and requests nothing; " +
        "after the teacher approves, call again with identical arguments plus the token. Then poll get_content_migration_status.",
      inputSchema: CREATE_MIGRATION_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CREATE_MIGRATION_INPUT>>;
      return safeHandler("create_content_migration", async () => {
        const tool = "create_content_migration";
        const dateOptions = normalizeDateOptions(args);
        const targetId = await canvas.resolveCourseId(args.target_course_identifier, { bypassCache: true });
        const sourceId = await canvas.resolveCourseId(args.source_course_identifier, { bypassCache: true });
        if (targetId === sourceId) {
          throw new CanvasApiError({
            code: "VALIDATION",
            message: `${tool}: source and target both resolve to course ${targetId}; choose two different courses.`,
          });
        }
        // Resolved ids join the token hash: what the teacher approved is the
        // exact source → target pair that gets copied.
        const boundArgs = {
          ...args,
          resolved_source_course_id: sourceId,
          resolved_target_course_id: targetId,
        };

        if (!args.confirmation_token) {
          const target = await fetchCourse(canvas, targetId, "target");
          const source = await fetchCourse(canvas, sourceId, "source");
          canvas.seedCourseCodes([target, source]);
          const occupancy = await targetOccupancy(canvas, targetId);
          const warnings = occupancyWarnings(occupancy);
          return previewResult(
            tool,
            boundArgs,
            {
              source_course: courseView(source),
              target_course: courseView(target),
              migration_type: MIGRATION_TYPE,
              selective_import: SELECTIVE_IMPORT,
              copies: "Everything in the source course (full copy); the source course is not modified.",
              date_shift_options: dateOptions,
              target_current_contents: occupancy,
              ...(warnings.length > 0 ? { warnings } : {}),
            },
            `Would copy ALL content from ${source.course_code ?? sourceId} into ${target.course_code ?? targetId}.`,
          );
        }

        const consumed = consumeConfirmationToken(tool, boundArgs, args.confirmation_token);
        if (!consumed.ok) {
          throw new CanvasApiError({
            code: "VALIDATION",
            message: `${tool}: ${consumed.reason} No migration was requested.`,
          });
        }

        const payload: Record<string, unknown> = {
          migration_type: MIGRATION_TYPE,
          settings: { source_course_id: String(sourceId) },
          selective_import: SELECTIVE_IMPORT,
        };
        if (dateOptions) payload.date_shift_options = dateOptions;

        let created: CanvasMigration;
        try {
          // No automatic retry: a timed-out POST may have queued the copy, and
          // a retry would queue a second full copy into the target.
          created = await canvas.post<CanvasMigration>(`/api/v1/courses/${targetId}/content_migrations`, payload, {
            maxRetries: 0,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw unconfirmedStartError(sourceId, targetId, detail, error instanceof CanvasApiError ? error : undefined);
        }
        const migrationId = created && created.id !== undefined ? String(created.id).trim() : "";
        if (!/^\d+$/.test(migrationId)) {
          throw unconfirmedStartError(sourceId, targetId, "Canvas did not return a numeric migration id");
        }

        return jsonResult(
          {
            migration_created: true,
            migration_id: migrationId,
            workflow_state: created.workflow_state ?? null,
            source_course: courseRef(canvas, sourceId),
            target_course: courseRef(canvas, targetId),
            next_action: nextStatusAction(targetId, migrationId),
          },
          {
            summary:
              `Requested course copy ${migrationId}: ${canvas.getCachedCourseCode(sourceId) ?? sourceId} → ` +
              `${canvas.getCachedCourseCode(targetId) ?? targetId}. Poll get_content_migration_status until terminal.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "get_content_migration_status",
    {
      description:
        "Read one content migration's current progress (one read per call). Call again only when poll_again is true. " +
        "Terminal results include Canvas migration issues; completed_with_issues and failed need teacher review.",
      inputSchema: MIGRATION_STATUS_INPUT,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof MIGRATION_STATUS_INPUT>>;
      return safeHandler("get_content_migration_status", async () => {
        const tool = "get_content_migration_status";
        const migrationId = requireNumericId(tool, "migration_id", args.migration_id);
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const migrationPath = `/api/v1/courses/${courseId}/content_migrations/${migrationId}`;

        const migration = await canvas.get<CanvasMigration>(migrationPath);
        const progressId = progressIdFromUrl(migration.progress_url);
        if (!progressId) {
          throw new CanvasApiError({
            code: "UNKNOWN",
            message: `${tool}: migration ${migrationId} has no progress_url ending in a numeric progress id; its state cannot be read.`,
          });
        }
        const progress = await canvas.get<CanvasProgress>(`/api/v1/progress/${progressId}`);
        const state = typeof progress.workflow_state === "string" ? progress.workflow_state.trim().toLowerCase() : null;

        const base = {
          course_id: courseId,
          course_code: canvas.getCachedCourseCode(courseId) ?? null,
          migration_id: migrationId,
          migration_type: migration.migration_type ?? null,
          progress: {
            id: progress.id ?? null,
            workflow_state: progress.workflow_state ?? null,
            completion: progress.completion ?? null,
            message: progress.message ?? null,
          },
        };

        if (state === "queued" || state === "running") {
          return jsonResult(
            { ...base, status: state, terminal: false, poll_again: true, next_action: nextStatusAction(courseId, migrationId) },
            { summary: `Migration ${migrationId}: ${state} (${progress.completion ?? 0}% complete). Poll again shortly.` },
          );
        }

        if (state !== "completed" && state !== "failed") {
          return jsonResult(
            {
              ...base,
              status: "unknown",
              terminal: false,
              poll_again: false,
              warning: "Canvas returned a missing or unknown progress state; completion cannot be determined.",
            },
            { summary: `Migration ${migrationId}: unknown progress state "${progress.workflow_state ?? ""}".` },
          );
        }

        let issues: CanvasMigrationIssue[];
        try {
          const result = await canvas.getPaginated<CanvasMigrationIssue>(`${migrationPath}/migration_issues`);
          issues = result.items;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return jsonResult(
            {
              ...base,
              status: state,
              terminal: true,
              poll_again: false,
              issues_checked: false,
              requires_review: true,
              warning: `The migration reached a terminal state, but its issues could not be read: ${detail}`,
            },
            { summary: `Migration ${migrationId}: ${state}; migration issues could not be read.` },
          );
        }

        const compactIssues = issues.map((issue) => ({
          id: issue.id ?? null,
          issue_type: issue.issue_type ?? null,
          workflow_state: issue.workflow_state ?? null,
          description: issue.description ?? null,
          fix_issue_html_url: issue.fix_issue_html_url ?? null,
        }));
        const terminal = { ...base, terminal: true, poll_again: false, issues_checked: true, issues: compactIssues };

        if (state === "failed") {
          return jsonResult(
            {
              ...terminal,
              status: "failed",
              requires_review: true,
              warning: "Canvas reports that the content migration FAILED. Review the progress message and issues.",
            },
            { summary: `Migration ${migrationId}: FAILED (${compactIssues.length} issue(s)).` },
          );
        }
        if (compactIssues.length > 0) {
          return jsonResult(
            {
              ...terminal,
              status: "completed_with_issues",
              requires_review: true,
              warning: `Completed with ${compactIssues.length} issue(s); review them before treating the copied course as ready.`,
            },
            { summary: `Migration ${migrationId}: completed with ${compactIssues.length} issue(s).` },
          );
        }
        return jsonResult(
          { ...terminal, status: "completed", requires_review: false },
          { summary: `Migration ${migrationId}: completed with no issues.` },
        );
      });
    },
  );
}
