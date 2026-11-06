import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { CanvasApiError } from "../types.js";
import { DEANON_DENIED_NOTE, resolveAnonymous } from "../featureFlags.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";
import { fetchStudentRoster } from "./roster.js";

const NUMERIC_ID = /^\d+$/;
const LOW_SCORE_PCT = 70;
const HIGH_SCORE_PCT = 90;
const MAX_LISTED_STUDENTS = 50;
const MAX_LISTED_ASSIGNMENTS = 50;

const ROSTER_TRUNCATED_NOTE =
  "The student roster was truncated before every page was fetched; students on unfetched pages are not counted.";

const ID = z.union([z.string(), z.number()]);

const ANONYMOUS_PARAM = z
  .boolean()
  .optional()
  .describe(
    "When true (default), student names are pseudonymized. Override only takes effect with CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server.",
  );

const GET_ASSIGNMENT_ANALYTICS_INPUT = {
  course_identifier: ID.describe("Course code or numeric Canvas id."),
  assignment_id: ID.describe("Numeric Canvas assignment id."),
  anonymous: ANONYMOUS_PARAM,
};

const STUDENT_SORTS = ["engagement_score", "page_views", "participations", "name", "current_score"] as const;

const GET_STUDENT_ANALYTICS_INPUT = {
  course_identifier: ID.describe("Course code or numeric Canvas id."),
  student_id: ID.optional().describe(
    "Real Canvas user id (not a pseudonym). When set, returns only that student plus their missing and late assignments.",
  ),
  include_participation: z.boolean().optional().describe("Include participation counts (default true)."),
  include_assignment_stats: z.boolean().optional().describe("Include on-time/late/missing counts (default true)."),
  include_access_stats: z.boolean().optional().describe("Include page-view counts (default true)."),
  include_current_score: z.boolean().optional().describe("Include current course score/grade (default true)."),
  sort_by: z
    .enum(STUDENT_SORTS)
    .optional()
    .describe("engagement_score (default, lowest first), page_views, participations, current_score (lowest first), or name."),
  anonymous: ANONYMOUS_PARAM,
};

type AssignmentAnalyticsArgs = z.infer<z.ZodObject<typeof GET_ASSIGNMENT_ANALYTICS_INPUT>>;
type StudentAnalyticsArgs = z.infer<z.ZodObject<typeof GET_STUDENT_ANALYTICS_INPUT>>;

interface CanvasAssignment {
  id: number;
  name?: string | null;
  due_at?: string | null;
  points_possible?: number | null;
  published?: boolean | null;
}

interface CanvasSubmissionLite {
  user_id?: number | string | null;
  score?: number | null;
  submitted_at?: string | null;
  late?: boolean | null;
  missing?: boolean | null;
  excused?: boolean | null;
  workflow_state?: string | null;
  assignment_id?: number | string | null;
  assignment?: { id?: number; name?: string | null; due_at?: string | null; points_possible?: number | null } | null;
}

interface CanvasStudentSummary {
  id: number | string;
  page_views?: number | null;
  max_page_views?: number | null;
  participations?: number | null;
  max_participations?: number | null;
  tardiness_breakdown?: {
    on_time?: number | null;
    late?: number | null;
    missing?: number | null;
    floating?: number | null;
    total?: number | null;
  } | null;
}

interface CanvasEnrollmentWithGrades {
  user_id?: number | string;
  user?: { id?: number | string; name?: string | null; sortable_name?: string | null } | null;
  grades?: { current_score?: number | null; current_grade?: string | null } | null;
}

function validationError(tool: string, message: string): CanvasApiError {
  return new CanvasApiError({ code: "VALIDATION", message: `${tool}: ${message}` });
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round((numerator / denominator) * 100, 1) : null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Sample standard deviation (Python statistics.stdev); 0 for fewer than two values. */
function sampleStdev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

const GRADE_BUCKETS: Array<{ label: string; min: number }> = [
  { label: "90-100+", min: 90 },
  { label: "80-89", min: 80 },
  { label: "70-79", min: 70 },
  { label: "60-69", min: 60 },
  { label: "below_60", min: -Infinity },
];

function gradeDistribution(percentages: number[]): Record<string, number> {
  const distribution: Record<string, number> = Object.fromEntries(GRADE_BUCKETS.map((bucket) => [bucket.label, 0]));
  for (const value of percentages) {
    const bucket = GRADE_BUCKETS.find((candidate) => value >= candidate.min)!;
    distribution[bucket.label] = (distribution[bucket.label] ?? 0) + 1;
  }
  return distribution;
}

/**
 * Resolves display names for students: pseudonyms when anonymized (allocated
 * from the course's persistent map, so they match every other tool), real
 * roster names only when the operator has opted in.
 */
function studentNamer(
  anonymizer: Anonymizer,
  courseId: number,
  anonymous: boolean,
  realNames: Map<string, string>,
): (userId: string) => Promise<string> {
  return async (userId) => {
    const realName = realNames.get(userId);
    if (!anonymous) return realName && realName.trim() ? realName : `user_${userId}`;
    const { pseudonym } = await anonymizer.getOrAllocate(courseId, { id: userId, name: realName, role: "student" });
    return pseudonym;
  };
}

function courseLabel(canvas: CanvasClient, courseId: number): string {
  return canvas.getCachedCourseCode(courseId) ?? `course ${courseId}`;
}

export function registerAnalyticsTools(
  server: McpServer,
  canvas: CanvasClient,
  anonymizer: Anonymizer,
): void {
  server.registerTool(
    "get_assignment_analytics",
    {
      description:
        "Performance analytics for one assignment: submission/on-time/late/missing/excused counts, score statistics (mean, median, min, max, stdev), grade-distribution buckets, and the students without a submission or scoring below 70%. " +
        "Counts cover students on the course roster only (Test Student excluded). Student names are pseudonymized by default (FERPA gate).",
      inputSchema: GET_ASSIGNMENT_ANALYTICS_INPUT,
    },
    async (input) => {
      const args = input as AssignmentAnalyticsArgs;
      const tool = "get_assignment_analytics";
      return safeHandler(tool, async () => {
        const assignmentId = String(args.assignment_id ?? "").trim();
        if (!NUMERIC_ID.test(assignmentId)) {
          throw validationError(tool, `assignment_id must be a numeric Canvas id (got "${assignmentId}").`);
        }
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { anonymous, overridden } = resolveAnonymous(args.anonymous);

        const assignment = await canvas.get<CanvasAssignment>(`/api/v1/courses/${courseId}/assignments/${assignmentId}`);
        const roster = await fetchStudentRoster(canvas, courseId);
        const { items: rawSubmissions } = await canvas.getPaginated<CanvasSubmissionLite>(
          `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
        );

        const realNames = new Map(roster.students.map((student) => [student.id, student.name]));
        const submissionsByUser = new Map<string, CanvasSubmissionLite>();
        let excludedNonRoster = 0;
        for (const submission of rawSubmissions) {
          const userId = submission.user_id === undefined || submission.user_id === null ? "" : String(submission.user_id);
          if (realNames.has(userId)) submissionsByUser.set(userId, submission);
          else excludedNonRoster += 1;
        }

        const pointsPossible = typeof assignment.points_possible === "number" ? assignment.points_possible : 0;
        const counts = {
          total_students: roster.students.length,
          assigned: submissionsByUser.size,
          not_assigned: roster.students.length - submissionsByUser.size,
          submitted: 0,
          on_time: 0,
          late: 0,
          missing: 0,
          not_submitted: 0,
          excused: 0,
          graded: 0,
          excluded_non_roster_submissions: excludedNonRoster,
        };
        const scores: number[] = [];
        const percentages: number[] = [];
        const withoutSubmission: Array<{ userId: string; missing: boolean }> = [];
        const lowScoring: Array<{ userId: string; score: number; pct: number }> = [];
        let highScoringCount = 0;

        // Roster order keeps the walk deterministic (and with it, the order
        // in which first-seen students are allocated pseudonyms).
        for (const student of roster.students) {
          const submission = submissionsByUser.get(student.id);
          if (!submission) continue;
          const excused = submission.excused === true;
          const submitted = submission.submitted_at !== undefined && submission.submitted_at !== null;
          const late = submission.late === true;
          const missing = submission.missing === true;
          if (excused) counts.excused += 1;
          if (submitted) {
            counts.submitted += 1;
            if (late) counts.late += 1;
            else counts.on_time += 1;
          }
          if (missing) counts.missing += 1;
          if (!submitted && !excused) {
            counts.not_submitted += 1;
            withoutSubmission.push({ userId: student.id, missing });
          }
          if (typeof submission.score === "number" && !excused) {
            counts.graded += 1;
            scores.push(submission.score);
            if (pointsPossible > 0) {
              const percentage = (submission.score / pointsPossible) * 100;
              percentages.push(percentage);
              if (percentage < LOW_SCORE_PCT) lowScoring.push({ userId: student.id, score: submission.score, pct: percentage });
              if (percentage > HIGH_SCORE_PCT) highScoringCount += 1;
            }
          }
        }

        const gradable = counts.assigned - counts.excused;
        const scoreStats =
          scores.length > 0
            ? {
                count: scores.length,
                mean: round(mean(scores), 2),
                median: round(median(scores), 2),
                min: Math.min(...scores),
                max: Math.max(...scores),
                stdev: round(sampleStdev(scores), 2),
                mean_pct: pointsPossible > 0 ? round((mean(scores) / pointsPossible) * 100, 1) : null,
                median_pct: pointsPossible > 0 ? round((median(scores) / pointsPossible) * 100, 1) : null,
              }
            : null;

        const nameFor = studentNamer(anonymizer, courseId, anonymous, realNames);
        const listedWithout: Array<{ user_id: string; name: string; missing: boolean }> = [];
        // Missing-flagged students first: they are the ones Canvas already
        // counts against the student.
        const orderedWithout = [...withoutSubmission].sort((a, b) => Number(b.missing) - Number(a.missing));
        for (const entry of orderedWithout.slice(0, MAX_LISTED_STUDENTS)) {
          listedWithout.push({ user_id: entry.userId, name: await nameFor(entry.userId), missing: entry.missing });
        }
        const listedLow: Array<{ user_id: string; name: string; score: number; pct: number }> = [];
        for (const entry of [...lowScoring].sort((a, b) => a.pct - b.pct).slice(0, MAX_LISTED_STUDENTS)) {
          listedLow.push({ user_id: entry.userId, name: await nameFor(entry.userId), score: entry.score, pct: round(entry.pct, 1) });
        }

        const dueMs = assignment.due_at ? Date.parse(assignment.due_at) : Number.NaN;
        const warnings: string[] = [];
        if (overridden) warnings.push(DEANON_DENIED_NOTE);
        if (roster.truncated) warnings.push(ROSTER_TRUNCATED_NOTE);

        return jsonResult(
          {
            course_id: courseId,
            course_code: canvas.getCachedCourseCode(courseId) ?? null,
            assignment: {
              id: assignment.id,
              name: assignment.name ?? null,
              due_at: assignment.due_at ?? null,
              past_due: Number.isFinite(dueMs) ? dueMs < Date.now() : false,
              points_possible: assignment.points_possible ?? null,
              published: assignment.published ?? null,
            },
            anonymized: anonymous,
            ...(warnings.length > 0 ? { warnings } : {}),
            counts,
            rates: {
              submission_rate_pct: pct(counts.submitted, gradable),
              on_time_pct_of_submitted: pct(counts.on_time, counts.submitted),
              late_pct_of_submitted: pct(counts.late, counts.submitted),
              missing_pct: pct(counts.missing, gradable),
              graded_pct: pct(counts.graded, gradable),
            },
            score_stats: scoreStats,
            grade_distribution: pointsPossible > 0 && percentages.length > 0 ? gradeDistribution(percentages) : null,
            high_scoring_count: highScoringCount,
            students_without_submission: { total: withoutSubmission.length, students: listedWithout },
            low_scoring_students: { threshold_pct: LOW_SCORE_PCT, total: lowScoring.length, students: listedLow },
          },
          {
            summary:
              `Assignment ${assignment.id} "${assignment.name ?? ""}" in ${courseLabel(canvas, courseId)}: ` +
              `${counts.submitted}/${gradable} submitted, ${counts.late} late, ${counts.missing} missing` +
              (scoreStats ? `, mean ${scoreStats.mean}/${pointsPossible}` : "") +
              (anonymous ? " (anonymized)" : "") +
              "." +
              (overridden ? ` [override: ${DEANON_DENIED_NOTE}]` : ""),
          },
        );
      });
    },
  );

  server.registerTool(
    "get_student_analytics",
    {
      description:
        "Per-student engagement analytics from Canvas Analytics (student_summaries): page views, participations, on-time/late/missing counts, submit rate, current score, and an engagement score " +
        "(0.4 x page-view % of course max + 0.4 x participation % of max + 0.2 x submit rate). Sorted lowest engagement first to surface disengaged students. " +
        "Pass student_id for one student plus their missing/late assignments. Student names are pseudonymized by default (FERPA gate). Requires Canvas Analytics to be enabled for the course.",
      inputSchema: GET_STUDENT_ANALYTICS_INPUT,
    },
    async (input) => {
      const args = input as StudentAnalyticsArgs;
      const tool = "get_student_analytics";
      return safeHandler(tool, async () => {
        const studentId =
          args.student_id === undefined || String(args.student_id).trim() === "" ? null : String(args.student_id).trim();
        if (studentId !== null && !NUMERIC_ID.test(studentId)) {
          throw validationError(tool, `student_id must be a real numeric Canvas user id, not a pseudonym (got "${studentId}").`);
        }
        const sortBy = args.sort_by ?? "engagement_score";
        if (!(STUDENT_SORTS as readonly string[]).includes(sortBy)) {
          throw validationError(tool, `sort_by must be one of: ${STUDENT_SORTS.join(", ")}.`);
        }
        const includeParticipation = args.include_participation !== false;
        const includeAssignmentStats = args.include_assignment_stats !== false;
        const includeAccessStats = args.include_access_stats !== false;
        const includeCurrentScore = args.include_current_score !== false;

        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const warnings: string[] = [];
        if (overridden) warnings.push(DEANON_DENIED_NOTE);

        let summaries: CanvasStudentSummary[];
        try {
          const result = await canvas.getPaginated<CanvasStudentSummary>(
            `/api/v1/courses/${courseId}/analytics/student_summaries`,
            { params: studentId ? { student_id: studentId } : {} },
          );
          summaries = result.items;
          if (result.truncated) warnings.push("Canvas returned more student summaries than were fetched; the list is incomplete.");
        } catch (error) {
          if (
            error instanceof CanvasApiError &&
            (error.code === "NOT_FOUND" || error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED")
          ) {
            throw new CanvasApiError({
              code: error.code,
              status: error.status,
              endpoint: error.endpoint,
              message:
                `${tool}: Canvas course analytics are unavailable for ${courseLabel(canvas, courseId)} (HTTP ${error.status ?? "?"}). ` +
                "Analytics may be disabled for this course/account, or the token lacks the view_analytics permission. " +
                "get_assignment_analytics works without Canvas Analytics.",
            });
          }
          throw error;
        }

        // Real names are only needed for de-anonymized output; current scores
        // need the enrollments either way.
        const realNames = new Map<string, string>();
        const grades = new Map<string, { current_score: number | null; current_grade: string | null }>();
        if (includeCurrentScore || !anonymous) {
          try {
            const { items: enrollments } = await canvas.getPaginated<CanvasEnrollmentWithGrades>(
              `/api/v1/courses/${courseId}/enrollments`,
              { params: { "type[]": ["StudentEnrollment"], ...(studentId ? { user_id: studentId } : {}) } },
            );
            for (const enrollment of enrollments) {
              const rawId = enrollment.user_id ?? enrollment.user?.id;
              if (rawId === undefined || rawId === null) continue;
              const id = String(rawId);
              const name = enrollment.user?.sortable_name ?? enrollment.user?.name;
              if (name && !realNames.has(id)) realNames.set(id, name);
              if (enrollment.grades && !grades.has(id)) {
                grades.set(id, {
                  current_score: enrollment.grades.current_score ?? null,
                  current_grade: enrollment.grades.current_grade ?? null,
                });
              }
            }
          } catch (error) {
            warnings.push(
              `Could not fetch course enrollments (${error instanceof Error ? error.message : String(error)}); current scores${anonymous ? "" : " and names"} are unavailable.`,
            );
          }
        }

        const nameFor = studentNamer(anonymizer, courseId, anonymous, realNames);
        const rows: Array<Record<string, unknown> & { user_id: string; name: string; engagement_score: number }> = [];
        for (const summary of summaries) {
          const userId = String(summary.id);
          const pageViews = summary.page_views ?? 0;
          const maxPageViews = summary.max_page_views ?? 0;
          const participations = summary.participations ?? 0;
          const maxParticipations = summary.max_participations ?? 0;
          const tardiness = summary.tardiness_breakdown ?? {};
          const onTime = tardiness.on_time ?? 0;
          const late = tardiness.late ?? 0;
          const missing = tardiness.missing ?? 0;
          const total = tardiness.total ?? 0;
          const pageViewPct = maxPageViews ? Math.round((pageViews / maxPageViews) * 100) : 0;
          const participationPct = maxParticipations ? Math.round((participations / maxParticipations) * 100) : 0;
          const submitRate = total ? Math.round(((onTime + late) / total) * 100) : 0;

          const row: Record<string, unknown> & { user_id: string; name: string; engagement_score: number } = {
            user_id: userId,
            name: await nameFor(userId),
            engagement_score: Math.round(0.4 * pageViewPct + 0.4 * participationPct + 0.2 * submitRate),
          };
          if (includeAccessStats) {
            row.page_views = pageViews;
            row.page_views_pct_of_max = pageViewPct;
          }
          if (includeParticipation) {
            row.participations = participations;
            row.participations_pct_of_max = participationPct;
          }
          if (includeAssignmentStats) {
            row.on_time = onTime;
            row.late = late;
            row.missing = missing;
            row.floating = tardiness.floating ?? 0;
            row.total_assignments = total;
            row.submit_rate_pct = submitRate;
          }
          if (includeCurrentScore) {
            const grade = grades.get(userId);
            row.current_score = grade?.current_score ?? null;
            row.current_grade = grade?.current_grade ?? null;
          }
          rows.push(row);
        }

        const pageViewsOf = (summary: CanvasStudentSummary): number => summary.page_views ?? 0;
        const participationsOf = (summary: CanvasStudentSummary): number => summary.participations ?? 0;
        const byId = new Map(summaries.map((summary) => [String(summary.id), summary]));
        rows.sort((a, b) => {
          switch (sortBy) {
            case "page_views":
              return pageViewsOf(byId.get(a.user_id)!) - pageViewsOf(byId.get(b.user_id)!);
            case "participations":
              return participationsOf(byId.get(a.user_id)!) - participationsOf(byId.get(b.user_id)!);
            case "name":
              return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            case "current_score": {
              const scoreA = grades.get(a.user_id)?.current_score;
              const scoreB = grades.get(b.user_id)?.current_score;
              if (scoreA === null || scoreA === undefined) return scoreB === null || scoreB === undefined ? 0 : 1;
              if (scoreB === null || scoreB === undefined) return -1;
              return scoreA - scoreB;
            }
            default:
              return a.engagement_score - b.engagement_score;
          }
        });

        let studentAssignments: Record<string, unknown> | undefined;
        if (studentId !== null && summaries.length > 0) {
          try {
            const { items: submissions } = await canvas.getPaginated<CanvasSubmissionLite>(
              `/api/v1/courses/${courseId}/students/submissions`,
              { params: { "student_ids[]": [studentId], "include[]": ["assignment"] } },
            );
            const describe = (submission: CanvasSubmissionLite): Record<string, unknown> => ({
              assignment_id: submission.assignment?.id ?? submission.assignment_id ?? null,
              name: submission.assignment?.name ?? null,
              due_at: submission.assignment?.due_at ?? null,
              points_possible: submission.assignment?.points_possible ?? null,
              score: submission.score ?? null,
            });
            const missingList = submissions.filter((submission) => submission.missing === true && submission.excused !== true);
            const lateList = submissions.filter((submission) => submission.late === true && submission.excused !== true);
            studentAssignments = {
              missing_total: missingList.length,
              missing: missingList.slice(0, MAX_LISTED_ASSIGNMENTS).map(describe),
              late_total: lateList.length,
              late: lateList.slice(0, MAX_LISTED_ASSIGNMENTS).map(describe),
            };
          } catch (error) {
            warnings.push(
              `Could not fetch this student's submissions (${error instanceof Error ? error.message : String(error)}); missing/late assignment lists are unavailable.`,
            );
          }
        }

        return jsonResult(
          {
            course_id: courseId,
            course_code: canvas.getCachedCourseCode(courseId) ?? null,
            student_count: rows.length,
            sort_by: sortBy,
            engagement_formula: "0.4*page_views_pct_of_max + 0.4*participations_pct_of_max + 0.2*submit_rate_pct",
            anonymized: anonymous,
            ...(warnings.length > 0 ? { warnings } : {}),
            students: rows,
            ...(studentAssignments ? { student_assignments: studentAssignments } : {}),
          },
          {
            summary:
              (studentId !== null && rows.length === 0
                ? `No analytics row for student ${studentId} in ${courseLabel(canvas, courseId)}.`
                : `Student analytics for ${courseLabel(canvas, courseId)}: ${rows.length} student(s), sorted by ${sortBy}${anonymous ? " (anonymized)" : ""}.`) +
              (overridden ? ` [override: ${DEANON_DENIED_NOTE}]` : ""),
          },
        );
      });
    },
  );
}
