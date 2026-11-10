import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { CanvasApiError } from "../types.js";
import { DEANON_DENIED_NOTE, resolveAnonymous } from "../featureFlags.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";
import { fetchStudentRoster } from "./roster.js";
import { htmlToText } from "./courseContent.js";

const TOOL = "get_course_outcomes";
const NUMERIC_ID = /^\d+$/;
const DESCRIPTION_CHARS = 600;
const MASTERY_MODES = ["none", "summary", "students"] as const;

const ID = z.union([z.string(), z.number()]);

const GET_COURSE_OUTCOMES_INPUT = {
  course_identifier: ID.describe("Course code or numeric Canvas id."),
  include_mastery: z
    .enum(MASTERY_MODES)
    .optional()
    .describe(
      "none (default): the outcomes only. summary: adds, per outcome, how many active students have mastered it, " +
        "have not yet, or have no score, plus the class average. students: the summary plus each student's score per outcome (pseudonymized).",
    ),
  outcome_ids: z
    .array(ID)
    .optional()
    .describe("Only these outcome ids (numeric Canvas ids, e.g. from a previous call)."),
  anonymous: z
    .boolean()
    .optional()
    .describe(
      "When true (default), students are pseudonymized. Override only takes effect with CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server.",
    ),
};

type GetCourseOutcomesArgs = z.infer<z.ZodObject<typeof GET_COURSE_OUTCOMES_INPUT>>;

interface CanvasRating {
  points?: number | null;
  description?: string | null;
  mastery?: boolean | null;
}

interface CanvasOutcome {
  id: number | string;
  title?: string | null;
  display_name?: string | null;
  description?: string | null;
  vendor_guid?: string | null;
  points_possible?: number | null;
  mastery_points?: number | null;
  ratings?: CanvasRating[] | null;
  calculation_method?: string | null;
  calculation_int?: number | null;
  assessed?: boolean | null;
}

interface CanvasOutcomeLink {
  outcome_group?: { id?: number | string | null; title?: string | null } | null;
  outcome?: CanvasOutcome | null;
}

interface CanvasOutcomeGroup {
  id: number | string;
  title?: string | null;
  parent_outcome_group?: { id?: number | string | null } | null;
}

interface CanvasRollup {
  scores?: Array<{ score?: number | null; links?: { outcome?: number | string | null } | null }> | null;
  links?: { user?: number | string | null; status?: string | null } | null;
}

interface OutcomeEntry {
  id: string;
  title: string;
  display_name?: string;
  group: string | null;
  description: string | null;
  description_truncated?: true;
  mastery_points: number | null;
  points_possible: number | null;
  ratings: Array<{ points: number | null; description: string | null }>;
  calculation_method: string | null;
  calculation_int?: number;
  assessed: boolean | null;
}

function validationError(message: string): CanvasApiError {
  return new CanvasApiError({ code: "VALIDATION", message: `${TOOL}: ${message}` });
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * "Parent > Child" titles for every group. The root group (no parent) stands for
 * the course itself, so it contributes nothing; outcomes linked there get "".
 */
function groupPathResolver(groups: CanvasOutcomeGroup[]): (groupId: string) => string | undefined {
  const byId = new Map(groups.map((group) => [String(group.id), group]));
  const cache = new Map<string, string>();
  const resolve = (groupId: string, seen: Set<string>): string | undefined => {
    const cached = cache.get(groupId);
    if (cached !== undefined) return cached;
    const group = byId.get(groupId);
    if (!group || seen.has(groupId)) return undefined;
    seen.add(groupId);
    const parentId = group.parent_outcome_group?.id;
    let full = "";
    if (parentId !== undefined && parentId !== null) {
      const title = (group.title ?? "").trim() || `Group ${groupId}`;
      const parentPath = resolve(String(parentId), seen) ?? "";
      full = parentPath ? `${parentPath} > ${title}` : title;
    }
    cache.set(groupId, full);
    return full;
  };
  return (groupId) => resolve(groupId, new Set());
}

function toOutcomeEntry(outcome: CanvasOutcome, group: string | null): OutcomeEntry {
  const descriptionText = outcome.description ? htmlToText(outcome.description) : "";
  const truncated = descriptionText.length > DESCRIPTION_CHARS;
  const title = (outcome.title ?? "").trim() || `Outcome ${outcome.id}`;
  const displayName = (outcome.display_name ?? "").trim();
  return {
    id: String(outcome.id),
    title,
    ...(displayName && displayName !== title ? { display_name: displayName } : {}),
    group,
    description: descriptionText ? descriptionText.slice(0, DESCRIPTION_CHARS) : null,
    ...(truncated ? { description_truncated: true as const } : {}),
    mastery_points: typeof outcome.mastery_points === "number" ? outcome.mastery_points : null,
    points_possible: typeof outcome.points_possible === "number" ? outcome.points_possible : null,
    ratings: (outcome.ratings ?? []).map((rating) => ({
      points: typeof rating.points === "number" ? rating.points : null,
      description: rating.description ?? null,
    })),
    calculation_method: outcome.calculation_method ?? null,
    ...(typeof outcome.calculation_int === "number" ? { calculation_int: outcome.calculation_int } : {}),
    assessed: typeof outcome.assessed === "boolean" ? outcome.assessed : null,
  };
}

function isPermissionError(error: unknown): boolean {
  return error instanceof CanvasApiError && (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED");
}

export function registerOutcomeTools(server: McpServer, canvas: CanvasClient, anonymizer: Anonymizer): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Read-only. The learning outcomes linked to a course in Canvas's Outcomes feature (not the 'Module Outcomes' pages the planning workflows create): title, group path (e.g. 'Safety > Shop tools'), description, " +
        "mastery threshold and rating scale (the scale Canvas actually applies in this course), calculation method, and whether any student has been assessed on it. " +
        "With include_mastery='summary' it adds, per outcome, how many active students have mastered it, have not yet, or have no score, and the class average; " +
        "'students' also lists each student's current score per outcome. Students are pseudonymized by default (FERPA gate). Changes nothing in Canvas.",
      inputSchema: GET_COURSE_OUTCOMES_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const args = input as GetCourseOutcomesArgs;
      return safeHandler(TOOL, async () => {
        const wantedIds = (args.outcome_ids ?? []).map((id) => String(id).trim());
        const badId = wantedIds.find((id) => !NUMERIC_ID.test(id));
        if (badId !== undefined) {
          throw validationError(`outcome_ids must be numeric Canvas ids (got "${badId}").`);
        }
        const wanted = wantedIds.length > 0 ? new Set(wantedIds) : null;
        const mode = args.include_mastery ?? "none";

        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const courseLabel = canvas.getCachedCourseCode(courseId) ?? `course ${courseId}`;
        const warnings: string[] = [];
        if (overridden) warnings.push(DEANON_DENIED_NOTE);

        const links = await canvas.getPaginated<CanvasOutcomeLink>(`/api/v1/courses/${courseId}/outcome_group_links`, {
          params: { outcome_style: "full" },
        });
        const groups = await canvas.getPaginated<CanvasOutcomeGroup>(`/api/v1/courses/${courseId}/outcome_groups`);
        if (links.truncated) warnings.push("Canvas returned more outcome links than were fetched; the outcome list is incomplete.");
        if (groups.truncated) warnings.push("Not every outcome group was fetched; some group paths may be missing.");
        const groupPath = groupPathResolver(groups.items);

        // An outcome can be linked into several groups of one course; list it once.
        const outcomes: OutcomeEntry[] = [];
        const seenOutcomes = new Set<string>();
        for (const link of links.items) {
          const outcome = link.outcome;
          if (!outcome || outcome.id === undefined || outcome.id === null) continue;
          const id = String(outcome.id);
          if (seenOutcomes.has(id) || (wanted && !wanted.has(id))) continue;
          seenOutcomes.add(id);
          const groupId = link.outcome_group?.id;
          const resolved = groupId !== undefined && groupId !== null ? groupPath(String(groupId)) : undefined;
          const fallbackTitle = (link.outcome_group?.title ?? "").trim();
          const group = resolved !== undefined ? resolved : fallbackTitle;
          outcomes.push(toOutcomeEntry(outcome, group || null));
        }
        if (wanted) {
          const missing = [...wanted].filter((id) => !seenOutcomes.has(id));
          if (missing.length > 0) warnings.push(`Not linked to this course: outcome id(s) ${missing.join(", ")}.`);
        }

        const groupCount = new Set(outcomes.map((outcome) => outcome.group).filter((group) => group)).size;
        const assessedCount = outcomes.filter((outcome) => outcome.assessed === true).length;
        const summaryParts = [
          outcomes.length === 0
            ? `${courseLabel}: no outcomes are linked to this course${wanted ? " for the requested ids" : ""}.`
            : `${courseLabel}: ${outcomes.length} outcome(s)${groupCount > 0 ? ` in ${groupCount} group(s)` : ""}; ` +
              `${assessedCount} assessed for at least one student.`,
        ];

        let mastery: Record<string, unknown> | undefined;
        if (mode !== "none" && outcomes.length > 0) {
          try {
            const rollups = await canvas.getPaginated<CanvasRollup>(`/api/v1/courses/${courseId}/outcome_rollups`, {
              params: wanted ? { "outcome_ids[]": [...wanted] } : {},
              itemsKey: "rollups",
            });
            if (rollups.truncated) warnings.push("Not every page of student results was fetched; mastery counts are incomplete.");

            // Canvas repeats a student once per section (each row with that section's
            // enrollment status); a student active in any section counts, once.
            const scoresByStudent = new Map<string, Map<string, number>>();
            const inactiveIds = new Set<string>();
            for (const rollup of rollups.items) {
              const userId = rollup.links?.user;
              if (userId === undefined || userId === null) continue;
              const key = String(userId);
              const status = rollup.links?.status;
              if (status && status !== "active") {
                inactiveIds.add(key);
                continue;
              }
              if (scoresByStudent.has(key)) continue;
              const scores = new Map<string, number>();
              for (const score of rollup.scores ?? []) {
                const outcomeId = score.links?.outcome;
                if (outcomeId === undefined || outcomeId === null || typeof score.score !== "number") continue;
                scores.set(String(outcomeId), score.score);
              }
              scoresByStudent.set(key, scores);
            }
            const inactive = [...inactiveIds].filter((id) => !scoresByStudent.has(id)).length;
            if (inactive > 0) {
              warnings.push(`${inactive} student(s) with inactive or concluded enrollments are left out of the counts.`);
            }

            const studentCount = scoresByStudent.size;
            const perOutcome = outcomes.map((outcome) => {
              const values = [...scoresByStudent.values()]
                .map((scores) => scores.get(outcome.id))
                .filter((value): value is number => value !== undefined);
              const threshold = outcome.mastery_points;
              const mastered = threshold === null ? null : values.filter((value) => value >= threshold).length;
              return {
                outcome_id: outcome.id,
                title: outcome.title,
                mastery_points: threshold,
                students_scored: values.length,
                mastered,
                not_yet: mastered === null ? null : values.length - mastered,
                no_score: studentCount - values.length,
                average: values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 2) : null,
              };
            });
            if (outcomes.some((outcome) => outcome.mastery_points === null)) {
              warnings.push("Some outcomes have no mastery threshold in Canvas, so mastered/not_yet are null for them.");
            }

            mastery = { active_students: studentCount, outcomes: perOutcome };

            if (mode === "students") {
              let realNames = new Map<string, string>();
              if (!anonymous) {
                const roster = await fetchStudentRoster(canvas, courseId);
                realNames = new Map(roster.students.map((student) => [student.id, student.name]));
              }
              const students: Array<{ user_id: string; student: string; scores: Record<string, number> }> = [];
              for (const [userId, scores] of scoresByStudent) {
                let label: string;
                if (anonymous) {
                  label = (await anonymizer.getOrAllocate(courseId, { id: userId, role: "student" })).pseudonym;
                } else {
                  const realName = realNames.get(userId);
                  label = realName && realName.trim() ? realName : `user_${userId}`;
                }
                students.push({ user_id: userId, student: label, scores: Object.fromEntries(scores) });
              }
              // Canvas orders rollups by real sortable name; sorting by label keeps that order out of the output.
              students.sort((a, b) => a.student.localeCompare(b.student, undefined, { numeric: true }));
              mastery.students = students;
            }

            const scored = perOutcome.filter((entry) => entry.students_scored > 0).length;
            summaryParts.push(
              `Mastery across ${studentCount} active student(s): ${scored} of ${perOutcome.length} outcome(s) have scores` +
                (mode === "students" ? "; per-student scores included." : "."),
            );
          } catch (error) {
            if (!isPermissionError(error)) throw error;
            warnings.push(
              "Canvas refused the student mastery results for this course (your role needs permission to view grades). The outcome list is still complete.",
            );
          }
        }

        return jsonResult(
          {
            course_id: courseId,
            course_code: canvas.getCachedCourseCode(courseId) ?? null,
            outcome_count: outcomes.length,
            outcomes,
            ...(mastery ? { mastery } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
          },
          { summary: summaryParts.join(" ") + (overridden ? ` [override: ${DEANON_DENIED_NOTE}]` : "") },
        );
      });
    },
  );
}
