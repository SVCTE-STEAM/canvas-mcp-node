import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CanvasClient } from "../canvasClient.js";
import type { Anonymizer } from "../anonymizer.js";
import { CanvasApiError } from "../types.js";
import { DEANON_DENIED_NOTE, resolveAnonymous } from "../featureFlags.js";
import { jsonResult, safeHandler } from "./toolHelpers.js";
import { buildCourseScrubber, type CourseScrubber } from "./discussionAnonymizer.js";

export const GROUP_NAME_SCRUB_NOTE =
  "Group names are scrubbed of roster names on a best-effort basis (self-signup groups are named by students); " +
  "nicknames or misspellings may survive.";

const LIST_GROUPS_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  anonymous: z
    .boolean()
    .optional()
    .describe(
      "When true (default), student members are pseudonymized and roster names are scrubbed from group names. Override only takes effect when CANVAS_MCP_ALLOW_DEANONYMIZE=true on the server.",
    ),
};

const CHECK_ENROLLMENT_INPUT = {
  course_identifier: z.union([z.string(), z.number()]),
  net_id: z
    .string()
    .describe(
      "The person's campus login id (NetID, uniqname, campus id, or email-style Canvas login). Matched against login_id then sis_user_id; 'jdoe' and 'jdoe@school.edu' are treated as the same identifier. Not a display name.",
    ),
  role: z
    .enum(["student", "teacher", "ta", "observer", "designer", "any"])
    .optional()
    .describe("Enrollment type that satisfies the check (default student). A NO is scoped to this role and names any other role held."),
  active_only: z.boolean().optional().describe("Count only active enrollments (default true)."),
};

interface CanvasGroup {
  id: number;
  name?: string | null;
  group_category_id?: number | null;
  members_count?: number | null;
}

interface CanvasGroupMember {
  id: number | string;
  name?: string;
  [key: string]: unknown;
}

interface EnrollmentUser {
  id?: number | string;
  login_id?: string | null;
  sis_user_id?: string | null;
}

interface CanvasEnrollment {
  id?: number;
  type?: string;
  enrollment_state?: string;
  user?: EnrollmentUser | null;
}

const ROLE_TO_TYPE: Record<string, string> = {
  student: "StudentEnrollment",
  teacher: "TeacherEnrollment",
  ta: "TaEnrollment",
  observer: "ObserverEnrollment",
  designer: "DesignerEnrollment",
};

// An injection guard on the value before it reaches matching, not a validity
// check: '@' and 254 chars because many instances provision email-style logins.
const NET_ID_PATTERN = /^[A-Za-z0-9._@+-]{1,254}$/;
const ID_FIELDS = ["login_id", "sis_user_id"] as const;
type IdField = (typeof ID_FIELDS)[number];

function norm(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function localPart(value: string): string {
  const at = value.indexOf("@");
  return at >= 0 ? value.slice(0, at) : value;
}

/**
 * Which identifier field of `user` matches the needle by email local part, or
 * "unverifiable" when a qualified needle meets only bare ids (any domain would
 * match equally, so a match would let an unverified domain authorize an
 * identity). Evaluated per user: a user carrying a different qualified id is
 * a different person, and their bare sis_user_id must not match back in.
 */
function localPartField(user: EnrollmentUser, needle: string, needleLocal: string): IdField | "unverifiable" | null {
  const stored: Partial<Record<IdField, string>> = {};
  for (const field of ID_FIELDS) {
    const value = norm(user[field]);
    if (value) stored[field] = value;
  }
  const values = Object.values(stored);
  if (values.length === 0) return null;
  if (needle.includes("@")) {
    if (values.some((value) => value.includes("@"))) return null;
    return values.some((value) => localPart(value) === needleLocal) ? "unverifiable" : null;
  }
  for (const field of ID_FIELDS) {
    const value = stored[field];
    if (value && localPart(value) === needleLocal) return field;
  }
  return null;
}

type MatchOutcome =
  | { kind: "match"; enrollment: CanvasEnrollment; field: IdField; exact: boolean }
  | { kind: "none" }
  | { kind: "ambiguous"; detail: string };

/**
 * Exact equality across the whole roster first, so an exact hit is never
 * spoiled by local-part noise; then the local-part fallback, which must
 * identify exactly one person (several enrollments of one user are fine).
 */
function matchEnrollment(enrollments: CanvasEnrollment[], netId: string, activeOnly: boolean): MatchOutcome {
  const needle = norm(netId);
  if (!needle) return { kind: "none" };
  const needleLocal = localPart(needle);
  const candidates = enrollments.filter((enrollment) => !(activeOnly && enrollment.enrollment_state !== "active"));

  for (const enrollment of candidates) {
    const user = enrollment.user ?? {};
    for (const field of ID_FIELDS) {
      const stored = norm(user[field]);
      if (stored && stored === needle) return { kind: "match", enrollment, field, exact: true };
    }
  }

  const hits: Array<{ enrollment: CanvasEnrollment; field: IdField }> = [];
  const seen = new Set<unknown>();
  let unverifiable = false;
  for (const enrollment of candidates) {
    const user = enrollment.user ?? {};
    const field = localPartField(user, needle, needleLocal);
    if (field === "unverifiable") {
      unverifiable = true;
      continue;
    }
    if (field === null) continue;
    const key = user.id !== undefined && user.id !== null ? `id:${user.id}` : enrollment;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ enrollment, field });
  }

  if (hits.length > 1) {
    return {
      kind: "ambiguous",
      detail:
        `'${netId}' matches ${hits.length} different people on this roster by email local part alone. ` +
        "Supply the full login id (including the domain, if the institution uses email-style logins).",
    };
  }
  if (hits.length === 1) return { kind: "match", enrollment: hits[0]!.enrollment, field: hits[0]!.field, exact: false };
  if (unverifiable) {
    return {
      kind: "ambiguous",
      detail:
        `This course stores bare login ids, so nothing on the roster can confirm that '${netId}' is the person holding ` +
        `'${needleLocal}' — any domain would match equally. Re-run with just '${needleLocal}'.`,
    };
  }
  return { kind: "none" };
}

function exposesIdentifier(user: EnrollmentUser | null | undefined): boolean {
  if (!user) return false;
  return ID_FIELDS.some((field) => typeof user[field] === "string" && user[field]!.trim() !== "");
}

export function registerGroupTools(server: McpServer, canvas: CanvasClient, anonymizer: Anonymizer): void {
  server.registerTool(
    "list_groups",
    {
      description:
        "List a course's groups with their members (id + name). Student members are pseudonymized by default (FERPA gate) with the same per-course pseudonyms as list_users; " +
        "staff keep their names; roster names are scrubbed from group names. Emails are not returned.",
      inputSchema: LIST_GROUPS_INPUT,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof LIST_GROUPS_INPUT>>;
      return safeHandler("list_groups", async () => {
        const courseId = await canvas.resolveCourseId(args.course_identifier);
        const { anonymous, overridden } = resolveAnonymous(args.anonymous);
        const { items: groups, truncated, pages } = await canvas.getPaginated<CanvasGroup>(
          `/api/v1/courses/${courseId}/groups`,
        );

        const warnings: string[] = [];
        if (overridden) warnings.push(DEANON_DENIED_NOTE);

        let scrubber: CourseScrubber | null = null;
        if (anonymous && groups.length > 0) {
          scrubber = await buildCourseScrubber({ canvas, anonymizer }, courseId);
          warnings.push(GROUP_NAME_SCRUB_NOTE, ...scrubber.warnings);
        }

        const display: Array<Record<string, unknown>> = [];
        let memberTotal = 0;
        for (const group of groups) {
          const row: Record<string, unknown> = {
            id: group.id,
            name: scrubber && typeof group.name === "string" ? scrubber.scrub(group.name) : (group.name ?? null),
            group_category_id: group.group_category_id ?? null,
            members_count: group.members_count ?? null,
          };
          try {
            const { items: members, truncated: membersTruncated } = await canvas.getPaginated<CanvasGroupMember>(
              `/api/v1/groups/${group.id}/users`,
            );
            const shown: Array<{ id: number | string; name: string | null }> = [];
            for (const member of members) {
              if (scrubber && !scrubber.staffIdSet.has(String(member.id))) {
                // Group member payloads carry no role, so anonymizeUser's
                // unknown→student default applies: fail closed.
                const anonymized = await anonymizer.anonymizeUser(courseId, member);
                shown.push({ id: member.id, name: anonymized.name ?? null });
              } else {
                shown.push({ id: member.id, name: member.name ?? null });
              }
            }
            row.members = shown;
            if (membersTruncated) row.members_truncated = true;
            memberTotal += shown.length;
          } catch (error) {
            row.members = null;
            row.members_error = error instanceof Error ? error.message : String(error);
          }
          display.push(row);
        }

        const uniqueWarnings = [...new Set(warnings)];
        const label = canvas.getCachedCourseCode(courseId) ?? String(courseId);
        return jsonResult(
          {
            course_id: courseId,
            course_code: canvas.getCachedCourseCode(courseId) ?? null,
            group_count: groups.length,
            pages,
            truncated,
            anonymized: anonymous,
            ...(uniqueWarnings.length > 0 ? { warnings: uniqueWarnings } : {}),
            groups: display,
          },
          {
            summary:
              groups.length === 0
                ? `Course ${label}: no groups.`
                : `Course ${label}: ${groups.length} group(s), ${memberTotal} membership(s)${anonymous ? " (anonymized)" : ""}.`,
          },
        );
      });
    },
  );

  server.registerTool(
    "check_enrollment",
    {
      description:
        "Answer whether ONE externally supplied login id (NetID/uniqname/email-style login) is enrolled in a course: YES / NO / AMBIGUOUS / INDETERMINATE plus minimal metadata (enrollment type, state, matched field, roles held). " +
        "Never returns the roster or any name. Needs a token with roster-admin rights; without them Canvas silently withholds login ids and the answer is INDETERMINATE, never NO. " +
        "role defaults to student; a NO names any other role the person holds — pass role='any' to ask about the course at all.",
      inputSchema: CHECK_ENROLLMENT_INPUT,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const args = input as z.infer<z.ZodObject<typeof CHECK_ENROLLMENT_INPUT>>;
      return safeHandler("check_enrollment", async () => {
        const tool = "check_enrollment";
        const netId = typeof args.net_id === "string" ? args.net_id.trim() : "";
        if (!NET_ID_PATTERN.test(netId)) {
          throw new CanvasApiError({
            code: "VALIDATION",
            message:
              `${tool}: net_id must be a campus login id (NetID, uniqname, or email-style Canvas login) of 1-254 chars: ` +
              "letters, digits, '.', '_', '@', '+' or '-'. It is not a display name.",
          });
        }
        const roleKey = (args.role ?? "student").trim().toLowerCase();
        if (roleKey !== "any" && !(roleKey in ROLE_TO_TYPE)) {
          throw new CanvasApiError({
            code: "VALIDATION",
            message: `${tool}: role must be one of ${Object.keys(ROLE_TO_TYPE).join(", ")}, or any.`,
          });
        }
        const activeOnly = args.active_only !== false;
        const courseId = await canvas.resolveCourseId(args.course_identifier);

        // No type[] filter on purpose: filtering at Canvas hides the subject's
        // other roles, so a teacher asked about with role=student would read as
        // "not in this course".
        const params: Record<string, unknown> = { "include[]": ["user"] };
        if (activeOnly) params["state[]"] = ["active"];

        let enrollments: CanvasEnrollment[];
        let rosterTruncated: boolean;
        try {
          const result = await canvas.getPaginated<CanvasEnrollment>(`/api/v1/courses/${courseId}/enrollments`, {
            params,
          });
          enrollments = result.items;
          rosterTruncated = result.truncated;
        } catch (error) {
          if (error instanceof CanvasApiError && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")) {
            throw new CanvasApiError({
              code: error.code,
              status: error.status,
              endpoint: error.endpoint,
              message:
                `${tool}: Canvas rejected the roster read (${error.status ?? error.code}). This tool needs a token with ` +
                "roster-admin access to the course; the answer is UNKNOWN, not negative.",
            });
          }
          throw error;
        }

        const courseCode = canvas.getCachedCourseCode(courseId) ?? null;
        const label = courseCode ?? String(courseId);
        const base = { course_id: courseId, course_code: courseCode, net_id: netId, role: roleKey, active_only: activeOnly };

        const match = matchEnrollment(enrollments, netId, activeOnly);
        if (match.kind === "ambiguous") {
          return jsonResult(
            { ...base, answer: "AMBIGUOUS", enrolled: null, detail: match.detail },
            {
              summary:
                `AMBIGUOUS — cannot tell which person '${netId}' refers to in course ${label}. ${match.detail} ` +
                "No yes/no answer is given, because choosing would depend on roster ordering.",
            },
          );
        }

        // Only a NO or a local-part YES needs proof that every relevant row was
        // readable: an exact match is self-proving. A NO is judged against rows
        // of the requested role (any subject row of that role is among them); a
        // fallback YES against the whole roster, since a hidden row of ANY role
        // could be a second person sharing the local part.
        const wanted = roleKey === "any" ? null : ROLE_TO_TYPE[roleKey]!;
        const needsProof = match.kind === "none" || !match.exact;
        const scope =
          match.kind === "none"
            ? wanted === null
              ? enrollments
              : enrollments.filter((enrollment) => enrollment.type === wanted)
            : enrollments;
        const hidden = scope.length > 0 && !scope.every((enrollment) => exposesIdentifier(enrollment.user));
        if (needsProof && (hidden || rosterTruncated)) {
          const why = hidden
            ? "Canvas withheld login_id and sis_user_id on at least one user in this roster (the token lacks roster-admin rights)"
            : "the roster was truncated by the pagination cap";
          const detail =
            match.kind === "none"
              ? `${why}, so a 'not enrolled' answer cannot be trusted.`
              : `${why}, and '${netId}' matched only by email local part, so it cannot be proven that no other person shares it.`;
          return jsonResult(
            { ...base, answer: "INDETERMINATE", enrolled: null, detail },
            {
              summary:
                `INDETERMINATE — cannot tell whether ${netId} is enrolled in course ${label}: ${detail} ` +
                "Permission-blindness is not absence; retry with a roster-admin token.",
            },
          );
        }

        if (match.kind === "none") {
          return jsonResult(
            { ...base, answer: "NO", enrolled: false, roles_held: [] },
            { summary: `NO — ${netId} has no${activeOnly ? " active" : ""} '${roleKey}' enrollment in course ${label}.` },
          );
        }

        const subjectId = match.enrollment.user?.id;
        const subjectEnrollments =
          subjectId === undefined || subjectId === null
            ? [match.enrollment]
            : enrollments.filter(
                (enrollment) =>
                  enrollment.user?.id === subjectId && !(activeOnly && enrollment.enrollment_state !== "active"),
              );
        const rolesHeld = [
          ...new Set(
            subjectEnrollments
              .map((enrollment) => enrollment.type)
              .filter((type): type is string => typeof type === "string" && type !== ""),
          ),
        ];
        const satisfying =
          wanted === null
            ? subjectEnrollments[0]
            : subjectEnrollments.find((enrollment) => enrollment.type === wanted);

        if (!satisfying) {
          return jsonResult(
            { ...base, answer: "NO", enrolled: false, roles_held: rolesHeld },
            {
              summary:
                `NO — ${netId} has no${activeOnly ? " active" : ""} '${roleKey}' enrollment in course ${label}. ` +
                `They ARE enrolled in this course, as: ${rolesHeld.join(", ")}. Re-run with role='any' (or the matching role) for details.`,
            },
          );
        }

        return jsonResult(
          {
            ...base,
            answer: "YES",
            enrolled: true,
            enrollment: {
              type: satisfying.type ?? null,
              enrollment_state: satisfying.enrollment_state ?? null,
              matched_on: match.field,
            },
            roles_held: rolesHeld,
          },
          {
            summary:
              `YES — ${netId} has an enrollment in course ${label} (type: ${satisfying.type ?? "unknown"}, ` +
              `state: ${satisfying.enrollment_state ?? "unknown"}, matched on ${match.field}).`,
          },
        );
      });
    },
  );
}
