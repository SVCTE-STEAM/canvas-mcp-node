---
name: canvas-morning-check
description: Teacher start-of-day (or start-of-week) course health check in Canvas LMS — submission rates on recent work, students who are missing work or struggling, score summaries, and what's due next, then optional personalized reminders. Use when the teacher says "morning check", "course status", "how are my students doing", "who's behind", "check my classes", or asks for a quick daily/weekly review of one or all of their courses.
---

# Canvas Morning Check

A fast course health check for teachers: surface submission gaps, students who need support, and upcoming deadlines — then act on them (with the teacher's approval).

## Ground rules

- Students appear as pseudonyms (`Student 3`). That is expected — never ask the teacher for real names and never try to "de-anonymize". The pseudonyms are stable, so `Student 3` is the same student across tools and days.
- Nothing is sent without the teacher approving a preview (see step 6).
- Show course **codes** (e.g. `AUTO-1 AM`) rather than numeric ids.

## Steps

### 1. Pick the course(s)

If the teacher named a course, resolve it with `list_courses` (match on course code or name; confirm if ambiguous). If they said "all", run steps 2–5 for each active course and keep each course's report short. If they named nothing:

> Which course should I check? (Or say "all" for all of your active courses.)

### 2. Recent work (past 7 days)

1. `list_assignments` for the course; keep assignments whose `due_at` falls in the past 7 days.
2. For each, call `get_assignment_analytics` (course + assignment id) to get submission rate, on-time / late / missing counts, score stats, and which students (pseudonyms) are missing or scoring low.

### 3. Students who need support

Combine the per-assignment results (and `get_student_analytics` for the course when you need each student's overall picture — current score, missing and late counts). Classify:

| Urgency | Criteria |
|---------|----------|
| **Critical** | 3+ missing in the past 2 weeks, or current score below 60% |
| **Needs attention** | 2 missing, or score 60–70%, or 3+ late |
| **On track** | everything else |

Thresholds are defaults — if the teacher gives their own ("flag anyone under 75%"), use theirs.

`get_student_analytics` relies on Canvas Analytics. If it errors because Analytics is turned off for the school, don't stop: build the per-student picture from the `get_assignment_analytics` results (missing/late/low lists per assignment) instead, and mention that current overall scores weren't available.

### 4. Coming up (next 7 days)

From the same `list_assignments` data, list assignments due in the next 7 days: name, due date/time, points, and — if already open — how many have submitted.

### 5. Report

```
## Course Status: AUTO-1 AM

### Recent work
| Assignment | Due | Submitted | Missing | Late | Avg |
|------------|-----|-----------|---------|------|-----|
| Brake Lab 3 | Mon 11/2 | 26/30 | 4 | 2 | 84% |

### Students needing support
**Critical:** Student 4 (missing Brake Lab 3, Safety Quiz 2, Journal 5)
**Needs attention:** Student 11 (2 missing), Student 17 (score 66%)

### Coming up
- **Thu 11/12** — Engine Teardown Checklist (50 pts), 3 submitted so far

### Suggested actions
1. Remind the 4 students missing Brake Lab 3
2. Check in with Student 4
```

Keep it scannable. For "all courses", give each course a 3–6 line summary and offer to drill in.

### 6. Follow-up actions (teacher chooses)

> Want me to:
> 1. Send a reminder to the students missing work
> 2. Get the details for one assignment or one student
> 3. Check another course

**Messaging (two-step, always):**
1. Draft the subject and body with the teacher. Personalize with `{first_name}` — the server fills in each student's real first name at send time; Claude never sees it. Example: `Hi {first_name}, Brake Lab 3 is still missing — can you turn it in by Friday?`
2. Call `send_conversation` (course, `recipient_ids` = the real Canvas user ids from the analytics results, subject, body) **without** a `confirmation_token`. Nothing is sent; you get a preview and a token.
3. Show the teacher the preview (recipient pseudonyms, count, subject, body). Ask for approval.
4. Only after a clear yes, call `send_conversation` again with **identical** arguments plus the `confirmation_token`. If they want edits, make them and start over at step 2 (the old token stops working when content changes).

For different messages to different students (e.g. each student's own missing list), use `send_bulk_messages_from_list` with one row per student — same preview-then-token flow.

## Tools used

| Tool | Purpose |
|------|---------|
| `list_courses` | Find the course |
| `list_assignments` | Recent and upcoming assignments |
| `get_assignment_analytics` | Submission rates, score stats, missing/low students |
| `get_student_analytics` | Per-student overview for the course |
| `list_submissions` | Raw submission records when you need more detail |
| `send_conversation` / `send_bulk_messages_from_list` | Reminders (preview → approve → send) |

## Notes

- Works best as a Monday-morning routine; for "all courses" keep it brief and let the teacher drill in.
- If an assignment has no due date, it won't show as missing — mention that if it matters.
