import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { CanvasApiError } from "../types.js";
import { DEANON_DENIED_NOTE, resolveAnonymous } from "../featureFlags.js";
import { jsonResult, safeHandler, type McpTextResult } from "./toolHelpers.js";
import { CONFIRMATION_TOKEN_PARAM, consumeConfirmationToken, previewResult } from "./confirmGate.js";
import {
  PLACEHOLDER_HELP,
  hasPlaceholders,
  resolveRecipients,
  sendIndividualMessages,
  validateOutbound,
  type ResolvedRecipient,
  type SendOutcome,
} from "./messagingShared.js";
import {
  buildCourseScrubber,
  buildNameScrubber,
  type CourseScrubber,
  type NameReplacement,
} from "./discussionAnonymizer.js";

export const CONVERSATION_SCRUB_NOTE =
  "Conversation participants who are not course staff (or you) are pseudonymized, and roster/participant " +
  "names are scrubbed from subjects and message text on a best-effort basis: nicknames, misspellings, or " +
  "indirect references may survive, and substitutions may alter quoted text.";

export const NO_COURSE_CONTEXT_NOTE =
  "Some conversations have no course context (context_code is not course_<id>), so staff could not be " +
  "identified: every participant other than you was pseudonymized under the account-wide scope (those " +
  "'Student N' labels are not the course's numbering), and only participant names were scrubbed from text.";

const UNKNOWN_PARTICIPANT = "Unknown participant";
/** Same synthetic scope list_account_users uses for users with no course context. */
const ACCOUNT_SCOPE_ID = 0;
const MAX_BULK_ROWS = 500;
const MAX_MARK_READ = 500;
const NUMERIC_ID = /^\d+$/;
const COURSE_CONTEXT = /^course_(\d+)$/;
const LIST_SCOPES = ["unread", "starred", "sent", "archived", "inbox", "all"] as const;
const DEFAULT_LIST_LIMIT = 20;

const ID = z.union([z.string(), z.number()]);

const SEND_CONVERSATION_INPUT = {
  course_identifier: ID.describe("Course code or numeric Canvas id. Every recipient must be enrolled in this course."),
  recipient_ids: z
    .array(ID)
    .describe("Real Canvas user ids (the user_id values tools return), never pseudonyms. Max 500. Each recipient gets a separate private message."),
  subject: z.string().describe(`Subject, max 255 characters. ${PLACEHOLDER_HELP}`),
  body: z.string().describe(`Message body (plain text). ${PLACEHOLDER_HELP}`),
  confirmation_token: CONFIRMATION_TOKEN_PARAM,
};

const SEND_BULK_INPUT = {
  course_identifier: ID.describe("Course code or numeric Canvas id. Every user_id must be enrolled in this course."),
  messages: z
    .array(
      z.object({
        user_id: ID.describe("Real Canvas user id (not a pseudonym)."),
        subject: z.string().describe("Subject for this recipient, max 255 characters."),
        body: z.string().describe("Body for this recipient."),
      }),
    )
    .describe(`One row per recipient (max 500, one row per user). ${PLACEHOLDER_HELP}`),
  confirmation_token: CONFIRMATION_TOKEN_PARAM,
};

const LIST_CONVERSATIONS_INPUT = {
  scope: z
    .enum(LIST_SCOPES)
    .optional()
    .describe("unread (default), starred, sent, archived, or inbox/all (the normal inbox)."),
  course_identifier: ID.optional().describe("Only conversations in this course (code or numeric id)."),
  limit: z.number().int().min(1).max(100).optional().describe("Max conversations to return (1-100, default 20)."),
  anonymous: z
    .boolean()
    .optional()
    .describe("When true (default), non-staff participants are pseudonymized and names scrubbed from previews. Override only takes effect with CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server."),
};

const GET_CONVERSATION_DETAILS_INPUT = {
  conversation_id: ID.describe("Numeric Canvas conversation id."),
  include_messages: z.boolean().optional().describe("Include the message thread (default true)."),
  anonymous: z
    .boolean()
    .optional()
    .describe("When true (default), non-staff participants are pseudonymized and names scrubbed from message text. Override only takes effect with CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server."),
};

const MARK_CONVERSATIONS_READ_INPUT = {
  conversation_ids: z.array(ID).describe("Numeric Canvas conversation ids to mark read (max 500)."),
};

type SendConversationArgs = z.infer<z.ZodObject<typeof SEND_CONVERSATION_INPUT>>;
type SendBulkArgs = z.infer<z.ZodObject<typeof SEND_BULK_INPUT>>;
type ListConversationsArgs = z.infer<z.ZodObject<typeof LIST_CONVERSATIONS_INPUT>>;
type GetConversationDetailsArgs = z.infer<z.ZodObject<typeof GET_CONVERSATION_DETAILS_INPUT>>;
type MarkConversationsReadArgs = z.infer<z.ZodObject<typeof MARK_CONVERSATIONS_READ_INPUT>>;

interface CanvasConversationParticipant {
  id?: number | string | null;
  name?: string | null;
  full_name?: string | null;
}

interface CanvasConversationAttachment {
  id?: number | string;
  display_name?: string | null;
  filename?: string | null;
  content_type?: string | null;
  size?: number | null;
}

interface CanvasConversationMessage {
  id?: number | string;
  created_at?: string | null;
  body?: string | null;
  author_id?: number | string | null;
  generated?: boolean;
  attachments?: CanvasConversationAttachment[] | null;
  forwarded_messages?: CanvasConversationMessage[] | null;
}

interface CanvasConversation {
  id: number | string;
  subject?: string | null;
  workflow_state?: string | null;
  last_message?: string | null;
  last_message_at?: string | null;
  message_count?: number | null;
  starred?: boolean | null;
  context_code?: string | null;
  context_name?: string | null;
  participants?: CanvasConversationParticipant[] | null;
  messages?: CanvasConversationMessage[] | null;
}

function validationError(tool: string, message: string): CanvasApiError {
  return new CanvasApiError({ code: "VALIDATION", message: `${tool}: ${message}` });
}

function courseLabel(canvas: CanvasClient, courseId: number): string {
  return canvas.getCachedCourseCode(courseId) ?? `course ${courseId}`;
}

function courseIdFromContext(contextCode: string | null | undefined): number | null {
  const match = typeof contextCode === "string" ? contextCode.match(COURSE_CONTEXT) : null;
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function sendReport(
  tool: string,
  canvas: CanvasClient,
  courseId: number,
  outcomes: SendOutcome[],
): McpTextResult {
  const sent = outcomes.filter((outcome) => outcome.ok).length;
  const failed = outcomes.length - sent;
  return jsonResult(
    {
      course_id: courseId,
      course_code: canvas.getCachedCourseCode(courseId) ?? null,
      sent,
      failed,
      results: outcomes,
    },
    {
      summary:
        `${tool}: sent ${sent} of ${outcomes.length} private message(s) in ${courseLabel(canvas, courseId)}` +
        (failed > 0 ? `; ${failed} FAILED (see results).` : "."),
    },
  );
}

function unknownRecipientsError(tool: string, canvas: CanvasClient, courseId: number, unknown: string[]): CanvasApiError {
  return validationError(
    tool,
    `Nothing was sent. ${unknown.length} recipient id(s) are not students or staff enrolled in ` +
      `${courseLabel(canvas, courseId)}: ${unknown.join(", ")}. Use real Canvas user ids from this course's roster.`,
  );
}

const PERSONALIZATION_NOTE =
  "{first_name}/{name} are filled with each student's real name at send time; this preview intentionally shows the template, not real names.";

// ---------------------------------------------------------------------------
// Reading: participant pseudonymization + free-text scrub
// ---------------------------------------------------------------------------

interface Redaction {
  courseId: number | null;
  nameFor: (userId: unknown) => string | null;
  scrub: (text: string) => string;
  /** Group/user context names can be student-authored; course names are not. */
  scrubContextName: boolean;
}

function passthroughRedaction(conversation: CanvasConversation): Redaction {
  const names = new Map<string, string | null>();
  for (const participant of conversation.participants ?? []) {
    if (participant?.id === undefined || participant.id === null) continue;
    names.set(String(participant.id), participant.name ?? participant.full_name ?? null);
  }
  return {
    courseId: courseIdFromContext(conversation.context_code),
    nameFor: (userId) => (userId === undefined || userId === null ? null : names.get(String(userId)) ?? null),
    scrub: (text) => text,
    scrubContextName: false,
  };
}

/**
 * Per-invocation redactor. Staff classification comes from the conversation's
 * course roster (participant objects carry no role data), so a conversation
 * without a course_<id> context cannot tell a teacher from a student and
 * pseudonymizes every participant but the caller (fail closed). Roster
 * scrubbers are cached per course for one call only — a stale roster is a
 * FERPA leak vector.
 */
class ConversationRedactor {
  private readonly scrubbers = new Map<number, CourseScrubber>();
  readonly warnings = new Set<string>();

  constructor(
    private readonly canvas: CanvasClient,
    private readonly anonymizer: Anonymizer,
    private readonly selfId: string | null,
  ) {}

  private async courseScrubber(courseId: number): Promise<CourseScrubber> {
    const cached = this.scrubbers.get(courseId);
    if (cached) return cached;
    const scrubber = await buildCourseScrubber({ canvas: this.canvas, anonymizer: this.anonymizer }, courseId);
    this.scrubbers.set(courseId, scrubber);
    return scrubber;
  }

  async forConversation(conversation: CanvasConversation): Promise<Redaction> {
    this.warnings.add(CONVERSATION_SCRUB_NOTE);
    const courseId = courseIdFromContext(conversation.context_code);
    let staffIds = new Set<string>();
    let courseScrub: ((text: string) => string) | null = null;
    if (courseId !== null) {
      const scrubber = await this.courseScrubber(courseId);
      staffIds = scrubber.staffIdSet;
      courseScrub = scrubber.scrub;
      for (const warning of scrubber.warnings) this.warnings.add(warning);
    } else {
      this.warnings.add(NO_COURSE_CONTEXT_NOTE);
    }
    const scope = courseId ?? ACCOUNT_SCOPE_ID;

    const names = new Map<string, string | null>();
    const replacements: NameReplacement[] = [];
    for (const participant of conversation.participants ?? []) {
      if (participant?.id === undefined || participant.id === null) continue;
      const id = String(participant.id);
      const realName = participant.name ?? participant.full_name ?? null;
      if (id === this.selfId || staffIds.has(id)) {
        names.set(id, realName);
        continue;
      }
      const { pseudonym } = await this.anonymizer.getOrAllocate(scope, {
        id,
        name: realName ?? undefined,
        role: "student",
      });
      names.set(id, pseudonym);
      for (const candidate of [participant.name, participant.full_name]) {
        if (typeof candidate === "string" && candidate.trim()) replacements.push({ name: candidate, pseudonym });
      }
    }
    const participantScrub = buildNameScrubber(replacements);

    return {
      courseId,
      // Unknown authors (left the thread, forwarded from elsewhere) get no
      // name rather than a guess.
      nameFor: (userId) => (userId === undefined || userId === null ? null : names.get(String(userId)) ?? null),
      scrub: (text) => participantScrub(courseScrub ? courseScrub(text) : text),
      scrubContextName: courseId === null,
    };
  }
}

async function fetchSelfId(canvas: CanvasClient): Promise<string | null> {
  const self = await canvas.get<{ id?: number | string }>("/api/v1/users/self");
  return self?.id === undefined || self.id === null ? null : String(self.id);
}

function scrubOrNull(value: string | null | undefined, redaction: Redaction): string | null {
  return typeof value === "string" ? redaction.scrub(value) : null;
}

function displayParticipants(
  participants: CanvasConversationParticipant[] | null | undefined,
  redaction: Redaction,
): Array<{ id: number | string | null; name: string | null }> {
  return (participants ?? []).map((participant) => {
    const id = participant?.id ?? null;
    return { id, name: id === null ? UNKNOWN_PARTICIPANT : redaction.nameFor(id) };
  });
}

function displayMessage(message: CanvasConversationMessage, redaction: Redaction): Record<string, unknown> {
  const display: Record<string, unknown> = {
    id: message.id ?? null,
    created_at: message.created_at ?? null,
    author_id: message.author_id ?? null,
    author_name: redaction.nameFor(message.author_id),
    body: scrubOrNull(message.body, redaction),
  };
  if (message.generated) display.generated = true;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length > 0) {
    display.attachments = attachments.map((attachment) => ({
      id: attachment?.id ?? null,
      display_name: scrubOrNull(attachment?.display_name ?? attachment?.filename, redaction),
      content_type: attachment?.content_type ?? null,
      size: attachment?.size ?? null,
    }));
  }
  const forwarded = Array.isArray(message.forwarded_messages) ? message.forwarded_messages : [];
  if (forwarded.length > 0) {
    display.forwarded_messages = forwarded.map((inner) => displayMessage(inner, redaction));
  }
  return display;
}

function displayConversationHeader(
  conversation: CanvasConversation,
  redaction: Redaction,
  canvas: CanvasClient,
): Record<string, unknown> {
  return {
    id: conversation.id,
    subject: scrubOrNull(conversation.subject, redaction),
    workflow_state: conversation.workflow_state ?? null,
    message_count: conversation.message_count ?? null,
    starred: conversation.starred ?? false,
    context_code: conversation.context_code ?? null,
    context_name: redaction.scrubContextName
      ? scrubOrNull(conversation.context_name, redaction)
      : conversation.context_name ?? null,
    course_code: redaction.courseId !== null ? canvas.getCachedCourseCode(redaction.courseId) ?? null : null,
    participants: displayParticipants(conversation.participants, redaction),
  };
}

export function registerMessagingTools(
  server: McpServer,
  canvas: CanvasClient,
  anonymizer: Anonymizer,
): void {
  server.registerTool(
    "send_conversation",
    {
      description:
        "Send a Canvas Inbox message to students/staff in a course. Each recipient gets their own private conversation (students never see each other). " +
        "TWO-STEP: the first call (no confirmation_token) only returns a PREVIEW (recipients as pseudonyms, subject/body) plus a token; nothing is sent. " +
        "Show the preview to the teacher and only after approval call again with identical arguments plus confirmation_token. " +
        `Recipient ids not enrolled in the course are refused. ${PLACEHOLDER_HELP}`,
      inputSchema: SEND_CONVERSATION_INPUT,
    },
    async (input) => {
      const args = input as SendConversationArgs;
      const tool = "send_conversation";
      return safeHandler(tool, async () => {
        const recipientIds = (args.recipient_ids ?? []).map((id) => String(id).trim());
        const subject = args.subject ?? "";
        const body = args.body ?? "";
        const invalid = validateOutbound(recipientIds, subject, body);
        if (invalid) throw validationError(tool, `Nothing was sent. ${invalid}`);

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const { recipients, unknown } = await resolveRecipients(canvas, anonymizer, courseId, recipientIds);
        if (unknown.length > 0) throw unknownRecipientsError(tool, canvas, courseId, unknown);

        if (!args.confirmation_token) {
          const personalized = hasPlaceholders(subject) || hasPlaceholders(body);
          return previewResult(
            tool,
            args as Record<string, unknown>,
            {
              course_id: courseId,
              course_code: canvas.getCachedCourseCode(courseId) ?? null,
              delivery: "One private Canvas Inbox conversation per recipient.",
              recipient_count: recipients.length,
              recipients: recipients.map((recipient) => ({ user_id: recipient.id, recipient: recipient.display })),
              subject,
              body,
              personalized,
              ...(personalized ? { personalization_note: PERSONALIZATION_NOTE } : {}),
            },
            `Would send ${recipients.length} private message(s) in ${courseLabel(canvas, courseId)}.`,
          );
        }

        const consumed = consumeConfirmationToken(tool, args as Record<string, unknown>, args.confirmation_token);
        if (!consumed.ok) throw validationError(tool, `Nothing was sent. ${consumed.reason}`);

        const outcomes = await sendIndividualMessages(canvas, courseId, recipients, subject, body);
        return sendReport(tool, canvas, courseId, outcomes);
      });
    },
  );

  server.registerTool(
    "send_bulk_messages_from_list",
    {
      description:
        "Send a different private Canvas Inbox message to each student in a course, one row per recipient ({user_id, subject, body}). " +
        "TWO-STEP: the first call (no confirmation_token) returns a PREVIEW of every row (recipients as pseudonyms) plus a token; nothing is sent. " +
        "Show it to the teacher and only after approval call again with identical arguments plus confirmation_token. " +
        `Rows whose user_id is not enrolled in the course, duplicated, or invalid refuse the whole batch. ${PLACEHOLDER_HELP}`,
      inputSchema: SEND_BULK_INPUT,
    },
    async (input) => {
      const args = input as SendBulkArgs;
      const tool = "send_bulk_messages_from_list";
      return safeHandler(tool, async () => {
        const rows = Array.isArray(args.messages) ? args.messages : [];
        if (rows.length === 0) throw validationError(tool, "Nothing was sent. messages must contain at least one row.");
        if (rows.length > MAX_BULK_ROWS) {
          throw validationError(tool, `Nothing was sent. At most ${MAX_BULK_ROWS} rows per call (got ${rows.length}).`);
        }

        // Validate every row before any token exists: a bad later row must
        // fail the preview, not fire mid-batch after earlier rows went out.
        const invalidRows: string[] = [];
        const seen = new Set<string>();
        const userIds: string[] = [];
        rows.forEach((row, index) => {
          const userId = String(row?.user_id ?? "").trim();
          userIds.push(userId);
          let problem: string | null = null;
          if (!NUMERIC_ID.test(userId)) problem = "user_id must be a plain numeric Canvas user id.";
          else if (seen.has(userId)) problem = "user_id appears in more than one row.";
          else problem = validateOutbound([userId], row?.subject ?? "", row?.body ?? "");
          seen.add(userId);
          if (problem) invalidRows.push(`row ${index} (user_id ${userId || "<empty>"}): ${problem}`);
        });
        if (invalidRows.length > 0) {
          throw validationError(
            tool,
            `Nothing was sent. ${invalidRows.length} row(s) are invalid; fix them and preview again. ${invalidRows.join(" ")}`,
          );
        }

        const courseId = await canvas.resolveCourseId(args.course_identifier, { bypassCache: true });
        const { recipients, unknown } = await resolveRecipients(canvas, anonymizer, courseId, userIds);
        if (unknown.length > 0) throw unknownRecipientsError(tool, canvas, courseId, unknown);
        const recipientById = new Map<string, ResolvedRecipient>(recipients.map((recipient) => [recipient.id, recipient]));

        if (!args.confirmation_token) {
          const personalized = rows.some((row) => hasPlaceholders(row.subject) || hasPlaceholders(row.body));
          return previewResult(
            tool,
            args as Record<string, unknown>,
            {
              course_id: courseId,
              course_code: canvas.getCachedCourseCode(courseId) ?? null,
              delivery: "One private Canvas Inbox conversation per row.",
              message_count: rows.length,
              messages: rows.map((row, index) => ({
                row: index,
                user_id: userIds[index],
                recipient: recipientById.get(userIds[index]!)?.display ?? null,
                subject: row.subject,
                body: row.body,
              })),
              personalized,
              ...(personalized ? { personalization_note: PERSONALIZATION_NOTE } : {}),
            },
            `Would send ${rows.length} individually-written private message(s) in ${courseLabel(canvas, courseId)}.`,
          );
        }

        const consumed = consumeConfirmationToken(tool, args as Record<string, unknown>, args.confirmation_token);
        if (!consumed.ok) throw validationError(tool, `Nothing was sent. ${consumed.reason}`);

        const outcomes: SendOutcome[] = [];
        for (const [index, row] of rows.entries()) {
          const recipient = recipientById.get(userIds[index]!)!;
          const [outcome] = await sendIndividualMessages(canvas, courseId, [recipient], row.subject, row.body);
          if (outcome) outcomes.push(outcome);
        }
        return sendReport(tool, canvas, courseId, outcomes);
      });
    },
  );

  server.registerTool(
    "list_conversations",
    {
      description:
        "List the teacher's Canvas Inbox conversations (one page, newest first; more_available says whether Canvas has more). " +
        "Returns id, subject, last_message preview, workflow_state, course_code, and participants. Non-staff participants are pseudonymized and names scrubbed from subjects/previews by default (FERPA gate).",
      inputSchema: LIST_CONVERSATIONS_INPUT,
    },
    async (input) => {
      const args = input as ListConversationsArgs;
      const tool = "list_conversations";
      return safeHandler(tool, async () => {
        const scope = args.scope ?? "unread";
        if (!(LIST_SCOPES as readonly string[]).includes(scope)) {
          throw validationError(tool, `scope must be one of: ${LIST_SCOPES.join(", ")}.`);
        }
        const limit = Math.min(100, Math.max(1, Math.trunc(args.limit ?? DEFAULT_LIST_LIMIT)));
        const params: Record<string, unknown> = {};
        if (scope !== "inbox" && scope !== "all") params.scope = scope;
        let filterCourseId: number | null = null;
        if (args.course_identifier !== undefined && String(args.course_identifier).trim() !== "") {
          filterCourseId = await canvas.resolveCourseId(args.course_identifier);
          params["filter[]"] = [`course_${filterCourseId}`];
        }

        // One page on purpose: the inbox can be huge. The next-link is
        // reported, not followed, so a partial page is never passed off as
        // the whole inbox.
        const { items, truncated } = await canvas.getPaginated<CanvasConversation>("/api/v1/conversations", {
          params,
          perPage: limit,
          maxPages: 1,
        });
        const conversations = items.slice(0, limit);

        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const warnings = new Set<string>();
        if (overridden) warnings.add(DEANON_DENIED_NOTE);
        const redactor =
          anonymous && conversations.length > 0
            ? new ConversationRedactor(canvas, anonymizer, await fetchSelfId(canvas))
            : null;

        const display: Record<string, unknown>[] = [];
        for (const conversation of conversations) {
          const redaction = redactor ? await redactor.forConversation(conversation) : passthroughRedaction(conversation);
          const header = displayConversationHeader(conversation, redaction, canvas);
          display.push({
            ...header,
            last_message: scrubOrNull(conversation.last_message, redaction),
            last_message_at: conversation.last_message_at ?? null,
          });
        }
        for (const warning of redactor?.warnings ?? []) warnings.add(warning);

        return jsonResult(
          {
            scope,
            course_id: filterCourseId,
            returned: display.length,
            more_available: truncated,
            anonymized: anonymous,
            ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
            conversations: display,
          },
          {
            summary:
              `${display.length} ${scope} conversation(s)${truncated ? " (more available)" : ""}${anonymous ? " (anonymized)" : ""}.` +
              (overridden ? ` [override: ${DEANON_DENIED_NOTE}]` : ""),
          },
        );
      });
    },
  );

  server.registerTool(
    "get_conversation_details",
    {
      description:
        "Fetch one Canvas Inbox conversation with its messages. Viewing never marks it read (use mark_conversations_read). " +
        "Non-staff participants are pseudonymized and names scrubbed from subject and message bodies by default (FERPA gate).",
      inputSchema: GET_CONVERSATION_DETAILS_INPUT,
    },
    async (input) => {
      const args = input as GetConversationDetailsArgs;
      const tool = "get_conversation_details";
      return safeHandler(tool, async () => {
        const conversationId = String(args.conversation_id ?? "").trim();
        if (!NUMERIC_ID.test(conversationId)) {
          throw validationError(tool, `conversation_id must be a numeric Canvas id (got "${conversationId}").`);
        }
        const includeMessages = args.include_messages !== false;

        // Canvas marks a conversation read on GET unless told not to; a read
        // tool must change nothing.
        const conversation = await canvas.get<CanvasConversation>(`/api/v1/conversations/${conversationId}`, {
          params: { auto_mark_as_read: false },
        });

        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const warnings = new Set<string>();
        if (overridden) warnings.add(DEANON_DENIED_NOTE);
        let redaction: Redaction;
        if (anonymous) {
          const redactor = new ConversationRedactor(canvas, anonymizer, await fetchSelfId(canvas));
          redaction = await redactor.forConversation(conversation);
          for (const warning of redactor.warnings) warnings.add(warning);
        } else {
          redaction = passthroughRedaction(conversation);
        }

        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        const payload: Record<string, unknown> = {
          ...displayConversationHeader(conversation, redaction, canvas),
          anonymized: anonymous,
          ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
        };
        if (includeMessages) payload.messages = messages.map((message) => displayMessage(message, redaction));

        return jsonResult(payload, {
          summary:
            `Conversation ${conversation.id}: ${messages.length} message(s)${includeMessages ? "" : " (not included)"}${anonymous ? " (anonymized)" : ""}.` +
            (overridden ? ` [override: ${DEANON_DENIED_NOTE}]` : ""),
        });
      });
    },
  );

  server.registerTool(
    "get_unread_count",
    {
      description: "Number of unread conversations in the teacher's Canvas Inbox.",
      inputSchema: {},
    },
    async () =>
      safeHandler("get_unread_count", async () => {
        const response = await canvas.get<{ unread_count?: number | string }>("/api/v1/conversations/unread_count");
        // Canvas serializes this count as a string.
        const parsed = Number(response?.unread_count ?? 0);
        const unreadCount = Number.isFinite(parsed) ? parsed : 0;
        return jsonResult({ unread_count: unreadCount }, { summary: `${unreadCount} unread conversation(s).` });
      }),
  );

  server.registerTool(
    "mark_conversations_read",
    {
      description:
        "Mark Canvas Inbox conversations as read (affects only the teacher's own inbox). Canvas applies the change asynchronously and returns a progress record.",
      inputSchema: MARK_CONVERSATIONS_READ_INPUT,
    },
    async (input) => {
      const args = input as MarkConversationsReadArgs;
      const tool = "mark_conversations_read";
      return safeHandler(tool, async () => {
        const ids = [...new Set((args.conversation_ids ?? []).map((id) => String(id).trim()))];
        if (ids.length === 0) throw validationError(tool, "conversation_ids must contain at least one id.");
        if (ids.length > MAX_MARK_READ) throw validationError(tool, `At most ${MAX_MARK_READ} conversation ids per call.`);
        const bad = ids.filter((id) => !NUMERIC_ID.test(id));
        if (bad.length > 0) throw validationError(tool, `conversation ids must be numeric (invalid: ${bad.join(", ")}).`);

        const progress = await canvas.put<{ id?: number; workflow_state?: string; url?: string } | null>(
          "/api/v1/conversations",
          { conversation_ids: ids, event: "mark_as_read" },
        );
        return jsonResult(
          {
            marked_read: ids.length,
            conversation_ids: ids,
            progress: progress
              ? { id: progress.id ?? null, workflow_state: progress.workflow_state ?? null }
              : null,
          },
          { summary: `Requested mark-as-read for ${ids.length} conversation(s).` },
        );
      });
    },
  );
}
