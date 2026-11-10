import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import { CanvasApiError } from "../types.js";
import { deriveCourseUrl, jsonResult, safeHandler } from "./toolHelpers.js";
import { CONFIRMATION_TOKEN_PARAM, consumeConfirmationToken, previewResult } from "./confirmGate.js";
import { loadOutcomeCatalog, parseNumericIds, type OutcomeEntry } from "./outcomes.js";

const TOOL = "create_rubric_from_outcomes";
const MAX_OUTCOMES = 30;
const MAX_ASSIGNMENTS = 30;
const TITLE_MAX = 255;
const FORM = { headers: { "Content-Type": "application/x-www-form-urlencoded" } };

const ID = z.union([z.string(), z.number()]);

const INPUT = {
  course_identifier: ID.describe("Course code or numeric Canvas id."),
  outcome_ids: z
    .array(ID)
    .min(1)
    .max(MAX_OUTCOMES)
    .describe(
      "Outcome ids (from get_course_outcomes), in the order the rubric rows should appear. Each outcome becomes one row, " +
        "using the rating scale Canvas applies to it in this course.",
    ),
  assignment_ids: z
    .array(ID)
    .max(MAX_ASSIGNMENTS)
    .optional()
    .describe(
      "Assignments to attach the rubric to. An assignment that already has a rubric is skipped, never replaced. " +
        "Omit to only save the rubric in the course's rubric list.",
    ),
  title: z
    .string()
    .max(TITLE_MAX)
    .optional()
    .describe("Rubric title. Default: '<assignment name>: Outcomes' for one assignment, otherwise 'Outcomes: <first outcome> (+N more)'."),
  use_for_grading: z
    .boolean()
    .optional()
    .describe(
      "Default false: the rubric records outcome mastery but does not set the grade. True: rubric scores become the grade, " +
        "and Canvas changes each assignment's points to the rubric total (the preview shows the change).",
    ),
  confirmation_token: CONFIRMATION_TOKEN_PARAM,
};

type Args = z.infer<z.ZodObject<typeof INPUT>>;

interface CanvasAssignmentLite {
  id: number | string;
  name?: string | null;
  points_possible?: number | null;
  published?: boolean | null;
  rubric_settings?: { id?: number | string | null; title?: string | null } | null;
  rubric?: unknown[] | null;
}

/** Canvas's rubric endpoints report validation failures as HTTP 200 with this body. */
interface CanvasSoftError {
  error?: boolean;
  messages?: unknown[];
}

interface RubricCreateResponse extends CanvasSoftError {
  rubric?: {
    id?: number | string | null;
    title?: string | null;
    points_possible?: number | null;
    data?: Array<{ learning_outcome_id?: number | string | null }> | null;
  } | null;
}

interface AssociationResponse extends CanvasSoftError {
  rubric_association?: { id?: number | string | null; association_id?: number | string | null; use_for_grading?: boolean | null } | null;
}

interface Criterion {
  outcome_id: string;
  description: string;
  group: string | null;
  mastery_points: number | null;
  points: number;
  ratings: Array<{ description: string; points: number }>;
}

interface AttachTarget {
  assignment_id: string;
  name: string;
  published: boolean | null;
  points_now: number | null;
  points_after?: number;
}

interface Plan {
  title: string;
  criteria: Criterion[];
  totalPoints: number;
  attach: AttachTarget[];
  skipped: Array<{ assignment_id: string; name: string; existing_rubric: string }>;
  duplicateOutcomeIds: string[];
}

function fail(message: string): CanvasApiError {
  return new CanvasApiError({ code: "VALIDATION", message: `${TOOL}: ${message}` });
}

function softErrorText(body: CanvasSoftError): string {
  const parts = (body.messages ?? []).map((message) => (typeof message === "string" ? message : JSON.stringify(message)));
  return parts.length > 0 ? parts.join("; ") : "no reason given";
}

function dedupe(ids: string[]): { unique: string[]; duplicates: string[] } {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    else {
      seen.add(id);
      unique.push(id);
    }
  }
  return { unique, duplicates };
}

function toCriterion(outcome: OutcomeEntry): Criterion | null {
  const ratings = outcome.ratings
    .filter((rating): rating is { points: number; description: string | null } => typeof rating.points === "number")
    .map((rating) => ({ description: (rating.description ?? "").trim() || `${rating.points} points`, points: rating.points }))
    .sort((a, b) => b.points - a.points);
  if (ratings.length === 0) return null;
  return {
    outcome_id: outcome.id,
    description: outcome.title,
    group: outcome.group,
    mastery_points: outcome.mastery_points,
    points: ratings[0]!.points,
    ratings,
  };
}

function defaultTitle(criteria: Criterion[], attach: AttachTarget[]): string {
  if (attach.length === 1) return `${attach[0]!.name}: Outcomes`.slice(0, TITLE_MAX);
  const first = criteria[0]!.description;
  const more = criteria.length > 1 ? ` (+${criteria.length - 1} more)` : "";
  return `Outcomes: ${first}${more}`.slice(0, TITLE_MAX);
}

async function buildPlan(canvas: CanvasClient, courseId: number, courseLabel: string, args: Args): Promise<Plan> {
  const requestedOutcomes = dedupe(parseNumericIds(TOOL, "outcome_ids", args.outcome_ids));
  const requestedAssignments = dedupe(parseNumericIds(TOOL, "assignment_ids", args.assignment_ids ?? [])).unique;

  const catalog = await loadOutcomeCatalog(canvas, courseId, new Set(requestedOutcomes.unique));
  if (catalog.missing.length > 0) {
    throw fail(
      `outcome id(s) ${catalog.missing.join(", ")} are not linked to ${courseLabel}` +
        (catalog.incomplete ? " (Canvas's outcome list was too long to read in full)" : "") +
        ". Use get_course_outcomes to see the course's outcomes. Nothing was written.",
    );
  }
  const byId = new Map(catalog.outcomes.map((outcome) => [outcome.id, outcome]));
  const criteria: Criterion[] = [];
  const unscaled: string[] = [];
  for (const id of requestedOutcomes.unique) {
    const criterion = toCriterion(byId.get(id)!);
    if (criterion) criteria.push(criterion);
    else unscaled.push(`${byId.get(id)!.title} (id ${id})`);
  }
  if (unscaled.length > 0) {
    throw fail(
      `these outcomes have no rating scale in Canvas, so they can't become rubric rows: ${unscaled.join("; ")}. ` +
        "Add ratings to the outcome (or a mastery scale to the course) in Canvas first. Nothing was written.",
    );
  }

  const attach: AttachTarget[] = [];
  const skipped: Plan["skipped"] = [];
  for (const assignmentId of requestedAssignments) {
    let assignment: CanvasAssignmentLite;
    try {
      assignment = await canvas.get<CanvasAssignmentLite>(`/api/v1/courses/${courseId}/assignments/${assignmentId}`);
    } catch (error) {
      if (error instanceof CanvasApiError && error.code === "NOT_FOUND") {
        throw fail(`assignment ${assignmentId} was not found in ${courseLabel}. Nothing was written.`);
      }
      throw error;
    }
    const name = (assignment.name ?? "").trim() || `Assignment ${assignmentId}`;
    const hasRubric = Boolean(assignment.rubric_settings) || (Array.isArray(assignment.rubric) && assignment.rubric.length > 0);
    if (hasRubric) {
      const existing = (assignment.rubric_settings?.title ?? "").trim() || "a rubric";
      skipped.push({ assignment_id: assignmentId, name, existing_rubric: existing });
      continue;
    }
    attach.push({
      assignment_id: assignmentId,
      name,
      published: typeof assignment.published === "boolean" ? assignment.published : null,
      points_now: typeof assignment.points_possible === "number" ? assignment.points_possible : null,
    });
  }
  if (requestedAssignments.length > 0 && attach.length === 0) {
    throw fail(
      `every listed assignment already has a rubric (${skipped.map((entry) => `${entry.name}: "${entry.existing_rubric}"`).join("; ")}). ` +
        "This tool never replaces a rubric, because Canvas would discard the old one's outcome results. Remove the old rubric in Canvas first, or pick other assignments. Nothing was written.",
    );
  }

  const totalPoints = criteria.reduce((sum, criterion) => sum + criterion.points, 0);
  if (args.use_for_grading) {
    for (const target of attach) target.points_after = totalPoints;
  }
  const title = (args.title ?? "").trim() || defaultTitle(criteria, attach);
  return { title, criteria, totalPoints, attach, skipped, duplicateOutcomeIds: requestedOutcomes.duplicates };
}

function rubricForm(courseId: number, plan: Plan): URLSearchParams {
  const form = new URLSearchParams();
  form.append("rubric[title]", plan.title);
  plan.criteria.forEach((criterion, ci) => {
    const key = `rubric[criteria][${ci}]`;
    form.append(`${key}[description]`, criterion.description);
    form.append(`${key}[learning_outcome_id]`, criterion.outcome_id);
    form.append(`${key}[points]`, String(criterion.points));
    if (criterion.mastery_points !== null) form.append(`${key}[mastery_points]`, String(criterion.mastery_points));
    criterion.ratings.forEach((rating, ri) => {
      form.append(`${key}[ratings][${ri}][description]`, rating.description);
      form.append(`${key}[ratings][${ri}][points]`, String(rating.points));
    });
  });
  // Saved to the course's rubric list (as Canvas's own rubric page does); assignments are attached separately.
  form.append("rubric_association[association_type]", "Course");
  form.append("rubric_association[association_id]", String(courseId));
  form.append("rubric_association[purpose]", "bookmark");
  form.append("rubric_association[use_for_grading]", "0");
  return form;
}

function associationForm(rubricId: string, assignmentId: string, useForGrading: boolean): URLSearchParams {
  const form = new URLSearchParams();
  form.append("rubric_association[rubric_id]", rubricId);
  form.append("rubric_association[association_type]", "Assignment");
  form.append("rubric_association[association_id]", assignmentId);
  form.append("rubric_association[purpose]", "grading");
  form.append("rubric_association[use_for_grading]", useForGrading ? "1" : "0");
  return form;
}

function describeError(error: unknown): string {
  if (error instanceof CanvasApiError) return error.canvasMessage ? `${error.message} — ${error.canvasMessage}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

export function registerOutcomeRubricTools(server: McpServer, canvas: CanvasClient): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Build a Canvas rubric from the course's Canvas Outcomes and attach it to assignments. One row per outcome, linked to the outcome, " +
        "so scoring the rubric in SpeedGrader records mastery in the Learning Mastery Gradebook. Each row uses the rating scale Canvas applies to that outcome in this course. " +
        "The rubric is saved to the course's rubric list and attached to each listed assignment. An assignment that already has a rubric is skipped, never replaced. " +
        "use_for_grading=false (default) leaves grades and points alone. Two steps: the first call returns a PREVIEW and a confirmation_token and writes nothing; " +
        "after the teacher approves, call again with identical arguments plus the token. Get outcome ids from get_course_outcomes.",
      inputSchema: INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const args = input as Args;
      return safeHandler(TOOL, async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const courseLabel = canvas.getCachedCourseCode(courseId) ?? `course ${courseId}`;
        const useForGrading = args.use_for_grading ?? false;
        const plan = await buildPlan(canvas, courseId, courseLabel, args);

        // The resolved plan is bound into the token: if an outcome's scale changes or an
        // assignment gains a rubric between preview and confirm, the token is void.
        const gateArgs: Record<string, unknown> = {
          ...args,
          resolved_course_id: courseId,
          plan: {
            title: plan.title,
            criteria: plan.criteria,
            attach: plan.attach.map((target) => [target.assignment_id, target.points_now]),
            skipped: plan.skipped.map((entry) => entry.assignment_id),
          },
        };

        const notes: string[] = [
          "Each row is linked to its outcome, so rubric scores show up in the Learning Mastery Gradebook.",
        ];
        if (plan.attach.some((target) => target.published)) {
          notes.push("Students can see the rubric on the published assignment(s) as soon as it is attached.");
        }
        if (useForGrading) {
          const changes = plan.attach.filter((target) => target.points_now !== plan.totalPoints);
          if (changes.length > 0) {
            notes.push(
              `Rubric scores will set the grade, and Canvas will change the points of ${changes.length} assignment(s) to ${plan.totalPoints}: ` +
                changes.map((target) => `${target.name} (${target.points_now ?? "no points"} → ${plan.totalPoints})`).join("; ") +
                ".",
            );
          } else if (plan.attach.length > 0) {
            notes.push("Rubric scores will set the grade. Assignment points already match the rubric total.");
          }
        } else if (plan.attach.length > 0) {
          notes.push("Grades and assignment points stay as they are (use_for_grading=false).");
        }
        if (plan.duplicateOutcomeIds.length > 0) {
          notes.push(`Outcome id(s) listed twice were used once: ${[...new Set(plan.duplicateOutcomeIds)].join(", ")}.`);
        }

        const rubricPreview = {
          title: plan.title,
          total_points: plan.totalPoints,
          rows: plan.criteria.map((criterion) => ({
            outcome_id: criterion.outcome_id,
            outcome: criterion.description,
            group: criterion.group,
            points: criterion.points,
            mastery_points: criterion.mastery_points,
            ratings: criterion.ratings.map((rating) => `${rating.points} ${rating.description}`).join(" / "),
          })),
        };

        if (!args.confirmation_token) {
          const skippedText = plan.skipped.length > 0 ? ` ${plan.skipped.length} assignment(s) skipped (already have a rubric).` : "";
          return previewResult(
            TOOL,
            gateArgs,
            {
              course: courseLabel,
              rubric: rubricPreview,
              attach_to: plan.attach,
              ...(plan.skipped.length > 0 ? { skipped: plan.skipped } : {}),
              use_for_grading: useForGrading,
              notes,
            },
            `Would create rubric "${plan.title}" (${plan.criteria.length} row(s), ${plan.totalPoints} points) in ${courseLabel}` +
              (plan.attach.length > 0 ? ` and attach it to ${plan.attach.length} assignment(s).` : ", without attaching it to any assignment.") +
              skippedText,
          );
        }

        const redeemed = consumeConfirmationToken(TOOL, gateArgs, args.confirmation_token);
        if (!redeemed.ok) {
          throw new Error(
            `${redeemed.reason} (The token is also void if an outcome's scale or an assignment's rubric changed since the preview.) Nothing was changed.`,
          );
        }

        const created = await canvas.post<RubricCreateResponse>(`/api/v1/courses/${courseId}/rubrics`, rubricForm(courseId, plan), FORM);
        if (created.error) {
          throw new Error(`Canvas refused to create the rubric: ${softErrorText(created)}. Nothing was changed.`);
        }
        const rubricId = created.rubric?.id;
        if (rubricId === undefined || rubricId === null) {
          throw new Error("Canvas answered without a rubric id, so the rubric may not exist. Check the course's Rubrics page before retrying.");
        }
        const warnings: string[] = [];
        const linkedRows = (created.rubric?.data ?? []).filter(
          (row) => row.learning_outcome_id !== undefined && row.learning_outcome_id !== null,
        ).length;
        if (created.rubric?.data && linkedRows < plan.criteria.length) {
          warnings.push(
            `Canvas created the rubric but only ${linkedRows} of ${plan.criteria.length} row(s) are linked to outcomes. Check the rubric in Canvas.`,
          );
        }

        const attached: Array<Record<string, unknown>> = [];
        for (const target of plan.attach) {
          try {
            const response = await canvas.post<AssociationResponse>(
              `/api/v1/courses/${courseId}/rubric_associations`,
              associationForm(String(rubricId), target.assignment_id, useForGrading),
              FORM,
            );
            if (response.error) throw new Error(softErrorText(response));
            attached.push({
              assignment_id: target.assignment_id,
              name: target.name,
              attached: true,
              ...(useForGrading ? { points: plan.totalPoints } : {}),
            });
          } catch (error) {
            attached.push({ assignment_id: target.assignment_id, name: target.name, attached: false, error: describeError(error) });
          }
        }
        const failed = attached.filter((entry) => entry.attached === false);
        if (failed.length > 0) {
          warnings.push(
            `The rubric exists (id ${rubricId}) but was not attached to ${failed.length} assignment(s). ` +
              "Retry those with create_rubric_association using this rubric_id.",
          );
        }

        const rubricUrl = `${deriveCourseUrl(canvas.baseUrl, courseId)}/rubrics/${rubricId}`;
        const okCount = attached.length - failed.length;
        return jsonResult(
          {
            course: courseLabel,
            rubric_id: String(rubricId),
            rubric_url: rubricUrl,
            title: created.rubric?.title ?? plan.title,
            total_points: created.rubric?.points_possible ?? plan.totalPoints,
            rows: plan.criteria.length,
            use_for_grading: useForGrading,
            attached,
            ...(plan.skipped.length > 0 ? { skipped: plan.skipped } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
          },
          {
            summary:
              `Created rubric "${created.rubric?.title ?? plan.title}" (id ${rubricId}, ${plan.criteria.length} outcome row(s)) in ${courseLabel}` +
              (plan.attach.length > 0 ? `; attached to ${okCount} of ${plan.attach.length} assignment(s).` : ".") +
              (failed.length > 0 ? " Some attachments failed; see warnings." : ""),
          },
        );
      });
    },
  );
}
