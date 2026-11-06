---
name: canvas-course-builder
description: Build out a Canvas course shell in bulk — copy last term's course into a new shell (with due dates shifted to the new term), or scaffold many modules with placeholder pages, assignments and discussions from a teacher's outline or a JSON template. Everything is created unpublished. Use when the teacher says "copy my course", "roll over my course to the new term", "copy course structure", "scaffold modules", "set up 18 weekly modules", or "build the course skeleton". For pedagogical planning of what the modules should contain, use plan-course / plan-module instead.
---

# Canvas Course Builder

Bulk construction of a course shell. Two modes:

- **Copy mode** — copy an existing course into a new (or empty) shell, shifting dates to the new term. Most common at the start of a term.
- **Scaffold mode** — create a repeated structure (e.g. 18 weekly modules, each with an overview page, a lab assignment and a reflection discussion) from the teacher's outline or a JSON template.

If the teacher wants help deciding *what* to teach in each module, hand off to `plan-course` (whole course) or `plan-module` (one module); this skill is for the mechanics.

## Rules

- Everything is created **unpublished**. The teacher publishes in Canvas. Never describe the result as published.
- Show a plan and get approval **before** creating anything.
- Use course **codes** in what you show the teacher.

## Copy mode

1. **Identify both courses** with `list_courses`: the *source* (last term) and the *target* (new shell). Confirm both by code and name — copying into the wrong shell is the expensive mistake here.
2. **Dates.** Ask for (or infer from the courses) the old term's start and end dates and the new term's start and end dates. These shift every due/unlock/lock date proportionally. If the teacher doesn't want dates shifted, leave them out.
3. **Preview.** Call `create_content_migration` with `source_course_identifier`, `target_course_identifier` and (optionally) `old_start_date`, `old_end_date`, `new_start_date`, `new_end_date` — **without** `confirmation_token`. Nothing is copied; you get a preview and a token.
4. Show the preview: source → target, date shift, and the fact that it is a **full copy** (all content; the source is never modified). Warn if the target already has content (copies add to it; they don't replace it — check with `get_course_structure` on the target).
5. After a clear yes, call again with identical arguments plus `confirmation_token`.
6. **Track progress** with `get_content_migration_status` (target course + `migration_id`) every so often until it finishes; report any migration issues it lists.
7. **QC.** Offer to run the `canvas-course-qc` skill on the target — copied courses often have stale dates, last year's announcements, or published items in unpublished modules.

## Scaffold mode

1. **Course.** Resolve the target with `list_courses`; check what's already there with `get_course_structure` so you don't duplicate modules.
2. **Gather the spec** from the teacher's description, e.g. *"18 weeks, each with an Overview page, a Lab assignment (20 pts, due Friday 11:59 pm) and a Reflection discussion; weeks 9 and 18 are assessment weeks."* Or accept a JSON template:

   ```json
   {
     "module_pattern": "Week {n}: {topic}",
     "modules": [{ "n": 1, "topic": "Shop Safety", "start": "2027-01-11" }],
     "items_per_module": [
       { "type": "page", "title": "Week {n} Overview" },
       { "type": "assignment", "title": "Lab {n}", "points": 20, "due": "friday 23:59" },
       { "type": "discussion", "title": "Week {n} Reflection" }
     ]
   }
   ```
3. **Preview the plan** as a table (module → items with type, points, due date) with totals ("18 modules, 54 items"). Get approval; adjust as asked.
4. **Create, in order, for each module:**
   - `create_module` (name, position)
   - the items: `create_page` (title + short placeholder body, or a template via `list_page_templates`), `create_assignment` (name, points_possible, due_at, submission_types), `create_discussion` (title, message)
   - `add_module_item` for each created item, in order
   Work module by module and keep a running tally; if something fails, note it and continue.
5. **Report**: created vs failed, with links, and the reminder that everything is unpublished.
6. **Offer**: save the spec as a reusable JSON template (give it to the teacher to keep), run `canvas-course-qc`, or fill the modules with real content via `plan-module`.

## Tools used

`list_courses`, `get_course_structure`, `create_content_migration`, `get_content_migration_status`, `create_module`, `create_page`, `list_page_templates`, `create_assignment`, `create_discussion`, `add_module_item`.

## Notes

- Course copy is all-or-nothing (no selective import). To copy only part of a course, copy everything into a scratch/sandbox shell, or scaffold instead.
- Large scaffolds make many Canvas calls; for 30+ modules, confirm with the teacher before starting and report progress as you go.
