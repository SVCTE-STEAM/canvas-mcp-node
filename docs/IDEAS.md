# Ideas: new skills and tools for the SVCTE edition

Brainstormed 2026-11-06 for career-technical (CTE) teachers. Each idea says whether it needs **new server code** (a tool) or is **a skill only** (a SKILL.md that orchestrates tools that already exist). Every idea keeps the two house rules: students appear to Claude only as pseudonyms, and nothing student-visible happens without a preview the teacher approves.

## Top picks (high impact, modest effort)

| # | Idea | Kind | Why it matters for CTE |
|---|------|------|------------------------|
| 1 | **Missing-work nudges** — `send_missing_work_reminders(course, since)` computes *each* student's own missing list on the server and sends one personalized message per student ("Hi {first_name}, you're missing: Lab 4, Safety Quiz"), behind the preview/token gate. | Tool + skill | The single most common teacher message. Today Claude would need real names to personalize; doing the merge server-side keeps names off Claude entirely. |
| 2 | **Shift due dates** — `shift_due_dates(course, module_or_range, days, skip_weekends)` moves due/unlock/lock dates for a module or date range (snow day, field trip, testing week), preview first. | Tool + skill | Rescheduling a week by hand is dozens of clicks. |
| 3 | **Safety-clearance check** — find students who have not passed the shop/lab safety quiz at the required score, and show which equipment modules are still unlocked for them; optionally set module requirements (`min_score`) so the shop module stays locked until they pass. | Skill (+ small tool for module completion requirements) | Many SVCTE programs require 100% on safety tests before students touch equipment. |
| 4 | **Sections / sessions** — `list_sections` and a `section` filter on analytics, morning check and messaging (AM vs PM session, home high school). | Tool | SVCTE students come from many home schools and attend in sessions; most reporting is per section. |
| 5 | **Accommodations (IEP/504)** — `create_assignment_override` for extended due dates and New Quizzes extra-time accommodations for specific students (by user id; shown as pseudonyms), gated. | Tool + skill | Required, repetitive, and error-prone by hand. |
| 6 | **New-term rollover** — course copy with date shifting already exists (`create_content_migration` with old/new start/end dates; `canvas-course-builder` copy mode). Next steps: weekday substitutions (Mon→Tue for a schedule change), clearing last term's announcements, and chaining straight into course QC. | Extend tool + skill | Turns a half-day job into a reviewed preview and one approval. |

## Grading and feedback

- **Skills check-off (competency sign-off)** — *skill.* Model each hands-on competency (e.g. "torque to spec", "knife cuts", "vital signs") as a complete/incomplete assignment; the teacher dictates "Student 4 and 9 passed brake bleeding", and Claude records it with `grade_submission`, after a review table.
- **Feedback bank** — *skill (+ optional school-config field).* A reusable comment bank per rubric criterion so feedback stays consistent across sections; Claude picks and adapts a bank comment instead of writing from scratch.
- **Grading consistency check** — *skill.* Compare score distributions for the same rubric across sections/sessions and flag criteria where one section scores very differently.
- **Grade export for home schools** — *tool.* Write a CSV with real names to a folder the teacher chooses, *without* returning the names to Claude (the tool returns only "wrote 31 rows to …"). Home-school grade reporting needs real names; this keeps them off the AI.

## Planning and content

- **Standards alignment** — *tool + skill.* Canvas Outcomes API (`list_outcomes`, `create_outcome`, align to rubrics, `get_outcome_results`) so assignments can be tagged with California CTE Model Curriculum Standards or industry-certification objectives (ServSafe, OSHA-10, CompTIA, ASE, NATEF), plus mastery reports by standard (pseudonymized).
- **Certification readiness** — *skill on top of standards alignment.* Which certification objectives have been taught, assessed, and mastered, and which are not yet covered.
- **Sub plan** — *skill.* From this week's module, draft an unpublished "Substitute Plan" page: schedule, materials, what students do, safety notes, where answer keys live.
- **Weekly agenda announcement** — *skill.* Build "This week in <course>" from due dates and module items, scheduled at least 30 minutes out (the existing announcement rule).
- **Lab/shop sheet generator** — *skill.* Turn a lesson page into a printable step-by-step procedure with a PPE checklist and a sign-off line, created as a draft page.

## Student support and communication

- **Reflection / work-based-learning journal digest** — *skill.* Summarize a week of student journal or discussion entries (already scrubbed of names) into themes, students who seem stuck, and any safety concerns, as pseudonyms.
- **Observer (parent/guardian) updates** — *tool.* Message the observers linked to a student (Canvas observer enrollments), with the same gate and `{first_name}` merge, in the family's preferred language if the teacher supplies a translation.
- **Inbox triage** — *skill.* Group unread conversations by intent (extension request, absence, question about an assignment) and draft replies for the teacher to approve.

## Program-level reporting

- **Advisory committee / program review packet** — *skill.* Program-level, fully anonymized summary: enrollment by section, completion rates, certification readiness, sample student work (with names scrubbed), for advisory boards and accreditation reviews.
- **Attendance hours** — *needs investigation.* CTE programs track clock hours, but Canvas Roll Call is an LTI tool with no REST API; check whether SVCTE records hours anywhere Canvas exposes before building anything.

## Platform and safety improvements

- **Write audit log** — every write (who, what, course, when; no student names) appended to a local log the teacher can open, so "what did Claude change?" is always answerable.
- **Read-only mode switch** in the installer, for colleagues who want to try it with zero risk first.
- **Undo for page edits** — snapshot the previous page body before `edit_page_content` / `bulk_update_pages` / `fix_accessibility_issues`, plus a `restore_page_revision` tool (Canvas keeps page revisions; expose them).
- **Image alt-text helper** — download a course image, let Claude describe it, propose alt text, apply with the accessibility fixer's preview gate.
