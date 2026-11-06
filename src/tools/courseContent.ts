import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { CanvasApiError } from "../types.js";
import {
  CONFIRMATION_TOKEN_PARAM,
  consumeConfirmationToken,
  previewResult,
} from "./confirmGate.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";

/**
 * Course content read tools (structure, module items, overview, syllabus,
 * front page, files) plus the page-settings and syllabus writes.
 *
 * No-auto-publish: update_page_settings and bulk_update_pages refuse
 * published=true outright, and both confirm a page exists before PUTting to
 * it, because Canvas upserts on PUT /pages/:url — a typo'd slug would
 * otherwise create a brand-new (possibly published) page.
 */

const COURSE_IDENTIFIER = z
  .union([z.string(), z.number()])
  .describe("Canvas course code or numeric id.");

const PREVIEW_CHARS = 300;
const OVERVIEW_SYLLABUS_CHARS = 1000;
const OVERVIEW_RECENT_PAGES = 5;
// Canvas omits inline module items when a module is large; these get fetched
// one module at a time, so the overview caps how many it will chase.
const OVERVIEW_ITEM_FETCH_LIMIT = 10;

const PUBLISH_REFUSAL =
  "This server never publishes content (no-auto-publish rule). Publish the page(s) in Canvas after the teacher reviews them. Nothing was changed.";

const NOTIFY_WARNING =
  "notify_of_update is a save-time action that Canvas never echoes back, so delivery cannot be confirmed; Canvas sends nothing for unpublished pages or pages under a minute old.";

const GET_COURSE_STRUCTURE_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  include_unpublished: z
    .boolean()
    .optional()
    .describe("Include unpublished modules and items (default true)."),
};

const LIST_MODULE_ITEMS_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  module_id: z.union([z.string(), z.number()]).describe("Numeric module id."),
  include_content_details: z
    .boolean()
    .optional()
    .describe("Include due_at / points_possible / lock dates from Canvas content_details (default true)."),
};

const GET_COURSE_CONTENT_OVERVIEW_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  include_pages: z.boolean().optional().describe("Include the pages summary (default true)."),
  include_modules: z.boolean().optional().describe("Include the modules summary (default true)."),
  include_syllabus: z.boolean().optional().describe("Include a syllabus preview (default true)."),
};

const GET_SYLLABUS_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  output_format: z
    .enum(["text", "html", "both"])
    .optional()
    .describe("'text' (plain text, default), 'html' (raw body), or 'both'."),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional cap on characters returned per format; a cut is flagged with truncated=true."),
};

const UPDATE_SYLLABUS_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  syllabus_body: z.string().describe("Syllabus HTML. To clear deliberately, pass '<p></p>'."),
  mode: z
    .enum(["replace", "append", "prepend"])
    .optional()
    .describe("'replace' (default) swaps the whole body; 'append'/'prepend' add to the existing body."),
  confirmation_token: CONFIRMATION_TOKEN_PARAM,
};

const GET_FRONT_PAGE_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
};

const UPDATE_PAGE_SETTINGS_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  page_url_or_id: z.string().describe("Page URL slug (the part after /pages/) or numeric page id."),
  published: z
    .boolean()
    .optional()
    .describe("false to unpublish. true is refused: this server never publishes — the teacher publishes in Canvas."),
  front_page: z
    .boolean()
    .optional()
    .describe("true to make this the course front page (Canvas requires the page to already be published)."),
  editing_roles: z
    .string()
    .optional()
    .describe("Canvas editing_roles: teachers, students, members, or public (comma-combinations allowed)."),
  notify_of_update: z
    .boolean()
    .optional()
    .describe("Ask Canvas to notify participants about this edit. Save-time only; Canvas never confirms delivery."),
};

const BULK_UPDATE_PAGES_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  page_urls: z
    .union([z.string(), z.array(z.string())])
    .describe("Page URL slugs: a comma-separated string or an array."),
  published: z
    .boolean()
    .optional()
    .describe("false to unpublish all. true is refused: this server never publishes — the teacher publishes in Canvas."),
  editing_roles: z
    .string()
    .optional()
    .describe("Canvas editing_roles: teachers, students, members, or public."),
  notify_of_update: z
    .boolean()
    .optional()
    .describe("Ask Canvas to notify participants about these edits. Save-time only; Canvas never confirms delivery."),
  confirmation_token: CONFIRMATION_TOKEN_PARAM,
};

const FILE_SORT_FIELDS = ["name", "size", "created_at", "updated_at", "content_type"] as const;

const LIST_COURSE_FILES_INPUT = {
  course_identifier: COURSE_IDENTIFIER,
  search_term: z.string().optional().describe("Filter files by (partial) name."),
  sort: z.enum(FILE_SORT_FIELDS).optional().describe("Sort field (default updated_at)."),
  order: z.enum(["asc", "desc"]).optional().describe("Sort order (default desc)."),
};

interface CanvasContentDetails {
  due_at?: string | null;
  points_possible?: number | null;
  lock_at?: string | null;
  unlock_at?: string | null;
}

interface CanvasModuleItemFull {
  id: number;
  title?: string;
  type?: string;
  position?: number;
  indent?: number;
  published?: boolean;
  content_id?: number | null;
  page_url?: string | null;
  external_url?: string | null;
  content_details?: CanvasContentDetails;
}

interface CanvasModuleFull {
  id: number;
  name?: string;
  position?: number;
  published?: boolean;
  unlock_at?: string | null;
  require_sequential_progress?: boolean;
  prerequisite_module_ids?: number[];
  items_count?: number;
  items?: CanvasModuleItemFull[];
}

interface CanvasCourseWithSyllabus {
  id: number;
  name?: string;
  course_code?: string;
  syllabus_body?: string | null;
}

interface CanvasPageMeta {
  page_id?: number;
  url: string;
  title?: string;
  published?: boolean;
  front_page?: boolean;
  editing_roles?: string;
  updated_at?: string;
  body?: string | null;
}

interface CanvasFile {
  id: number;
  display_name?: string;
  filename?: string;
  size?: number;
  "content-type"?: string;
  updated_at?: string;
  folder_id?: number;
  locked?: boolean;
  hidden?: boolean;
}

type CourseContentArgs<T extends z.ZodRawShape> = z.infer<z.ZodObject<T>>;

function courseRef(canvas: CanvasClient, courseId: number, code?: string | null): Record<string, unknown> {
  const courseCode = code ?? canvas.getCachedCourseCode(courseId);
  return courseCode ? { course_code: courseCode, course_id: courseId } : { course_id: courseId };
}

function courseLabel(canvas: CanvasClient, courseId: number, code?: string | null): string {
  return code ?? canvas.getCachedCourseCode(courseId) ?? String(courseId);
}

function numericIdOrThrow(value: string | number, field: string): string {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${field} must be a numeric Canvas id (got "${value}").`);
  }
  return raw;
}

function pageSlugError(slug: string, field: string): string | null {
  const trimmed = slug.trim();
  if (!trimmed) return `${field}: page slug is empty.`;
  if (trimmed === "." || trimmed === ".." || /[/\\?#]/.test(trimmed)) {
    return `${field}: "${slug}" is not a page URL slug or id — pass the part after /pages/ (no slashes, '?' or '#').`;
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof CanvasApiError) {
    return error.canvasMessage ? `${error.message} — ${error.canvasMessage}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof CanvasApiError && error.code === "NOT_FOUND";
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  // Digit runs are length-capped so a pathological entity can't produce a
  // huge number; out-of-range code points are left as written.
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = hex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Readable plain text from Canvas HTML, for previews and read-back comparison only. */
export function htmlToText(html: string): string {
  const withoutHidden = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const withBreaks = withoutHidden
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|table|blockquote|pre|section)\s*>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]*>/g, "");
  return decodeEntities(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function formatFileSize(bytes: number | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function parsePageUrls(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : raw.split(",");
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const part of parts) {
    const trimmed = String(part).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
  }
  return urls;
}

/**
 * Canvas only returns `published` on modules/items when the caller may see
 * unpublished content; when it is absent, everything visible is published.
 */
function isPublished(value: boolean | undefined): boolean {
  return value ?? true;
}

function displayItem(item: CanvasModuleItemFull): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    type: item.type ?? "Unknown",
    title: item.title ?? "Untitled",
    published: isPublished(item.published),
  };
  if (item.position !== undefined) out.position = item.position;
  if (item.indent) out.indent = item.indent;
  if (item.content_id !== undefined && item.content_id !== null) out.content_id = item.content_id;
  if (item.page_url) out.page_url = item.page_url;
  if (item.external_url) out.external_url = item.external_url;
  const details = item.content_details;
  if (details?.due_at) out.due_at = details.due_at;
  if (details?.points_possible !== undefined && details.points_possible !== null) {
    out.points_possible = details.points_possible;
  }
  if (details?.unlock_at) out.unlock_at = details.unlock_at;
  if (details?.lock_at) out.lock_at = details.lock_at;
  return out;
}

async function fetchModuleItems(
  canvas: CanvasClient,
  courseId: number,
  moduleId: string | number,
  includeContentDetails: boolean,
): Promise<{ items: CanvasModuleItemFull[]; truncated: boolean }> {
  const params: Record<string, unknown> = {};
  if (includeContentDetails) params["include[]"] = ["content_details"];
  const { items, truncated } = await canvas.getPaginated<CanvasModuleItemFull>(
    `/api/v1/courses/${courseId}/modules/${moduleId}/items`,
    { params },
  );
  return { items, truncated };
}

/** Canvas omits inline `items` for large modules even when include[]=items was sent. */
function needsSeparateItemFetch(module: CanvasModuleFull): boolean {
  return !Array.isArray(module.items) && (module.items_count ?? 0) > 0;
}

export function registerCourseContentTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    "get_course_structure",
    {
      description:
        "Full module → item tree for a course in one call: publish state, item types, due dates and points, plus summary counts (unpublished modules/items, empty modules, published items hidden inside unpublished modules). The backbone of a course QC pass.",
      inputSchema: GET_COURSE_STRUCTURE_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof GET_COURSE_STRUCTURE_INPUT>;
      return safeHandler("get_course_structure", async () => {
        const includeUnpublished = args.include_unpublished ?? true;
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items: modules, truncated } = await canvas.getPaginated<CanvasModuleFull>(
          `/api/v1/courses/${courseId}/modules`,
          { params: { "include[]": ["items", "content_details"] } },
        );

        const warnings: string[] = [];
        const structured: Array<Record<string, unknown>> = [];
        const itemTypes: Record<string, number> = {};
        let totalItems = 0;
        let unpublishedModules = 0;
        let unpublishedItems = 0;
        let emptyModules = 0;
        let hiddenPublishedItems = 0;

        for (const module of modules) {
          const modulePublished = isPublished(module.published);
          if (!includeUnpublished && !modulePublished) continue;
          if (!modulePublished) unpublishedModules += 1;

          let rawItems: CanvasModuleItemFull[] | null = module.items ?? [];
          if (needsSeparateItemFetch(module)) {
            try {
              const fetched = await fetchModuleItems(canvas, courseId, module.id, true);
              rawItems = fetched.items;
              if (fetched.truncated) warnings.push(`Module ${module.id}: item list truncated by pagination limit.`);
            } catch (error) {
              rawItems = null;
              warnings.push(`Module ${module.id}: items could not be read (${describeError(error)}).`);
            }
          }

          const items: Array<Record<string, unknown>> = [];
          for (const item of rawItems ?? []) {
            const itemPublished = isPublished(item.published);
            if (!includeUnpublished && !itemPublished) continue;
            if (!itemPublished) unpublishedItems += 1;
            if (itemPublished && !modulePublished) hiddenPublishedItems += 1;
            const type = item.type ?? "Unknown";
            itemTypes[type] = (itemTypes[type] ?? 0) + 1;
            totalItems += 1;
            items.push(displayItem(item));
          }
          if (rawItems !== null && items.length === 0) emptyModules += 1;

          const entry: Record<string, unknown> = {
            id: module.id,
            name: module.name ?? "Unnamed",
            position: module.position ?? null,
            published: modulePublished,
          };
          if (module.unlock_at) entry.unlock_at = module.unlock_at;
          if (module.require_sequential_progress) entry.require_sequential_progress = true;
          if (module.prerequisite_module_ids && module.prerequisite_module_ids.length > 0) {
            entry.prerequisite_module_ids = module.prerequisite_module_ids;
          }
          if (rawItems === null) entry.items_unavailable = true;
          entry.items_count = items.length;
          entry.items = items;
          structured.push(entry);
        }

        const summary = {
          total_modules: structured.length,
          total_items: totalItems,
          unpublished_modules: unpublishedModules,
          unpublished_items: unpublishedItems,
          empty_modules: emptyModules,
          published_items_in_unpublished_modules: hiddenPublishedItems,
          item_types: itemTypes,
        };
        const payload: Record<string, unknown> = {
          ...courseRef(canvas, courseId),
          summary,
          modules: structured,
        };
        if (truncated) payload.truncated = true;
        if (warnings.length > 0) payload.warnings = warnings;

        return jsonResult(payload, {
          summary:
            `${courseLabel(canvas, courseId)}: ${summary.total_modules} module(s), ${totalItems} item(s); ` +
            `${unpublishedModules} unpublished module(s), ${unpublishedItems} unpublished item(s), ` +
            `${emptyModules} empty module(s), ${hiddenPublishedItems} published item(s) inside unpublished modules.`,
        });
      });
    },
  );

  server.registerTool(
    "list_module_items",
    {
      description:
        "List the items in one module (type, publish state, content id / page slug / external URL, and — with content details — due date and points).",
      inputSchema: LIST_MODULE_ITEMS_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof LIST_MODULE_ITEMS_INPUT>;
      return safeHandler("list_module_items", async () => {
        const moduleId = numericIdOrThrow(args.module_id, "module_id");
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { items, truncated } = await fetchModuleItems(
          canvas,
          courseId,
          moduleId,
          args.include_content_details ?? true,
        );

        let moduleName: string | null = null;
        try {
          const module = await canvas.get<CanvasModuleFull>(`/api/v1/courses/${courseId}/modules/${moduleId}`);
          moduleName = module.name ?? null;
        } catch {
          // The item list is the answer; a missing module name only costs a label.
        }

        const payload: Record<string, unknown> = {
          ...courseRef(canvas, courseId),
          module_id: Number(moduleId),
          module_name: moduleName,
          count: items.length,
          items: items.map(displayItem),
        };
        if (truncated) payload.truncated = true;
        return jsonResult(payload, {
          summary: `${courseLabel(canvas, courseId)}, module ${moduleName ? `"${moduleName}"` : moduleId}: ${items.length} item(s).`,
        });
      });
    },
  );

  server.registerTool(
    "get_course_content_overview",
    {
      description:
        "One-call overview of a course's content: page counts (published/unpublished, front page, recently updated), module counts with item types, and a 1000-character syllabus preview. Use get_course_structure for the full module tree and get_syllabus for the full syllabus.",
      inputSchema: GET_COURSE_CONTENT_OVERVIEW_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof GET_COURSE_CONTENT_OVERVIEW_INPUT>;
      return safeHandler("get_course_content_overview", async () => {
        const includePages = args.include_pages ?? true;
        const includeModules = args.include_modules ?? true;
        const includeSyllabus = args.include_syllabus ?? true;
        const courseId = await canvas.resolveCourseId(args.course_identifier);

        const course = await canvas.get<CanvasCourseWithSyllabus>(`/api/v1/courses/${courseId}`, {
          params: includeSyllabus ? { "include[]": ["syllabus_body"] } : {},
        });
        canvas.seedCourseCodes([course]);

        const payload: Record<string, unknown> = {
          ...courseRef(canvas, courseId, course.course_code),
          course_name: course.name ?? null,
        };
        const summaryParts: string[] = [];

        if (includePages) {
          try {
            const { items: pages, truncated } = await canvas.getPaginated<CanvasPageMeta>(
              `/api/v1/courses/${courseId}/pages`,
            );
            const published = pages.filter((page) => page.published === true);
            const front = pages.find((page) => page.front_page === true);
            const recent = [...published]
              .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
              .slice(0, OVERVIEW_RECENT_PAGES)
              .map((page) => ({ title: page.title ?? page.url, url: page.url, updated_at: page.updated_at ?? null }));
            const section: Record<string, unknown> = {
              total: pages.length,
              published: published.length,
              unpublished: pages.length - published.length,
              front_page: front ? { title: front.title ?? front.url, url: front.url } : null,
              recent_published: recent,
            };
            if (truncated) section.truncated = true;
            payload.pages = section;
            summaryParts.push(`${pages.length} page(s) (${published.length} published)`);
          } catch (error) {
            payload.pages = { error: describeError(error) };
          }
        }

        if (includeModules) {
          try {
            const { items: modules, truncated } = await canvas.getPaginated<CanvasModuleFull>(
              `/api/v1/courses/${courseId}/modules`,
              { params: { "include[]": ["items"] } },
            );
            const itemTypes: Record<string, number> = {};
            let totalItems = 0;
            let analyzed = 0;
            let separateFetches = 0;
            let skipped = 0;
            let failed = 0;
            for (const module of modules) {
              let items: CanvasModuleItemFull[] | undefined = module.items ?? [];
              if (needsSeparateItemFetch(module)) {
                if (separateFetches >= OVERVIEW_ITEM_FETCH_LIMIT) {
                  skipped += 1;
                  continue;
                }
                separateFetches += 1;
                try {
                  items = (await fetchModuleItems(canvas, courseId, module.id, false)).items;
                } catch {
                  failed += 1;
                  continue;
                }
              }
              analyzed += 1;
              for (const item of items) {
                const type = item.type ?? "Unknown";
                itemTypes[type] = (itemTypes[type] ?? 0) + 1;
                totalItems += 1;
              }
            }
            const publishedModules = modules.filter((module) => isPublished(module.published)).length;
            const section: Record<string, unknown> = {
              total: modules.length,
              published: publishedModules,
              unpublished: modules.length - publishedModules,
              modules_analyzed_for_items: analyzed,
              total_items: totalItems,
              item_types: itemTypes,
            };
            if (skipped > 0 || failed > 0) {
              section.note =
                `Item counts exclude ${skipped + failed} module(s)` +
                (failed > 0 ? ` (${failed} could not be read)` : "") +
                "; use get_course_structure or list_module_items for those.";
            }
            if (truncated) section.truncated = true;
            payload.modules = section;
            summaryParts.push(`${modules.length} module(s), ${totalItems} item(s) counted`);
          } catch (error) {
            payload.modules = { error: describeError(error) };
          }
        }

        if (includeSyllabus) {
          const body = course.syllabus_body ?? "";
          if (body.trim()) {
            const preview = clip(htmlToText(body), OVERVIEW_SYLLABUS_CHARS);
            payload.syllabus = {
              has_content: true,
              length: body.length,
              preview: preview.text,
              preview_truncated: preview.truncated,
            };
            summaryParts.push("syllabus present");
          } else {
            payload.syllabus = { has_content: false };
            summaryParts.push("no syllabus content");
          }
        }

        return jsonResult(payload, {
          summary: `Content overview for ${courseLabel(canvas, courseId, course.course_code)}: ${summaryParts.join("; ") || "nothing requested"}.`,
        });
      });
    },
  );

  server.registerTool(
    "get_syllabus",
    {
      description:
        "Get the complete Canvas Syllabus tab content for a course (unlike get_course_content_overview's 1000-character preview). output_format: 'text' (default), 'html', or 'both'. Only cut when max_chars is passed, and a cut is flagged.",
      inputSchema: GET_SYLLABUS_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof GET_SYLLABUS_INPUT>;
      return safeHandler("get_syllabus", async () => {
        const format = args.output_format ?? "text";
        if (!["text", "html", "both"].includes(format)) {
          throw new Error(`invalid output_format "${format}". Use 'text', 'html', or 'both'.`);
        }
        if (args.max_chars !== undefined && !(args.max_chars > 0)) {
          throw new Error("max_chars must be a positive integer (or omitted for no limit).");
        }
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const course = await canvas.get<CanvasCourseWithSyllabus>(`/api/v1/courses/${courseId}`, {
          params: { "include[]": ["syllabus_body"] },
        });
        canvas.seedCourseCodes([course]);
        const label = courseLabel(canvas, courseId, course.course_code);
        const body = course.syllabus_body ?? "";
        const ref = courseRef(canvas, courseId, course.course_code);

        if (!body.trim()) {
          return jsonResult({ ...ref, has_content: false }, { summary: `No syllabus content found for ${label}.` });
        }

        const limit = args.max_chars ?? Number.POSITIVE_INFINITY;
        const payload: Record<string, unknown> = { ...ref, has_content: true, length: body.length };
        let truncated = false;
        if (format === "text" || format === "both") {
          const text = clip(htmlToText(body), limit);
          payload.text = text.text;
          truncated ||= text.truncated;
        }
        if (format === "html" || format === "both") {
          const html = clip(body, limit);
          payload.html = html.text;
          truncated ||= html.truncated;
        }
        if (truncated) payload.truncated_at = args.max_chars;
        return jsonResult(payload, {
          summary: `Syllabus for ${label} (${body.length} characters of HTML${truncated ? `, cut at ${args.max_chars}` : ""}).`,
        });
      });
    },
  );

  server.registerTool(
    "update_syllabus",
    {
      description:
        "Set the Canvas Syllabus tab body. mode 'replace' (default) swaps the whole body; 'append'/'prepend' add to it. Canvas keeps NO revision history for the syllabus, so this is two-step: the first call (no confirmation_token) returns a preview of old vs new and a token, and writes nothing; after the teacher approves, call again with identical arguments plus the token. The token is void if the arguments or the current syllabus change. Bypasses the course-code cache.",
      inputSchema: UPDATE_SYLLABUS_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof UPDATE_SYLLABUS_INPUT>;
      return safeHandler("update_syllabus", async () => {
        const mode = args.mode ?? "replace";
        if (!["replace", "append", "prepend"].includes(mode)) {
          throw new Error(`invalid mode "${mode}". Use 'replace', 'append', or 'prepend'.`);
        }
        if (typeof args.syllabus_body !== "string" || !args.syllabus_body.trim()) {
          throw new Error(
            mode === "replace"
              ? "syllabus_body is empty. To clear a syllabus deliberately, pass a body such as '<p></p>'. Nothing was changed."
              : `syllabus_body is empty, so there is nothing to ${mode}. Nothing was changed.`,
          );
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const current = await canvas.get<CanvasCourseWithSyllabus>(`/api/v1/courses/${courseId}`, {
          params: { "include[]": ["syllabus_body"] },
        });
        canvas.seedCourseCodes([current]);
        const label = courseLabel(canvas, courseId, current.course_code);
        const ref = courseRef(canvas, courseId, current.course_code);
        const existing = current.syllabus_body ?? "";
        const hasExisting = existing.trim().length > 0;
        const newBody =
          mode === "append" && hasExisting
            ? `${existing}\n${args.syllabus_body}`
            : mode === "prepend" && hasExisting
              ? `${args.syllabus_body}\n${existing}`
              : args.syllabus_body;

        // The current body is bound into the token so a co-teacher's edit
        // between preview and confirm voids it — the teacher approved
        // overwriting the content they saw, not whatever is there now.
        const gateArgs: Record<string, unknown> = {
          ...args,
          mode,
          resolved_course_id: courseId,
          current_body_sha256: sha256(existing),
        };

        if (!args.confirmation_token) {
          const currentPreview = clip(htmlToText(existing), PREVIEW_CHARS);
          const newPreview = clip(htmlToText(newBody), PREVIEW_CHARS);
          const preview: Record<string, unknown> = {
            ...ref,
            mode,
            current_length: existing.length,
            new_length: newBody.length,
            current_preview: currentPreview.text + (currentPreview.truncated ? "…" : ""),
            new_preview: newPreview.text + (newPreview.truncated ? "…" : ""),
          };
          if (mode !== "replace") {
            const added = clip(htmlToText(args.syllabus_body), PREVIEW_CHARS);
            preview.added_preview = added.text + (added.truncated ? "…" : "");
          }
          if (mode === "replace" && hasExisting) {
            preview.warning = "Canvas keeps no revision history for the syllabus; the current content cannot be recovered after this replace.";
          }
          return previewResult(
            "update_syllabus",
            gateArgs,
            preview,
            `Would ${mode} the syllabus of ${label}: ${existing.length} → ${newBody.length} characters.`,
          );
        }

        const redeemed = consumeConfirmationToken("update_syllabus", gateArgs, args.confirmation_token);
        if (!redeemed.ok) {
          throw new Error(
            `${redeemed.reason} (The token is also void if the syllabus itself changed since the preview.) Nothing was changed.`,
          );
        }

        await canvas.put(`/api/v1/courses/${courseId}`, { course: { syllabus_body: newBody } });

        // Canvas answers 200 on this PUT without echoing syllabus_body, and
        // silently drops the field for a token lacking manage_course_content —
        // so read it back instead of trusting the status code. Compare visible
        // text: Canvas rewrites the HTML (theme injection, sanitizing).
        const warnings: string[] = [];
        let verified: boolean | null = null;
        let storedLength: number | null = null;
        try {
          const readBack = await canvas.get<CanvasCourseWithSyllabus>(`/api/v1/courses/${courseId}`, {
            params: { "include[]": ["syllabus_body"] },
          });
          const stored = readBack.syllabus_body ?? "";
          storedLength = stored.length;
          const sentText = collapseWhitespace(htmlToText(newBody));
          if (sentText) {
            verified = collapseWhitespace(htmlToText(stored)).includes(sentText);
            if (!verified) {
              warnings.push(
                "Canvas accepted the request but the stored syllabus does not contain the text sent — the token may lack permission to edit the syllabus. Check the Syllabus tab.",
              );
            }
          } else {
            warnings.push("Not verified: the body sent has no visible text to look for in the read-back. Check the Syllabus tab.");
          }
        } catch (error) {
          warnings.push(`Write accepted but the read-back failed (${describeError(error)}). Check the Syllabus tab.`);
        }

        const payload: Record<string, unknown> = {
          ...ref,
          mode,
          previous_length: existing.length,
          new_length: storedLength ?? newBody.length,
          verified,
        };
        if (warnings.length > 0) payload.warnings = warnings;
        const verb = mode === "replace" ? "Replaced" : mode === "append" ? "Appended to" : "Prepended to";
        return jsonResult(payload, {
          summary: `${verb} the syllabus of ${label}${verified === true ? " (verified by read-back)" : verified === false ? " — NOT confirmed, see warnings" : ""}.`,
        });
      });
    },
  );

  server.registerTool(
    "get_front_page",
    {
      description:
        "Get the course front page (title, slug, publish state, body HTML). Returns has_front_page=false when the course has none set.",
      inputSchema: GET_FRONT_PAGE_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof GET_FRONT_PAGE_INPUT>;
      return safeHandler("get_front_page", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const label = courseLabel(canvas, courseId);
        let page: CanvasPageMeta;
        try {
          page = await canvas.get<CanvasPageMeta>(`/api/v1/courses/${courseId}/front_page`);
        } catch (error) {
          if (isNotFound(error)) {
            return jsonResult(
              { ...courseRef(canvas, courseId), has_front_page: false },
              { summary: `${label} has no front page set.` },
            );
          }
          throw error;
        }
        return jsonResult(
          {
            ...courseRef(canvas, courseId),
            has_front_page: true,
            url: page.url,
            title: page.title ?? null,
            published: page.published ?? null,
            updated_at: page.updated_at ?? null,
            body: page.body ?? "",
          },
          { summary: `Front page of ${label}: "${page.title ?? page.url}"${page.body ? "" : " (empty body)"}.` },
        );
      });
    },
  );

  server.registerTool(
    "update_page_settings",
    {
      description:
        "Change an existing page's settings without touching its content: unpublish (published=false), front_page, editing_roles, notify_of_update. published=true is refused — this server never publishes; the teacher publishes in Canvas. The page must already exist (Canvas would otherwise create one). Bypasses the course-code cache.",
      inputSchema: UPDATE_PAGE_SETTINGS_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof UPDATE_PAGE_SETTINGS_INPUT>;
      return safeHandler("update_page_settings", async () => {
        const slugError = pageSlugError(args.page_url_or_id ?? "", "page_url_or_id");
        if (slugError) throw new Error(`${slugError} Nothing was changed.`);
        if (args.published === true) throw new Error(PUBLISH_REFUSAL);

        const settings: Record<string, unknown> = {};
        if (args.published === false) settings.published = false;
        if (args.front_page !== undefined) settings.front_page = args.front_page;
        if (args.editing_roles !== undefined) settings.editing_roles = args.editing_roles;
        if (args.notify_of_update !== undefined) settings.notify_of_update = args.notify_of_update;
        if (Object.keys(settings).length === 0) {
          throw new Error(
            "no changes specified. Pass at least one of published=false, front_page, editing_roles, notify_of_update.",
          );
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const pagePath = `/api/v1/courses/${courseId}/pages/${encodeURIComponent(args.page_url_or_id.trim())}`;

        let existing: CanvasPageMeta;
        try {
          existing = await canvas.get<CanvasPageMeta>(pagePath);
        } catch (error) {
          if (isNotFound(error)) {
            throw new Error(
              `page "${args.page_url_or_id}" was not found in course ${courseLabel(canvas, courseId)}. Nothing was changed (use list_pages for slugs).`,
            );
          }
          throw error;
        }
        if (args.front_page === true && existing.published === false) {
          throw new Error(
            `"${existing.title ?? existing.url}" is unpublished, and Canvas only allows a published page as the front page. Publish it in Canvas first. Nothing was changed.`,
          );
        }

        const updated = await canvas.put<CanvasPageMeta>(pagePath, { wiki_page: settings });
        const payload: Record<string, unknown> = {
          ...courseRef(canvas, courseId),
          changed: Object.keys(settings),
          page: {
            url: updated.url ?? existing.url,
            title: updated.title ?? existing.title ?? null,
            published: updated.published ?? null,
            front_page: updated.front_page ?? null,
            editing_roles: updated.editing_roles ?? null,
            updated_at: updated.updated_at ?? null,
          },
        };
        if (args.notify_of_update) payload.warnings = [NOTIFY_WARNING];
        return jsonResult(payload, {
          summary: `Updated settings of page "${updated.title ?? existing.title ?? existing.url}" in ${courseLabel(canvas, courseId)}: ${Object.keys(settings).join(", ")}.`,
        });
      });
    },
  );

  server.registerTool(
    "bulk_update_pages",
    {
      description:
        "Change settings on several existing pages at once: unpublish (published=false), editing_roles, notify_of_update. Settings only — no renames or content. published=true is refused (the teacher publishes in Canvas). Two-step: the first call (no confirmation_token) previews each page's current state and the change, writing nothing; after the teacher approves, call again with identical arguments plus the token. Slugs that don't match an existing page are skipped, never created. Bypasses the course-code cache.",
      inputSchema: BULK_UPDATE_PAGES_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof BULK_UPDATE_PAGES_INPUT>;
      return safeHandler("bulk_update_pages", async () => {
        if (args.published === true) throw new Error(PUBLISH_REFUSAL);
        const urls = parsePageUrls(args.page_urls ?? "");
        if (urls.length === 0) {
          throw new Error("no pages specified. Pass page_urls as a comma-separated string or an array of slugs.");
        }
        for (const url of urls) {
          const slugError = pageSlugError(url, "page_urls");
          if (slugError) throw new Error(`${slugError} No pages were updated.`);
        }

        const settings: Record<string, unknown> = {};
        if (args.published === false) settings.published = false;
        if (args.editing_roles !== undefined) settings.editing_roles = args.editing_roles;
        if (args.notify_of_update !== undefined) settings.notify_of_update = args.notify_of_update;
        if (Object.keys(settings).length === 0) {
          throw new Error("no changes specified. Pass at least one of published=false, editing_roles, notify_of_update.");
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const label = courseLabel(canvas, courseId);
        const gateArgs: Record<string, unknown> = { ...args, resolved_course_id: courseId };

        const lookupExisting = async (): Promise<{ found: Array<{ requested: string; page: CanvasPageMeta }>; missing: string[] }> => {
          const { items: pages } = await canvas.getPaginated<CanvasPageMeta>(`/api/v1/courses/${courseId}/pages`);
          const byKey = new Map<string, CanvasPageMeta>();
          for (const page of pages) {
            byKey.set(page.url, page);
            if (page.page_id !== undefined) byKey.set(String(page.page_id), page);
          }
          const found: Array<{ requested: string; page: CanvasPageMeta }> = [];
          const missing: string[] = [];
          for (const url of urls) {
            const page = byKey.get(url);
            if (page) found.push({ requested: url, page });
            else missing.push(url);
          }
          return { found, missing };
        };

        if (!args.confirmation_token) {
          const { found, missing } = await lookupExisting();
          const warnings: string[] = [];
          const pages = found.map(({ page }) => {
            const entry: Record<string, unknown> = {
              url: page.url,
              title: page.title ?? page.url,
              published: page.published ?? null,
              editing_roles: page.editing_roles ?? null,
            };
            if (settings.published === false && page.front_page) {
              entry.blocked = "front page cannot be unpublished";
              warnings.push(`"${page.title ?? page.url}" is the front page; Canvas will refuse to unpublish it.`);
            }
            return entry;
          });
          if (missing.length > 0) warnings.push(`${missing.length} slug(s) match no page and will be skipped.`);
          if (args.notify_of_update) warnings.push(NOTIFY_WARNING);
          const preview: Record<string, unknown> = {
            ...courseRef(canvas, courseId),
            changes: settings,
            page_count: found.length,
            pages,
          };
          if (missing.length > 0) preview.not_found = missing;
          if (warnings.length > 0) preview.warnings = warnings;
          return previewResult(
            "bulk_update_pages",
            gateArgs,
            preview,
            `Would set ${Object.entries(settings)
              .map(([key, value]) => `${key}=${String(value)}`)
              .join(", ")} on ${found.length} page(s) in ${label}${missing.length > 0 ? ` (${missing.length} not found, skipped)` : ""}.`,
          );
        }

        const redeemed = consumeConfirmationToken("bulk_update_pages", gateArgs, args.confirmation_token);
        if (!redeemed.ok) throw new Error(`${redeemed.reason} No pages were updated.`);

        const { found, missing } = await lookupExisting();
        const updated: Array<Record<string, unknown>> = [];
        const failures: Array<{ url: string; error: string }> = [];
        for (const { page } of found) {
          try {
            const result = await canvas.put<CanvasPageMeta>(
              `/api/v1/courses/${courseId}/pages/${encodeURIComponent(page.url)}`,
              { wiki_page: settings },
            );
            updated.push({
              url: result.url ?? page.url,
              title: result.title ?? page.title ?? page.url,
              published: result.published ?? null,
            });
          } catch (error) {
            failures.push({ url: page.url, error: describeError(error) });
          }
        }

        const payload: Record<string, unknown> = {
          ...courseRef(canvas, courseId),
          changes: settings,
          requested: urls.length,
          succeeded: updated.length,
          failed: failures.length,
          updated,
        };
        if (failures.length > 0) payload.failures = failures;
        if (missing.length > 0) payload.skipped_not_found = missing;
        if (args.notify_of_update && updated.length > 0) payload.warnings = [NOTIFY_WARNING];
        return jsonResult(payload, {
          summary:
            `Bulk page update in ${label}: ${updated.length} updated, ${failures.length} failed` +
            `${missing.length > 0 ? `, ${missing.length} skipped (not found)` : ""}.`,
        });
      });
    },
  );

  server.registerTool(
    "list_course_files",
    {
      description:
        "List files in a course (metadata only: id, name, size, content type, updated_at, locked/hidden). Optional name search and sort. Use the id with file tools or module items.",
      inputSchema: LIST_COURSE_FILES_INPUT,
    },
    async (input) => {
      const args = input as CourseContentArgs<typeof LIST_COURSE_FILES_INPUT>;
      return safeHandler("list_course_files", async () => {
        const sort = args.sort ?? "updated_at";
        const order = args.order ?? "desc";
        if (!(FILE_SORT_FIELDS as readonly string[]).includes(sort)) {
          throw new Error(`invalid sort "${sort}". Use one of: ${FILE_SORT_FIELDS.join(", ")}.`);
        }
        if (order !== "asc" && order !== "desc") {
          throw new Error(`invalid order "${order}". Use 'asc' or 'desc'.`);
        }
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const params: Record<string, unknown> = { sort, order };
        if (args.search_term) params.search_term = args.search_term;
        const { items: files, truncated } = await canvas.getPaginated<CanvasFile>(
          `/api/v1/courses/${courseId}/files`,
          { params },
        );
        const payload: Record<string, unknown> = {
          ...courseRef(canvas, courseId),
          count: files.length,
          files: files.map((file) => {
            const entry: Record<string, unknown> = {
              id: file.id,
              name: file.display_name ?? file.filename ?? null,
              size: formatFileSize(file.size),
              content_type: file["content-type"] ?? null,
              updated_at: file.updated_at ?? null,
            };
            if (file.locked) entry.locked = true;
            if (file.hidden) entry.hidden = true;
            return entry;
          }),
        };
        if (truncated) payload.truncated = true;
        return jsonResult(payload, {
          summary: `${courseLabel(canvas, courseId)}: ${files.length} file(s)${args.search_term ? ` matching "${args.search_term}"` : ""}.`,
        });
      });
    },
  );
}
