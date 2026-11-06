import type { Anonymizer } from "../anonymizer.js";
import type { CanvasClient } from "../canvasClient.js";
import { CanvasApiError } from "../types.js";

/**
 * Canvas fetches, pure analytics and text builders behind the peer-review
 * tools. Nothing here decides anonymization policy: callers resolve the
 * FERPA gate and pass an already-configured Labeler / scrub function in.
 */

export const PEER_REVIEW_SCRUB_NOTE =
  "Peer-review comment text was anonymized on a best-effort basis: roster names were replaced with " +
  "pseudonyms, but nicknames, misspellings or indirect references may remain.";

export const PEER_REVIEWS_TRUNCATED_NOTE =
  "The peer-review list was truncated before all pages were retrieved; counts and lists may be incomplete.";

export const STUDENTS_TRUNCATED_NOTE =
  "The student roster fetch was truncated; enrollment counts may be low and some students may be labeled by id only.";

export const SUBMISSIONS_TRUNCATED_NOTE =
  "The submission list was truncated; comments on unfetched submissions are missing.";

export interface PeerReviewAssignment {
  id: number;
  name?: string;
  html_url?: string;
  due_at?: string | null;
  peer_reviews?: boolean;
  anonymous_peer_reviews?: boolean;
  automatic_peer_reviews?: boolean;
  peer_review_count?: number | null;
}

export interface CanvasPeerReview {
  id?: number | string;
  user_id?: number | string | null;
  assessor_id?: number | string | null;
  asset_id?: number | string | null;
  workflow_state?: string;
}

export interface ReviewRow {
  peer_review_id: number | null;
  /** Canvas assessor_id: the student doing the review. */
  reviewer_id: string;
  /** Canvas user_id: the student whose submission is reviewed. */
  reviewee_id: string;
  /** Canvas asset_id: the reviewee's submission id. */
  submission_id: string | null;
  status: "completed" | "assigned";
}

export interface StudentRecord {
  id: string;
  name: string;
  email: string | null;
}

export interface SubmissionComment {
  author_id?: number | string | null;
  comment?: string | null;
  created_at?: string | null;
}

export interface SubmissionLite {
  id: number | string;
  user_id: number | string;
  submitted_at?: string | null;
  attempt?: number | null;
  workflow_state?: string;
  late?: boolean;
  submission_comments?: SubmissionComment[];
}

export function requireNumericId(label: string, value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new CanvasApiError({
      code: "VALIDATION",
      message: `${label} must be a numeric Canvas id, got ${JSON.stringify(value ?? null)}.`,
    });
  }
  return text;
}

function assignmentPath(courseId: number, assignmentId: string): string {
  return `/api/v1/courses/${courseId}/assignments/${assignmentId}`;
}

export async function fetchAssignment(
  canvas: CanvasClient,
  courseId: number,
  assignmentId: string,
): Promise<PeerReviewAssignment> {
  return canvas.get<PeerReviewAssignment>(assignmentPath(courseId, assignmentId));
}

export function toReviewRows(raw: CanvasPeerReview[]): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const review of raw) {
    if (!review || review.assessor_id == null || review.user_id == null) continue;
    const numericId = review.id == null ? NaN : Number(review.id);
    rows.push({
      peer_review_id: Number.isFinite(numericId) ? numericId : null,
      reviewer_id: String(review.assessor_id),
      reviewee_id: String(review.user_id),
      submission_id: review.asset_id == null ? null : String(review.asset_id),
      status: review.workflow_state === "completed" ? "completed" : "assigned",
    });
  }
  return rows;
}

/**
 * The assignment-level endpoint returns every peer review in one paginated
 * walk, instead of one request per submission. include[] is deliberately not
 * sent: user/assessor includes would embed real names in the raw payload.
 */
export async function fetchPeerReviewRows(
  canvas: CanvasClient,
  courseId: number,
  assignmentId: string,
): Promise<{ rows: ReviewRow[]; truncated: boolean }> {
  const { items, truncated } = await canvas.getPaginated<CanvasPeerReview>(
    `${assignmentPath(courseId, assignmentId)}/peer_reviews`,
  );
  return { rows: toReviewRows(items), truncated };
}

export async function fetchStudents(
  canvas: CanvasClient,
  courseId: number,
  includeEmail = false,
): Promise<{ students: StudentRecord[]; truncated: boolean }> {
  const params: Record<string, unknown> = { "enrollment_type[]": ["student"] };
  if (includeEmail) params["include[]"] = ["email"];
  const { items, truncated } = await canvas.getPaginated<{ id: number | string; name?: unknown; email?: unknown }>(
    `/api/v1/courses/${courseId}/users`,
    { params },
  );
  return {
    students: items.map((user) => ({
      id: String(user.id),
      name: typeof user.name === "string" ? user.name : "",
      email: typeof user.email === "string" ? user.email : null,
    })),
    truncated,
  };
}

export async function fetchSubmissionsWithComments(
  canvas: CanvasClient,
  courseId: number,
  assignmentId: string,
): Promise<{ submissions: SubmissionLite[]; truncated: boolean }> {
  const { items, truncated } = await canvas.getPaginated<SubmissionLite>(
    `${assignmentPath(courseId, assignmentId)}/submissions`,
    { params: { "include[]": ["submission_comments"] } },
  );
  return { submissions: items, truncated };
}

// ---------------------------------------------------------------- labels

export interface Labeler {
  anonymous: boolean;
  name(id: string): Promise<string>;
  email(id: string): Promise<string | null>;
}

/**
 * Label people by id. Anonymous mode pre-allocates the roster in roster order
 * so pseudonym numbering does not depend on peer-review row order or on which
 * tool ran first; ids outside the roster (dropped students) still get a
 * pseudonym (fail closed). Staff ids, when known, get a neutral label.
 */
export async function buildLabeler(
  anonymizer: Anonymizer,
  courseId: number,
  anonymous: boolean,
  students: StudentRecord[],
  staffIds?: Set<string>,
): Promise<Labeler> {
  const byId = new Map(students.map((student) => [student.id, student]));
  const staffLabel = (id: string): string | null => (staffIds?.has(id) ? `Staff user ${id}` : null);

  if (!anonymous) {
    return {
      anonymous,
      name: async (id) => byId.get(id)?.name || staffLabel(id) || `User ${id}`,
      email: async (id) => byId.get(id)?.email ?? null,
    };
  }

  for (const student of students) {
    await anonymizer.getOrAllocate(courseId, { id: student.id, name: student.name });
  }
  return {
    anonymous,
    name: async (id) => {
      const staff = staffLabel(id);
      if (staff) return staff;
      return (await anonymizer.getOrAllocate(courseId, { id, name: byId.get(id)?.name })).pseudonym;
    },
    email: async (id) => {
      if (staffIds?.has(id)) return null;
      return (await anonymizer.getOrAllocate(courseId, { id, name: byId.get(id)?.name })).anonymizedEmail;
    },
  };
}

// ------------------------------------------------------------ completion

export interface ReviewerStats {
  student_id: string;
  assigned_count: number;
  completed_count: number;
  completion_rate: number;
  pending_reviewee_ids: string[];
}

export interface CompletionSummary {
  total_students_enrolled: number;
  students_with_submissions: number;
  total_reviews_assigned: number;
  reviews_completed: number;
  completion_rate_percent: number;
  students_all_complete: number;
  students_partial_complete: number;
  students_none_complete: number;
  reviews_per_student: number | null;
}

export interface CompletionAnalysis {
  summary: CompletionSummary;
  all_complete: ReviewerStats[];
  partial_complete: ReviewerStats[];
  none_complete: ReviewerStats[];
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function analyzeCompletion(
  rows: ReviewRow[],
  studentIds: string[],
  reviewsPerStudent: number | null,
): CompletionAnalysis {
  const stats = new Map<string, ReviewerStats>();
  for (const row of rows) {
    let entry = stats.get(row.reviewer_id);
    if (!entry) {
      entry = {
        student_id: row.reviewer_id,
        assigned_count: 0,
        completed_count: 0,
        completion_rate: 0,
        pending_reviewee_ids: [],
      };
      stats.set(row.reviewer_id, entry);
    }
    entry.assigned_count += 1;
    if (row.status === "completed") entry.completed_count += 1;
    else entry.pending_reviewee_ids.push(row.reviewee_id);
  }

  const groups: Pick<CompletionAnalysis, "all_complete" | "partial_complete" | "none_complete"> = {
    all_complete: [],
    partial_complete: [],
    none_complete: [],
  };
  for (const entry of stats.values()) {
    entry.completion_rate = entry.assigned_count > 0 ? round1((entry.completed_count / entry.assigned_count) * 100) : 0;
    if (entry.completed_count === entry.assigned_count) groups.all_complete.push(entry);
    else if (entry.completed_count === 0) groups.none_complete.push(entry);
    else groups.partial_complete.push(entry);
  }

  const revieweeIds = new Set(rows.map((row) => row.reviewee_id));
  const completed = rows.filter((row) => row.status === "completed").length;
  return {
    summary: {
      total_students_enrolled: studentIds.length,
      students_with_submissions: studentIds.filter((id) => revieweeIds.has(id)).length,
      total_reviews_assigned: rows.length,
      reviews_completed: completed,
      completion_rate_percent: rows.length > 0 ? round1((completed / rows.length) * 100) : 0,
      students_all_complete: groups.all_complete.length,
      students_partial_complete: groups.partial_complete.length,
      students_none_complete: groups.none_complete.length,
      reviews_per_student: reviewsPerStudent,
    },
    ...groups,
  };
}

export function daysSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((now - parsed) / 86_400_000);
}

// --------------------------------------------------------------- comments

export interface ReviewComment {
  row: ReviewRow;
  /** Raw (unscrubbed) text: analytics only. Scrub before it leaves the server. */
  text: string;
  comment_count: number;
  timestamp: string | null;
  word_count: number;
  character_count: number;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Peer-review comments live on the reviewee's submission, authored by the
 * reviewer. Only comments whose author_id is the reviewer are taken, so
 * teacher comments and other reviewers' comments never attach to a review.
 * All of the reviewer's comments on that submission are joined: scoring only
 * the first one under-rates a reviewer who split feedback across comments.
 */
export function extractReviewComments(rows: ReviewRow[], submissions: SubmissionLite[]): ReviewComment[] {
  const bySubmissionId = new Map(submissions.map((submission) => [String(submission.id), submission]));
  const byUserId = new Map(submissions.map((submission) => [String(submission.user_id), submission]));

  return rows.map((row) => {
    const submission =
      (row.submission_id ? bySubmissionId.get(row.submission_id) : undefined) ?? byUserId.get(row.reviewee_id);
    const own = (submission?.submission_comments ?? []).filter(
      (comment) =>
        comment != null &&
        comment.author_id != null &&
        String(comment.author_id) === row.reviewer_id &&
        typeof comment.comment === "string",
    );
    const text = own
      .map((comment) => (comment.comment ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    return {
      row,
      text,
      comment_count: own.length,
      timestamp: own[0]?.created_at ?? null,
      word_count: countWords(text),
      character_count: text.length,
    };
  });
}

/** Reviews worth scoring: completed ones, plus any with text. Unstarted empty reviews would read as "low quality". */
export function analyzableComments(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter((comment) => comment.row.status === "completed" || comment.text.trim() !== "");
}

// ---------------------------------------------------------------- quality

const QUALITY_KEYWORDS = {
  constructive: [
    "suggest", "recommend", "consider", "improve", "enhance", "modify",
    "try", "could", "might", "perhaps", "instead", "alternative",
  ],
  specific: [
    "line", "section", "paragraph", "function", "method", "variable",
    "code", "syntax", "logic", "algorithm", "implementation",
  ],
  generic: [
    "good job", "nice work", "well done", "great", "awesome", "perfect",
    "looks good", "fine", "ok", "okay", "correct",
  ],
  harsh: [
    "terrible", "awful", "wrong", "bad", "horrible", "stupid",
    "useless", "worthless", "garbage", "trash",
  ],
} as const;

export const DEFAULT_GENERIC_PHRASES = ["good job", "nice work", "looks good"];

function countMatches(lower: string, words: readonly string[]): number {
  return words.filter((word) => lower.includes(word)).length;
}

export function isHarsh(text: string): boolean {
  return countMatches(text.toLowerCase(), QUALITY_KEYWORDS.harsh) > 0;
}

/** Heuristic 0–5 score ported from the Python analyzer (substring keyword matching, by design). */
export function qualityScore(text: string): number {
  if (!text || !text.trim()) return 0;
  const lower = text.toLowerCase();
  let score = 2.0;

  const words = countWords(text);
  if (words >= 20) score += 1.0;
  else if (words >= 10) score += 0.5;
  else if (words < 5) score -= 1.0;

  score += Math.min(countMatches(lower, QUALITY_KEYWORDS.constructive) * 0.3, 1.0);
  score += Math.min(countMatches(lower, QUALITY_KEYWORDS.specific) * 0.2, 0.8);
  score -= Math.min(countMatches(lower, QUALITY_KEYWORDS.generic) * 0.4, 1.5);
  score -= countMatches(lower, QUALITY_KEYWORDS.harsh) * 0.5;
  if (text.includes("?")) score += 0.3;

  return Math.max(0, Math.min(5, score));
}

export interface WordCountStats {
  mean: number;
  median: number;
  std_dev: number;
  min: number;
  max: number;
}

export function wordCountStats(counts: number[]): WordCountStats {
  if (counts.length === 0) return { mean: 0, median: 0, std_dev: 0, min: 0, max: 0 };
  const sorted = [...counts].sort((a, b) => a - b);
  const mean = counts.reduce((sum, value) => sum + value, 0) / counts.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  const variance =
    counts.length > 1 ? counts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (counts.length - 1) : 0;
  return {
    mean: round1(mean),
    median,
    std_dev: round1(Math.sqrt(variance)),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

export function constructivenessAnalysis(texts: string[]): {
  constructive_feedback_count: number;
  generic_comments: number;
  specific_suggestions: number;
} {
  let constructive = 0;
  let generic = 0;
  let specific = 0;
  for (const text of texts) {
    const lower = text.toLowerCase();
    if (countMatches(lower, QUALITY_KEYWORDS.constructive) > 0) constructive += 1;
    if (countMatches(lower, QUALITY_KEYWORDS.generic) > 0) generic += 1;
    if (countMatches(lower, QUALITY_KEYWORDS.specific) > 0) specific += 1;
  }
  return { constructive_feedback_count: constructive, generic_comments: generic, specific_suggestions: specific };
}

export function sentimentAnalysis(texts: string[]): {
  positive_sentiment: number;
  neutral_sentiment: number;
  negative_sentiment: number;
} {
  const positiveWords = ["good", "great", "excellent", "nice", "well", "correct", "clear"];
  const negativeWords = ["bad", "wrong", "poor", "unclear", "confusing", "incorrect"];
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const text of texts) {
    const lower = text.toLowerCase();
    const pos = countMatches(lower, positiveWords);
    const neg = countMatches(lower, negativeWords);
    if (pos > neg) positive += 1;
    else if (neg > pos) negative += 1;
    else neutral += 1;
  }
  const total = texts.length;
  const ratio = (count: number): number => (total > 0 ? Math.round((count / total) * 100) / 100 : 0);
  return { positive_sentiment: ratio(positive), neutral_sentiment: ratio(neutral), negative_sentiment: ratio(negative) };
}

export function truncatePreview(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export interface QualityCriteria {
  min_word_count: number;
  low_quality_threshold: number;
  high_quality_threshold: number;
}

export const DEFAULT_QUALITY_CRITERIA: QualityCriteria = {
  min_word_count: 5,
  low_quality_threshold: 2.0,
  high_quality_threshold: 4.0,
};

export interface QualityFlag {
  comment: ReviewComment;
  flag_reason: "low_quality" | "extremely_short";
  quality_score: number;
}

export interface QualityAnalysis {
  overall_analysis: {
    total_reviews_analyzed: number;
    quality_distribution: { high_quality: number; medium_quality: number; low_quality: number };
    average_quality_score: number;
  };
  detailed_metrics: {
    word_count_stats: WordCountStats;
    constructiveness_analysis: ReturnType<typeof constructivenessAnalysis>;
    sentiment_analysis: ReturnType<typeof sentimentAnalysis>;
  };
  flagged: QualityFlag[];
  recommendations: string[];
}

export function analyzeQuality(comments: ReviewComment[], criteria: QualityCriteria): QualityAnalysis {
  const texts = comments.map((comment) => comment.text);
  const scores = comments.map((comment) => qualityScore(comment.text));
  const flagged: QualityFlag[] = [];
  comments.forEach((comment, index) => {
    const score = scores[index]!;
    if (score < criteria.low_quality_threshold || comment.word_count < criteria.min_word_count) {
      flagged.push({
        comment,
        flag_reason: score < criteria.low_quality_threshold ? "low_quality" : "extremely_short",
        quality_score: round1(score),
      });
    }
  });

  const stats = wordCountStats(comments.map((comment) => comment.word_count));
  const constructiveness = constructivenessAnalysis(texts);
  const average = scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;

  const recommendations: string[] = [];
  if (flagged.length > 0) {
    recommendations.push(`${flagged.length} reviews flagged as low quality - may need instructor follow-up`);
  }
  if (stats.mean < 15) {
    recommendations.push("Average comment length is low - consider providing more specific feedback guidelines");
  }
  if (constructiveness.generic_comments > constructiveness.constructive_feedback_count) {
    recommendations.push("Many comments are generic - consider teaching specific feedback techniques");
  }
  if (recommendations.length === 0) recommendations.push("Overall comment quality appears satisfactory");

  return {
    overall_analysis: {
      total_reviews_analyzed: comments.length,
      quality_distribution: {
        high_quality: scores.filter((score) => score >= criteria.high_quality_threshold).length,
        medium_quality: scores.filter(
          (score) => score >= criteria.low_quality_threshold && score < criteria.high_quality_threshold,
        ).length,
        low_quality: scores.filter((score) => score < criteria.low_quality_threshold).length,
      },
      average_quality_score: round1(average),
    },
    detailed_metrics: {
      word_count_stats: stats,
      constructiveness_analysis: constructiveness,
      sentiment_analysis: sentimentAnalysis(texts),
    },
    flagged,
    recommendations,
  };
}

export interface ProblemCriteria {
  min_word_count: number;
  generic_phrases: string[];
  max_quality_score: number;
}

export interface ProblemFlag {
  comment: ReviewComment;
  flags: string[];
  quality_score: number;
}

function normalizeForDuplicate(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function identifyProblems(comments: ReviewComment[], criteria: ProblemCriteria): ProblemFlag[] {
  // Identical non-trivial text from different reviews suggests copy-paste reviewing.
  const textCounts = new Map<string, number>();
  for (const comment of comments) {
    const key = normalizeForDuplicate(comment.text);
    if (countWords(key) >= 3) textCounts.set(key, (textCounts.get(key) ?? 0) + 1);
  }

  const flagged: ProblemFlag[] = [];
  for (const comment of comments) {
    const lower = comment.text.toLowerCase();
    const score = qualityScore(comment.text);
    const flags: string[] = [];
    if (comment.word_count < criteria.min_word_count) flags.push("too_short");
    if (criteria.generic_phrases.some((phrase) => phrase && lower.includes(phrase.toLowerCase()))) {
      flags.push("generic_language");
    }
    if (score <= criteria.max_quality_score) flags.push("low_quality");
    if (isHarsh(comment.text)) flags.push("potentially_harsh");
    if ((textCounts.get(normalizeForDuplicate(comment.text)) ?? 0) > 1) flags.push("duplicate_comment");
    if (flags.length > 0) flagged.push({ comment, flags, quality_score: round1(score) });
  }
  return flagged;
}

// -------------------------------------------------------------------- CSV

const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Neutralize spreadsheet formulas in untrusted text cells (student comments,
 * names). Quoting does not help — the spreadsheet evaluates the parsed cell —
 * so a leading formula marker gets the standard "treat as text" apostrophe.
 * Leading whitespace is looked past because several clients trim it first.
 */
export function csvSafeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!text) return "";
  const stripped = text.replace(/^[ \n\t\r ﻿]+/, "");
  if (FORMULA_PREFIXES.has(text.charAt(0)) || FORMULA_PREFIXES.has(stripped.charAt(0))) return `'${text}`;
  return text;
}

function csvQuote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const render = (cells: ReadonlyArray<string | number | null>): string =>
    cells.map((cell) => csvQuote(cell === null ? "" : String(cell))).join(",");
  return [render(header), ...rows.map(render)].join("\n");
}

// ---------------------------------------------------------------- messages

export const DEFAULT_SUBJECT_PREFIX = "Peer Review Reminder";

export function composeReminder(
  assignment: PeerReviewAssignment,
  options: { customMessage?: string | null; includeLink: boolean; subjectPrefix: string },
): { subject: string; body: string } {
  const name = assignment.name?.trim() || `Assignment ${assignment.id}`;
  let body = options.customMessage
    ? options.customMessage
    : `Hi {first_name},\n\nThis is a reminder that you have incomplete peer reviews for ${name}.\n\n` +
      "Please complete your peer reviews as soon as possible to receive full participation credit.";
  if (options.includeLink && assignment.html_url) {
    body += `\n\nYou can access the assignment here: ${assignment.html_url}`;
  }
  body += "\n\nIf you have any questions or technical issues, please reach out for assistance.";
  return { subject: `${options.subjectPrefix}: ${name}`, body };
}
