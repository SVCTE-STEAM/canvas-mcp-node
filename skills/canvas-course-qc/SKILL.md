---
name: canvas-course-qc
description: Pre-semester quality check of a Canvas LMS course — module structure, empty or inconsistent modules, missing due dates/points/descriptions, publishing problems (items students can't see), front page, and rubric coverage — reported by priority with a fix list. Use when the teacher says "QC my course", "is this course ready", "pre-semester check", "quality review", "check my course before students see it", or after copying a course into a new term.
---

# Canvas Course QC

A readiness checklist for a Canvas course: run structure, content, publishing and completeness checks, then report issues by priority. Read-only by default; any fix is the teacher's call.

## Steps

### 1. Pick the course

Resolve the course with `list_courses` if the teacher gave a name or code. If nothing was given:

> Which course should I check?

### 2. Get the whole structure

Call `get_course_structure` (course). It returns every module with its items, types, published state and due dates in one call — use it as the backbone for the checks below.

### 3. Structure checks

| Check | Priority | Look for |
|-------|----------|----------|
| Empty modules | Warning | Modules with 0 items |
| Naming consistency | Suggestion | Most modules follow a pattern ("Week N:", "Unit N:", "Module N:") but a few don't |
| Organization | Suggestion | Long modules with no text headers (SubHeaders) |

### 4. Content checks

Call `list_assignments` (course) and check each graded assignment:

| Check | Priority | Look for |
|-------|----------|----------|
| Missing due date | Blocking | Graded assignment without `due_at` |
| Missing points | Warning | No `points_possible` |
| Missing description | Warning | Empty description (use `get_assignment_details` to confirm) |
| Dates out of order | Warning | Due dates that run backwards relative to module order |
| No rubric | Suggestion | Graded assignment with no rubric (`list_all_rubrics` / `get_assignment_details`) |

For pages in modules, spot-check suspiciously short ones with `get_page_content`.

### 5. Publishing checks

| Check | Priority | Look for |
|-------|----------|----------|
| Hidden items | Blocking | Published items inside an unpublished module (students can't see them) |
| Unpublished modules | Warning | Modules still unpublished close to the start date |
| No front page | Warning | Use `get_front_page`; if none is set, flag it |
| Syllabus | Suggestion | `get_syllabus` is empty |

### 6. Completeness checks

Build a "typical module" profile from the most common item pattern (e.g. 1 page + 2 assignments + 1 discussion), then flag modules that deviate a lot (a week with 1 item when most have 4).

If the course uses Canvas Outcomes, call `get_course_outcomes` once (no mastery data needed). As **Suggestions**, list outcomes with no mastery threshold, and, once the term is under way, outcomes no student has been assessed on yet (`assessed: false`). Before the term starts, unassessed outcomes are normal; don't flag them. No outcomes at all is fine: many courses don't use the feature.

### 7. Report

```
## Course QC Report: CULN-1 PM

### Summary
Modules: 16 | Items: 71 | Assignments: 18 | Pages: 22
Issues: 2 blocking · 5 warnings · 3 suggestions

### Blocking (fix before students arrive)
1. "Final Practical" has no due date
2. "Week 5 Quiz" is published inside the unpublished "Week 5" module — students can't see it

### Warnings
1. Empty modules: "Week 15", "Week 16"
...

### Suggestions
1. 14/16 modules use "Week N:"; "Midterm Review" and "Final Review" don't
...
```

### 8. Follow-ups

Offer:
1. **Details** on any issue.
2. **Accessibility audit** (the `canvas-accessibility-auditor` skill).
3. **Safe fixes**, with approval:
   - Add missing due dates / points: `update_assignment` (one at a time, confirm each change with the teacher first).
   - Rename modules for consistency: `update_module` (name only).
   - Page settings in bulk (e.g. front page, editing roles, unpublishing stray pages): `bulk_update_pages` — first call returns a preview and a `confirmation_token`; show it; call again with the token only after approval.
4. **Publishing** is always the teacher's job: give them a checklist of exactly what to publish in Canvas (module by module). The tools cannot publish, by design.

## Tools used

`list_courses`, `get_course_structure`, `list_assignments`, `get_assignment_details`, `list_all_rubrics`, `get_page_content`, `get_front_page`, `get_syllabus`, `get_course_outcomes`, `update_assignment`, `update_module`, `bulk_update_pages`.

## Notes

- Run it right after a course copy (see `canvas-course-builder`) and again a week before the term starts.
- Don't "fix" by publishing — list what to publish and let the teacher do it in Canvas.
