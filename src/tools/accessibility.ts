import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { CanvasApiError } from "../types.js";
import { CONFIRMATION_TOKEN_PARAM, consumeConfirmationToken, previewResult } from "./confirmGate.js";
import { jsonResult, safeHandler, textResult } from "./toolHelpers.js";
import {
  FIX_TYPES,
  ISSUE_DEFINITIONS,
  checkContentAccessibility,
  extractUfixitViolations,
  formatAccessibilitySummary,
  normalizeHtml,
  planFixes,
  summarizeViolations,
  type FixType,
  type IssueDefinition,
  type IssueType,
  type PlannedFix,
} from "./accessibilityChecks.js";

const COURSE_IDENTIFIER = z.union([z.string(), z.number()]).describe("Course code or Canvas course id.");

const SCAN_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  content_types: z
    .string()
    .optional()
    .describe("Comma-separated content to scan: pages, assignments, syllabus. Default 'pages,assignments'."),
};

const FETCH_UFIXIT_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  page_title: z
    .string()
    .optional()
    .describe('Title of the UFIXIT report page (default "UFIXIT"). An exact title match wins over a partial one.'),
};

const PARSE_UFIXIT_INPUT = {
  report_json: z.string().describe("The JSON returned by fetch_ufixit_report."),
};

const FORMAT_SUMMARY_INPUT = {
  violations_json: z.string().describe("The JSON returned by parse_ufixit_violations."),
};

const DEFAULT_FIX_TYPES = FIX_TYPES.join(",");

const FIX_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  fix_types: z
    .string()
    .optional()
    .describe(
      `Comma-separated fixes (default "${DEFAULT_FIX_TYPES}"): ` +
        "th_scope — add scope to <th> cells that lack it (row for a <th> that opens a row of <td> cells, otherwise col); " +
        "low_contrast — white text on #ff5f05 orange becomes #000000; " +
        "legacy_designplus — migrate DesignPLUS kl_ classes/ids to dp- classes; " +
        'redundant_alt_prefix — drop "image of" / "photo of" from alt text.',
    ),
  content_types: z.string().optional().describe("Comma-separated content to fix: pages (default), assignments."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Kept for compatibility with the Python tool. Every call without confirmation_token is already a preview; " +
        "dry_run: true also forces a preview when a token is passed. Not part of the token binding.",
    ),
  confirmation_token: CONFIRMATION_TOKEN_PARAM,
};

interface CanvasPage {
  page_id?: number;
  url?: string;
  title?: string;
  body?: string | null;
  published?: boolean;
  updated_at?: string;
}

interface CanvasAssignment {
  id: number;
  name?: string;
  description?: string | null;
  published?: boolean;
}

interface CanvasCourseWithSyllabus {
  id: number;
  course_code?: string | null;
  syllabus_body?: string | null;
}

type ContentKind = "page" | "assignment" | "syllabus";

interface ContentTarget {
  content_type: ContentKind;
  content_id: number | string | null;
  content_title: string | null;
  page_url?: string;
  published?: boolean | null;
  html: string;
}

const SCAN_CONTENT_TYPES = ["pages", "assignments", "syllabus"] as const;
const FIX_CONTENT_TYPES = ["pages", "assignments"] as const;
const DETAIL_LIMIT = 10;
const NOT_CHECKED =
  "Not checked automatically: contrast other than the #ff5f05 rule, caption accuracy, PDF/file accessibility, keyboard navigation. Flag these for manual review.";

function pagePath(courseId: number, slug: string): string {
  return `/api/v1/courses/${courseId}/pages/${encodeURIComponent(slug)}`;
}

function assignmentPath(courseId: number, assignmentId: number | string): string {
  return `/api/v1/courses/${courseId}/assignments/${encodeURIComponent(String(assignmentId))}`;
}

function splitList(value: string | undefined, fallback: string): string[] {
  const entries = (value ?? fallback)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(entries)];
}

function validationError(message: string): CanvasApiError {
  return new CanvasApiError({ code: "VALIDATION", message });
}

function courseLabel(canvas: CanvasClient, courseId: number): string {
  return canvas.getCachedCourseCode(courseId) ?? String(courseId);
}

function courseFields(canvas: CanvasClient, courseId: number): Record<string, unknown> {
  const code = canvas.getCachedCourseCode(courseId);
  return code ? { course_id: courseId, course_code: code } : { course_id: courseId };
}

/**
 * Pages with their bodies. A page whose list entry has no `body` key gets its
 * own GET: a missing key means Canvas did not return the body, not that the
 * page is empty, and treating it as empty would report a clean page unseen.
 */
async function fetchPagesWithBodies(
  canvas: CanvasClient,
  courseId: number,
): Promise<{ pages: CanvasPage[]; truncated: boolean }> {
  const { items, truncated } = await canvas.getPaginated<CanvasPage>(`/api/v1/courses/${courseId}/pages`, {
    params: { "include[]": ["body"] },
  });
  const pages: CanvasPage[] = [];
  for (const page of items) {
    if (page.body === undefined && page.url) {
      const full = await canvas.get<CanvasPage>(pagePath(courseId, page.url));
      pages.push({ ...page, body: full.body ?? null });
    } else {
      pages.push(page);
    }
  }
  return { pages, truncated };
}

function pageTargets(pages: CanvasPage[]): ContentTarget[] {
  return pages.flatMap((page) =>
    page.url
      ? [
          {
            content_type: "page" as const,
            content_id: page.page_id ?? null,
            content_title: page.title ?? page.url,
            page_url: page.url,
            published: page.published ?? null,
            html: page.body ?? "",
          },
        ]
      : [],
  );
}

function assignmentTargets(assignments: CanvasAssignment[]): ContentTarget[] {
  return assignments.map((assignment) => ({
    content_type: "assignment" as const,
    content_id: assignment.id,
    content_title: assignment.name ?? null,
    published: assignment.published ?? null,
    html: assignment.description ?? "",
  }));
}

function truncationWarning(kind: string): string {
  return `The ${kind} list was truncated by pagination limits; some ${kind} were not included.`;
}

function groupIssues(target: ContentTarget, issues: ReturnType<typeof checkContentAccessibility>): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const details: string[] = [];
  for (const issue of issues) {
    counts[issue.type] = (counts[issue.type] ?? 0) + 1;
    if (issue.detail) details.push(`${issue.type}: ${issue.detail}`);
  }
  const item: Record<string, unknown> = {
    content_type: target.content_type,
    content_id: target.content_id,
    content_title: target.content_title,
  };
  if (target.page_url) item.page_url = target.page_url;
  item.issues = counts;
  if (details.length > 0) {
    item.details =
      details.length > DETAIL_LIMIT
        ? [...details.slice(0, DETAIL_LIMIT), `…and ${details.length - DETAIL_LIMIT} more`]
        : details;
  }
  return item;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface PlannedItem {
  target: ContentTarget;
  plan: PlannedFix;
}

function targetKey(target: ContentTarget): string {
  return target.content_type === "page" ? `page:${target.page_url}` : `assignment:${target.content_id}`;
}

/**
 * Bound into the confirmation token: a page edited in Canvas between preview
 * and confirm changes the fingerprint, so the teacher never approves one diff
 * and gets another written over newer content.
 */
function planFingerprint(planned: PlannedItem[]): string {
  const entries = planned
    .map(({ target, plan }) => [targetKey(target), sha256(target.html), sha256(plan.html)])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return sha256(JSON.stringify(entries));
}

function itemReference(target: ContentTarget): Record<string, unknown> {
  return target.content_type === "page"
    ? { content_type: "page", title: target.content_title, page_url: target.page_url }
    : { content_type: "assignment", title: target.content_title, assignment_id: target.content_id };
}

function storedHtml(target: ContentTarget, response: unknown): unknown {
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  return target.content_type === "page" ? record.body : record.description;
}

export function registerAccessibilityTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "scan_course_content_accessibility",
    {
      description:
        "Scan a course's page / assignment / syllabus HTML for WCAG-oriented accessibility issues (missing or poor alt text, empty headings and links, " +
        "skipped heading levels, tables without headers or th scope, low-information or raw-URL link text, document links without a file type, " +
        "white-on-orange contrast, small inline fonts, manual bullets, underlined non-links, color-only meaning, legacy DesignPLUS classes, embedded video caption reminders). " +
        "Read-only. Returns per-item issue counts plus an issue_types legend (WCAG criterion, severity, remediation, whether fix_accessibility_issues can fix it).",
      inputSchema: SCAN_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const args = input as { course_identifier: string | number; content_types?: string };
      return safeHandler("scan_course_content_accessibility", async () => {
        const requested = splitList(args.content_types, "pages,assignments");
        const types = SCAN_CONTENT_TYPES.filter((type) => requested.includes(type));
        const ignored = requested.filter((type) => !(SCAN_CONTENT_TYPES as readonly string[]).includes(type));
        if (types.length === 0) {
          throw validationError(
            `content_types "${args.content_types ?? ""}" names nothing scannable. Use any of: ${SCAN_CONTENT_TYPES.join(", ")}.`,
          );
        }
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const warnings: string[] = [];
        if (ignored.length > 0) {
          warnings.push(`Ignored unsupported content type(s): ${ignored.join(", ")}. Supported: ${SCAN_CONTENT_TYPES.join(", ")}.`);
        }

        const targets: ContentTarget[] = [];
        if (types.includes("pages")) {
          const { pages, truncated } = await fetchPagesWithBodies(canvas, courseId);
          if (truncated) warnings.push(truncationWarning("pages"));
          targets.push(...pageTargets(pages));
        }
        if (types.includes("assignments")) {
          const { items, truncated } = await canvas.getPaginated<CanvasAssignment>(
            `/api/v1/courses/${courseId}/assignments`,
          );
          if (truncated) warnings.push(truncationWarning("assignments"));
          targets.push(...assignmentTargets(items));
        }
        if (types.includes("syllabus")) {
          const course = await canvas.get<CanvasCourseWithSyllabus>(`/api/v1/courses/${courseId}`, {
            params: { "include[]": ["syllabus_body"] },
          });
          canvas.seedCourseCodes([course]);
          targets.push({
            content_type: "syllabus",
            content_id: courseId,
            content_title: "Syllabus",
            html: course.syllabus_body ?? "",
          });
        }

        const flat: Array<{ type: IssueType; severity: string; wcag_criterion: string; content_type: string }> = [];
        const items: Array<Record<string, unknown>> = [];
        const scannedCounts: Record<string, number> = {};
        for (const target of targets) {
          scannedCounts[target.content_type] = (scannedCounts[target.content_type] ?? 0) + 1;
          const issues = checkContentAccessibility(target.html);
          if (issues.length === 0) continue;
          items.push(groupIssues(target, issues));
          for (const issue of issues) {
            const definition = ISSUE_DEFINITIONS[issue.type];
            flat.push({
              type: issue.type,
              severity: definition.severity,
              wcag_criterion: definition.wcag_criterion,
              content_type: target.content_type,
            });
          }
        }

        const issueTypes: Partial<Record<IssueType, IssueDefinition>> = {};
        for (const issue of flat) issueTypes[issue.type] = ISSUE_DEFINITIONS[issue.type];
        const autoFixable = flat.filter((issue) => ISSUE_DEFINITIONS[issue.type].auto_fixable).length;
        const fixable = [...new Set(flat.flatMap((issue) => ISSUE_DEFINITIONS[issue.type].fix_type ?? []))];

        const payload: Record<string, unknown> = {
          ...courseFields(canvas, courseId),
          scanned_types: types,
          items_scanned: scannedCounts,
          summary: { ...summarizeViolations(flat), auto_fixable: autoFixable },
          issue_types: issueTypes,
          items,
          not_checked: NOT_CHECKED,
        };
        if (fixable.length > 0) {
          payload.fix_hint = `fix_accessibility_issues can preview and apply: ${fixable.join(", ")} (fix_types).`;
        }
        if (warnings.length > 0) payload.warnings = warnings;

        return jsonResult(payload, {
          summary:
            `Scanned ${targets.length} item(s) in ${courseLabel(canvas, courseId)}: ` +
            `${flat.length} issue(s) in ${items.length} item(s), ${autoFixable} auto-fixable.`,
        });
      });
    },
  );

  server.registerTool(
    "fetch_ufixit_report",
    {
      description:
        "Fetch the UFIXIT/UDOIT accessibility report page from a course (institutional add-on; many courses have none — then use scan_course_content_accessibility). " +
        "Returns the report page's metadata and HTML body as JSON; pass that JSON to parse_ufixit_violations.",
      inputSchema: FETCH_UFIXIT_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const args = input as { course_identifier: string | number; page_title?: string };
      return safeHandler("fetch_ufixit_report", async () => {
        const title = args.page_title?.trim() || "UFIXIT";
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items } = await canvas.getPaginated<CanvasPage>(`/api/v1/courses/${courseId}/pages`, {
          params: { search_term: title },
        });
        const wanted = title.toLowerCase();
        const match =
          items.find((page) => (page.title ?? "").trim().toLowerCase() === wanted) ??
          items.find((page) => (page.title ?? "").toLowerCase().includes(wanted)) ??
          items[0];
        if (!match) {
          throw new CanvasApiError({
            code: "NOT_FOUND",
            message:
              `No page titled "${title}" (or containing it) in course ${courseLabel(canvas, courseId)}, so this course has no UFIXIT report to read. ` +
              "UFIXIT/UDOIT is an institutional add-on that publishes its report as a course page. " +
              "Run scan_course_content_accessibility for the built-in scan, or pass page_title if the report page has another name.",
          });
        }
        if (!match.url) {
          throw new CanvasApiError({
            code: "UNKNOWN",
            message: `Found page "${match.title ?? title}" but Canvas returned no url slug for it.`,
          });
        }
        const page = await canvas.get<CanvasPage>(pagePath(courseId, match.url));
        const body = page.body ?? "";
        return jsonResult(
          {
            ...courseFields(canvas, courseId),
            page_title: page.title ?? match.title ?? title,
            page_url: page.url ?? match.url,
            page_id: page.page_id ?? match.page_id ?? null,
            updated_at: page.updated_at ?? null,
            body,
          },
          {
            summary:
              `UFIXIT report page "${page.title ?? match.title}" (${match.url}) in ${courseLabel(canvas, courseId)}, ` +
              `${body.length} characters of HTML. Pass this JSON to parse_ufixit_violations.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "parse_ufixit_violations",
    {
      description:
        "Extract structured accessibility violations (WCAG criterion, type, severity, location) from fetch_ufixit_report output. " +
        "No Canvas calls. Pass the result to format_accessibility_summary for a readable report.",
      inputSchema: PARSE_UFIXIT_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const args = input as { report_json: string };
      return safeHandler("parse_ufixit_violations", async () => {
        const report = parseJsonArgument(args.report_json, "report_json", "fetch_ufixit_report", true);
        rethrowUpstreamError(report);
        const body = typeof report.body === "string" ? report.body : "";
        if (!body.trim()) {
          throw validationError("Report body is empty: the UFIXIT page has no content to parse.");
        }
        const violations = extractUfixitViolations(body);
        return jsonResult(
          {
            summary: summarizeViolations(violations),
            violations,
            report_metadata: {
              page_title: report.page_title ?? null,
              updated_at: report.updated_at ?? null,
              course_id: report.course_id ?? null,
            },
          },
          {
            summary: `Parsed ${violations.length} violation(s) from the UFIXIT report. Pass this JSON to format_accessibility_summary for a readable report.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "format_accessibility_summary",
    {
      description:
        "Format parse_ufixit_violations output as a Markdown report: totals by severity and WCAG criterion, then the first 20 violations in detail. No Canvas calls.",
      inputSchema: FORMAT_SUMMARY_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const args = input as { violations_json: string };
      return safeHandler("format_accessibility_summary", async () => {
        const data = parseJsonArgument(args.violations_json, "violations_json", "parse_ufixit_violations", false);
        rethrowUpstreamError(data);
        return textResult(formatAccessibilitySummary(data));
      });
    },
  );

  server.registerTool(
    "fix_accessibility_issues",
    {
      description:
        "Apply safe, mechanical accessibility fixes to course pages (and optionally assignment descriptions): th scope, white-on-#ff5f05 contrast, " +
        "legacy DesignPLUS kl_ classes, redundant 'image of' alt prefixes. Only the body/description is rewritten; published state and every other field stay unchanged. " +
        "TWO-STEP: the first call (no confirmation_token) writes nothing and returns a per-item preview of each change with before/after samples; " +
        "after the teacher approves, call again with identical arguments plus the token. The token is void if any affected content changes in Canvas in between. " +
        "Run scan_course_content_accessibility first to see what is fixable.",
      inputSchema: FIX_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const args = input as {
        course_identifier: string | number;
        fix_types?: string;
        content_types?: string;
        dry_run?: boolean;
        confirmation_token?: string;
      };
      return safeHandler("fix_accessibility_issues", async () => {
        const tool = "fix_accessibility_issues";
        const fixTypes = parseFixTypes(args.fix_types);
        const contentTypes = splitList(args.content_types, "pages");
        const unknownContent = contentTypes.filter((type) => !(FIX_CONTENT_TYPES as readonly string[]).includes(type));
        if (contentTypes.length === 0 || unknownContent.length > 0) {
          throw validationError(
            `Unsupported content_types: ${unknownContent.join(", ") || "(none given)"}. Use any of: ${FIX_CONTENT_TYPES.join(", ")}. Nothing was written.`,
          );
        }
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const label = courseLabel(canvas, courseId);

        const warnings: string[] = [];
        const targets: ContentTarget[] = [];
        if (contentTypes.includes("pages")) {
          const { pages, truncated } = await fetchPagesWithBodies(canvas, courseId);
          if (truncated) warnings.push(truncationWarning("pages"));
          targets.push(...pageTargets(pages));
        }
        if (contentTypes.includes("assignments")) {
          const { items, truncated } = await canvas.getPaginated<CanvasAssignment>(
            `/api/v1/courses/${courseId}/assignments`,
          );
          if (truncated) warnings.push(truncationWarning("assignments"));
          targets.push(...assignmentTargets(items));
        }

        const planned: PlannedItem[] = targets
          .filter((target) => target.html)
          .map((target) => ({ target, plan: planFixes(target.html, fixTypes) }))
          .filter(({ target, plan }) => plan.changes.length > 0 && plan.html !== target.html);

        const base: Record<string, unknown> = {
          ...courseFields(canvas, courseId),
          fix_types: [...fixTypes],
          content_types: contentTypes,
          items_scanned: targets.length,
          items_with_fixes: planned.length,
        };
        if (warnings.length > 0) base.warnings = warnings;

        if (planned.length === 0) {
          return jsonResult(
            { ...base, results: [] },
            { summary: `No auto-fixable issues in ${targets.length} item(s) in ${label}; nothing to change and nothing was written.` },
          );
        }

        const { confirmation_token: token, dry_run: dryRun, ...stableArgs } = args;
        // dry_run stays out of the binding so a dry_run preview's token works on the confirming call.
        const boundArgs = { ...stableArgs, resolved_course_id: courseId, plan_fingerprint: planFingerprint(planned) };

        if (!token || dryRun === true) {
          return previewResult(
            tool,
            boundArgs,
            {
              ...base,
              changes: planned.map(({ target, plan }) => ({
                ...itemReference(target),
                published: target.published ?? null,
                changes: plan.changes,
                examples: plan.examples,
              })),
              unchanged:
                "Only the page body (assignment description) is rewritten. Published state, title and every other setting stay as they are.",
            },
            `Would update ${planned.length} of ${targets.length} item(s) in ${label}.` +
              (dryRun === true && token ? " dry_run: true was passed, so the token was not used." : ""),
          );
        }

        const consumed = consumeConfirmationToken(tool, boundArgs, token);
        if (!consumed.ok) {
          throw validationError(
            `${consumed.reason} Content edited in Canvas since the preview also voids the token. Nothing was written.`,
          );
        }

        const results: Array<Record<string, unknown>> = [];
        for (const { target, plan } of planned) {
          const reference = { ...itemReference(target), changes: plan.changes };
          try {
            const path =
              target.content_type === "page"
                ? pagePath(courseId, target.page_url!)
                : assignmentPath(courseId, target.content_id!);
            const response =
              target.content_type === "page"
                ? await canvas.put<CanvasPage>(path, { wiki_page: { body: plan.html } })
                : await canvas.put<CanvasAssignment>(path, { assignment: { description: plan.html } });
            let stored = storedHtml(target, response);
            if (typeof stored !== "string") stored = storedHtml(target, await canvas.get<unknown>(path));
            const verified = typeof stored === "string" && normalizeHtml(stored) === normalizeHtml(plan.html);
            results.push({
              ...reference,
              applied: true,
              verified,
              ...(verified
                ? {}
                : { warning: "Canvas accepted the update but returned different HTML (it may have sanitized the markup). Re-scan to confirm." }),
            });
          } catch (error) {
            results.push({ ...reference, applied: false, error: describeError(error) });
          }
        }

        const applied = results.filter((result) => result.applied).length;
        const failed = results.length - applied;
        const payload: Record<string, unknown> = { ...base, applied, failed, results };
        if (failed > 0) payload.error = "Some items could not be updated. Review the results before retrying.";
        return jsonResult(payload, {
          summary:
            `Applied accessibility fixes to ${applied} of ${planned.length} item(s) in ${label}` +
            (failed > 0 ? `; ${failed} failed.` : ".") +
            " Published state was not changed.",
        });
      });
    },
  );
}

function parseFixTypes(value: string | undefined): Set<FixType> {
  const requested = splitList(value, DEFAULT_FIX_TYPES);
  const unknown = requested.filter((type) => !(FIX_TYPES as readonly string[]).includes(type));
  if (requested.length === 0 || unknown.length > 0) {
    throw validationError(
      `Unknown fix_types: ${unknown.join(", ") || "(none given)"}. Valid: ${FIX_TYPES.join(", ")}. Nothing was written.`,
    );
  }
  return new Set(requested as FixType[]);
}

/**
 * Accept the previous tool's output as given. Models often paste the whole
 * result (summary line + JSON), so fall back to the outermost {...} span; a
 * raw HTML report body is accepted where the caller allows it.
 */
function parseJsonArgument(
  text: string,
  param: string,
  source: string,
  allowHtml: boolean,
): Record<string, unknown> {
  const candidates = [text];
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  if (allowHtml && /<[a-z!]/i.test(text)) return { body: text };
  throw validationError(`Invalid JSON input: ${param} must be the JSON returned by ${source}.`);
}

function describeError(error: unknown): string {
  if (error instanceof CanvasApiError && error.canvasMessage) return `${error.message} — ${error.canvasMessage}`;
  return error instanceof Error ? error.message : String(error);
}

function rethrowUpstreamError(data: Record<string, unknown>): void {
  if (data.error === undefined || data.error === null || data.error === false) return;
  const message = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
  const suggestion = typeof data.suggestion === "string" ? ` (${data.suggestion})` : "";
  throw validationError(`Upstream error: ${message}${suggestion}`);
}
