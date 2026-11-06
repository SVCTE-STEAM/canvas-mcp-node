import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { buildStaffIdSet, fetchStudentRoster } from "./roster.js";

/**
 * Shared send path for every tool that messages students (send_conversation,
 * send_bulk_messages_from_list, peer-review follow-ups).
 *
 * FERPA design: the model only ever sees pseudonyms, so it cannot write
 * "Hi Maria". Instead it writes "Hi {first_name}" and the real name is
 * substituted HERE, server-side, at send time. Real names never appear in any
 * tool result.
 */

export const PLACEHOLDER_HELP =
  "Use {first_name} or {name} in subject/body to personalize; the real student name is filled in on the teacher's machine at send time and is never shown to the AI.";

const MAX_SUBJECT = 255;
const MAX_BODY = 20_000;
const MAX_RECIPIENTS = 500;

export interface ResolvedRecipient {
  id: string;
  /** What the model may see: a pseudonym for students, real name for staff. */
  display: string;
  role: "student" | "staff";
  realName: string;
}

export interface SendOutcome {
  recipient: string;
  user_id: string;
  ok: boolean;
  conversation_id?: number | null;
  error?: string;
}

export function hasPlaceholders(text: string): boolean {
  return /\{(first_name|name)\}/.test(text);
}

export function personalize(template: string, realName: string): string {
  const trimmed = realName.trim();
  const first = trimmed.split(/\s+/)[0] || "there";
  return template.replace(/\{first_name\}/g, first).replace(/\{name\}/g, trimmed || "there");
}

export function validateOutbound(recipientIds: string[], subject: string, body: string): string | null {
  if (recipientIds.length === 0) return "recipient_ids must contain at least one user id.";
  if (recipientIds.length > MAX_RECIPIENTS) return `At most ${MAX_RECIPIENTS} recipients per call.`;
  if (!subject.trim()) return "subject must not be empty.";
  if (subject.length > MAX_SUBJECT) return `subject must be at most ${MAX_SUBJECT} characters.`;
  if (!body.trim()) return "body must not be empty.";
  if (body.length > MAX_BODY) return `body must be at most ${MAX_BODY} characters.`;
  return null;
}

/**
 * Resolve recipient ids against the course roster. Refuses ids that are not
 * enrolled in the course, so a mistyped or hallucinated id can never message
 * an arbitrary Canvas user.
 */
export async function resolveRecipients(
  canvas: CanvasClient,
  anonymizer: Anonymizer,
  courseId: number,
  recipientIds: Array<string | number>,
): Promise<{ recipients: ResolvedRecipient[]; unknown: string[] }> {
  const [roster, staffIds] = await Promise.all([
    fetchStudentRoster(canvas, courseId),
    buildStaffIdSet(canvas, courseId),
  ]);
  const studentsById = new Map(roster.students.map((s) => [s.id, s.name]));
  const recipients: ResolvedRecipient[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const raw of recipientIds) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (studentsById.has(id)) {
      const realName = studentsById.get(id) ?? "";
      const { pseudonym } = await anonymizer.getOrAllocate(courseId, { id, name: realName, role: "student" });
      recipients.push({ id, display: pseudonym, role: "student", realName });
    } else if (staffIds.has(id)) {
      recipients.push({ id, display: `staff user ${id}`, role: "staff", realName: "" });
    } else {
      unknown.push(id);
    }
  }
  return { recipients, unknown };
}

/**
 * Send one private conversation per recipient. Per-recipient sends are what
 * make {first_name} personalization possible, and they guarantee students
 * never see each other in a shared thread.
 */
export async function sendIndividualMessages(
  canvas: CanvasClient,
  courseId: number,
  recipients: ResolvedRecipient[],
  subject: string,
  body: string,
): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  for (const recipient of recipients) {
    const name = recipient.role === "student" ? recipient.realName : "";
    try {
      const created = await canvas.post<Array<{ id?: number }> | { id?: number }>("/api/v1/conversations", {
        recipients: [recipient.id],
        subject: personalize(subject, name),
        body: personalize(body, name),
        context_code: `course_${courseId}`,
        group_conversation: false,
        force_new: true,
        mode: "sync",
      });
      const first = Array.isArray(created) ? created[0] : created;
      outcomes.push({ recipient: recipient.display, user_id: recipient.id, ok: true, conversation_id: first?.id ?? null });
    } catch (error) {
      outcomes.push({
        recipient: recipient.display,
        user_id: recipient.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
