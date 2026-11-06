---
name: plan-assessment
description: Plan a Canvas assessment (test, quiz, project, presentation, essay, etc.) using the school's assessment template. Use when the teacher says "plan an assessment", "create a test/quiz/project page", "draft an assessment", or describes any graded task that needs a Canvas artifact describing it. Generates content for all 6 required slots — description, pre-work, structure + grading + grade-boundaries table, submission instructions, time allotment, and AI-use policy — then creates a draft Canvas Assignment (the graded object, with the template-wrapped description) or, when the teacher wants a standalone page, a draft Canvas Page. Generic — works with whatever assessment template the school config provides.
---

# Plan Assessment

Plan a graded task (test, quiz, project, presentation, essay) and create the Canvas **draft** artifact describing it. Covers all 6 required slots of the school's assessment template. Generic across schools.

> **This skill never publishes anything.** Assignments and pages land in Canvas as drafts (`published: false`, enforced server-side). The teacher reviews in Canvas and clicks **Publish** themselves when ready. This is a hard policy — don't try to flip the published flag, don't ask the teacher whether to "create as a draft" (it's always a draft), and don't describe what the skill does as "publishing."

## Assignment vs. page — which artifact?

Since canvas-mcp **v0.4.1**, `create_assignment` wraps its description in the school's page templates — so an assessment is normally created as **one Canvas Assignment** whose description carries the full assessment template (all 6 slots). That's the default: students see the assessment details on the assignment itself, where they submit.

Create a separate **Page** (`create_page` with `template: "assessment"`) only when the teacher explicitly wants a standalone describing page (e.g., an in-class assessment with no Canvas submission, or their course convention keeps assessment pages separate from assignment objects).

## When to use

A teacher describes a graded task that needs a Canvas artifact. Common phrasings:

- "Plan a 20-question quiz for DSGN 9 on the water cycle"
- "Create an assessment page for the prototyping project — 3 weeks, 25% of trimester"
- "I need an assessment for tomorrow's presentation day"
- "Draft a take-home essay assignment, 1500 words, due Friday"

The same template is used whether it's an in-class test or a long-term project — the slot content adapts.

## When NOT to use

- **Single lessons** — that's `plan-lesson` (UbD planning) or `post-lesson-page` (posting an already-planned lesson).
- **The actual quiz object with questions inside** — that's `post-quiz` (it composes with this skill; see its "Linkage with plan-assessment" section).
- **Editing an existing assessment** — see "Updating an existing assessment" below.

## Prerequisites

- canvas-mcp **v0.4.4 or later** (assessment-template assignments with `suggested_title`, assignment-group-driven `{type}`/`{percent}`, and calendar-table week numbers).
- A school config with an `assessment` page template (the server bundles a generic preset by default; a school can supply its own JSON via the installer's "School config file" field).

## Workflow

### 1. Confirm the basics

Before generating any content, you need these answers. Some come from the teacher's initial request; some come from school context — only ask for what neither source supplies.

**First, pull school context once** by calling `get_school_info` (calendar bounds, week source) and `list_page_templates` (the assessment template's slots + `title_format`).

**Then collect the assessment's metadata:**

- **Canvas course?** If named by code/fragment, call `list_courses` to confirm.
- **Assessment name?** Propose one if the teacher gave only a topic.
- **Assessment kind?** Test / quiz / project / presentation / essay / lab / portfolio / other. This drives the AI-use policy defaults and shapes every slot. (Note: the `{type}` shown in the final title comes from the Canvas assignment group in step 1b, not from this answer — but knowing what kind of task it is still shapes all the content.)
- **Total points?** Drives the grade boundaries table. If the teacher said "out of 100" or "20 questions × 1 point each = 20 pts", use that. If they didn't say, ask.
- **Assignment group?** See step 1b — this is where the weighting (`{percent}`) comes from.
- **Time?** For tests/quizzes: minutes (standard + extended time). For projects: duration (e.g., "3 weeks" or "Sept 8 → Sept 29") and key milestones if there are checkpoints.
- **Due date** (for projects) or **assessment date** (for in-class tests). The server computes the academic week in the title from this — see step 1c.
- **Two flag questions — ask in plain language, never surface parameter names:**
  - *"Should this assessment and its grade be posted to the parent reporting portal?"* (yes → the FAIR tag)
  - *"Is this a final / culminating assessment that counts toward the final grade?"* (yes → the FINAL tag)

#### 1b. Weighting comes from the Canvas assignment group

Since v0.4.4, the `{type}` and `{percent}` in the assessment title come from the course's **Canvas assignment groups** — the group's name is the type, its `group_weight` is the percent. So:

1. Call `list_assignment_groups(course_identifier)`.
2. Ask the teacher **which group this assessment belongs to** (plain language: "Which assignment group does this belong to? The course has: …"). Show the groups with their weights.
3. The percent then comes from Canvas — don't ask the teacher to remember it and don't scrape the syllabus for it.
4. **Fallback:** if the chosen group has no usable weight (weighted groups disabled, or weight 0), the server will ask for a percent — get it from the teacher (or infer it from the course syllabus via `list_courses` → `syllabus_body`, or a "Syllabus" page via `list_pages` → `get_page_content`, quoting the source for confirmation) and pass it as `asmt_percent`.

#### 1c. The academic week comes from the server — never compute it yourself

Do **not** estimate the week number from the due date with date math. The server derives it from the school's published week calendar (which skips breaks) when you pass `due_at` to `create_assignment`, and composes it into `suggested_title`.

If the response substitutes `?` for the week, the accompanying warning states exactly why (due date falls on a school break / before or after the school year / no calendar). Relay that reason to the teacher and ask what week number they intend — do not guess one.

What you don't need to ask:

- Module placement — handle that after the draft is created if the teacher mentioned a module.
- Publishing or "create as draft?" — everything is created as a draft, always. Don't ask.
- HTML structure — the template handles it.
- Whether to skip the school template — never offer that. `template: "none"` exists only for when the teacher explicitly asks for an untemplated assignment.
- "Should I include a rubric?" — if the assessment uses one, the teacher will mention it (that's `setup-rubric`); if they don't mention one, just generate the grade boundaries table.
- Class period length — `get_school_info` already gave you it if you need it.

### 2. Discover the assessment template

Call `list_page_templates` and find the entry named `assessment`. Read its `slots` list — every slot has a `description` telling you what content goes there. The bundled generic preset (and most school configs) defines 6 required slots:

- `description` — top-level description of the assessment (intro + what students will do)
- `pre_work` — what students should complete before the assessment
- `structure_and_grading` — structure + weighting + grade boundaries table
- `submission` — how students submit
- `time` — time allotment / timeline
- `ai_use` — acceptable + unacceptable AI uses

**Titles:** schools with a strict convention expose a `title_format` (example: `"{type}: {name} [Week {week}] {percent}% {fair_flag}{final_flag}ASMT"`). You don't need to render this yourself for assignments — the `create_assignment` response includes a fully composed **`suggested_title`** built from the group name, assessment name, calendar week, group weight, and flags. Propose `suggested_title` to the teacher and let them adjust; then apply it via `update_assignment(name: ...)` if the name you created with differs. When `title_format` is `null` (no convention), propose your own title.

If no `assessment` template exists in the school config, tell the teacher the page won't have the school's formal assessment chrome and continue with `template: "default"` — don't silently skip templating.

### 3. Generate slot content

For each slot, generate concrete classroom-ready HTML. Key guidance per slot:

#### `description`

The "what is this assessment" overview. Intro paragraph naming the topic + a list of what students will do.

```html
<p>20-question multiple-choice test on watershed geography and the water cycle.</p>
<p>Students will:</p>
<ol>
  <li>Identify the components of a watershed (precipitation, runoff, infiltration, evapotranspiration)</li>
  <li>Diagram water movement through a watershed</li>
  <li>Apply concepts to identify their home watershed on a regional map</li>
</ol>
```

Make it concrete. Avoid generic phrasings like "students will demonstrate their understanding." Say what the demonstration *is*.

#### `pre_work`

What students should have completed before the assessment. Most teachers under-specify this — fill it in with the actual prerequisite work from the unit. If the teacher hasn't told you what came before, ask, or propose something reasonable (e.g., "review the lesson pages from Week 3" with a checklist).

```html
<p>Before taking this assessment, complete the following:</p>
<ol>
  <li>Review the watershed geography lesson page</li>
  <li>Complete the watershed mapping worksheet from class</li>
  <li>Read pages 142–158 in the textbook</li>
  <li>Try the practice quiz (ungraded) on Canvas</li>
</ol>
```

#### `structure_and_grading`

Three pieces in one slot:

1. **Structure description** — one paragraph: number of questions / sections / tasks, point values per part, format.
2. **Weighting** — one paragraph stating what % of the trimester (or term) this assessment is worth (from the assignment group, step 1b).
3. **Grade boundaries table** — see "Grade boundaries" below.

Example:

```html
<p>20 multiple-choice questions, 1 point each. No partial credit.</p>
<p>This assessment is worth <strong>15% of the trimester grade</strong>.</p>
<p><strong>Grade Boundaries</strong></p>
<table border="1" style="border-collapse: collapse; width: 30%;">
  <thead>
    <tr><th>Letter Grade</th><th>Points</th></tr>
  </thead>
  <tbody>
    <tr><td>A+</td><td>20</td></tr>
    <tr><td>A</td><td>19</td></tr>
    <tr><td>A-</td><td>18</td></tr>
    <tr><td>B+</td><td>17</td></tr>
    <tr><td>B</td><td>16</td></tr>
    <tr><td>B-</td><td>15</td></tr>
    <tr><td>C+</td><td>14</td></tr>
    <tr><td>C</td><td>13</td></tr>
    <tr><td>C-</td><td>12</td></tr>
    <tr><td>D</td><td>10–11</td></tr>
    <tr><td>F</td><td>0–9</td></tr>
  </tbody>
</table>
```

#### `submission`

How students submit. Be specific about the mechanism:

- **In-class on paper:** "Take in class on paper. Hand in to the teacher when complete."
- **Canvas upload:** "Upload your file to this assignment. Accepted formats: PDF, DOCX. File size limit: 25 MB."
- **In-class digital:** "Take in Canvas during class. Lock down browser may be enabled."
- **Project presentation:** "Present in class on the scheduled day. Upload slides to this assignment by 8 AM that morning."

#### `time`

For tests/quizzes:

```html
<p><strong>Standard time:</strong> 45 minutes.</p>
<p><strong>Extended time:</strong> 60 minutes for students with accommodations.</p>
```

For projects, include the timeline and checkpoints:

```html
<p><strong>Duration:</strong> 3 weeks (March 4 – March 25)</p>
<p><strong>Milestones:</strong></p>
<ul>
  <li><strong>March 11:</strong> Design proposal due (ungraded check-in)</li>
  <li><strong>March 18:</strong> Working prototype due (in-class feedback)</li>
  <li><strong>March 25:</strong> Final submission</li>
</ul>
```

#### `ai_use`

This is the one slot where you should *not* use a generic default. The right AI policy depends on the assessment type. Defaults to start from (teacher should review and adjust):

**Closed-book test / quiz:**
```html
<p>Acceptable:</p>
<ul>
  <li>None. This is a closed-book individual assessment.</li>
</ul>
<p>Unacceptable:</p>
<ul>
  <li>All AI tools (ChatGPT, Claude, Copilot, etc.)</li>
  <li>Other people's notes or work</li>
  <li>Reference materials not explicitly permitted</li>
</ul>
```

**Take-home essay / writing:**
```html
<p>Acceptable:</p>
<ul>
  <li>Using AI for brainstorming and ideation before you write</li>
  <li>Using AI to research background topics</li>
  <li>Asking AI to explain a concept you don't understand</li>
</ul>
<p>Unacceptable:</p>
<ul>
  <li>Using AI to draft any part of your final submission</li>
  <li>Using AI to revise or edit your draft</li>
  <li>Submitting AI-generated text as your own</li>
</ul>
```

**Project (technical/creative):**
```html
<p>Acceptable:</p>
<ul>
  <li>Using AI to debug code or troubleshoot technical problems</li>
  <li>Using AI to research design references and material options</li>
  <li>Using AI to brainstorm ideas before you commit to a direction</li>
</ul>
<p>Unacceptable:</p>
<ul>
  <li>Using AI to generate the final design / writeup / artifact</li>
  <li>Using AI to write your reflection or process documentation</li>
  <li>Submitting AI-generated work without disclosure</li>
</ul>
```

**Presentation / performance:**
```html
<p>Acceptable:</p>
<ul>
  <li>Using AI for research and preparation</li>
  <li>Using AI for slide design assistance</li>
  <li>Using AI to practice answering anticipated questions</li>
</ul>
<p>Unacceptable:</p>
<ul>
  <li>Reading AI-generated content during the presentation</li>
  <li>Submitting AI-generated slides without disclosure</li>
</ul>
```

Show the teacher the default and explicitly say *"This is the default for [type] — review and adjust to match your class's policy."*

### 4. Grade boundaries — how to compute the table

Standard US grade scale (use this unless the teacher overrides):

| Grade | Percentage |
|---|---|
| A+ | 97–100% |
| A  | 93–96%  |
| A- | 90–92%  |
| B+ | 87–89%  |
| B  | 83–86%  |
| B- | 80–82%  |
| C+ | 77–79%  |
| C  | 73–76%  |
| C- | 70–72%  |
| D  | 60–69%  |
| F  | 0–59%   |

To compute point ranges, multiply percentages by total points and round to integers:

- For each grade, the **low bound** is `ceil(low_pct × total / 100)`
- The **high bound** is `floor(high_pct × total / 100)`
- Where low and high collapse to a single value (small point totals), show that one number; otherwise show a range

Frankly, for small totals (<25 points), give the teacher the table but flag that the integer-rounding makes some grades collapse. Suggest they bump to a larger point total OR use percentage thresholds in the description.

**Example: 100-point assessment** — percentages map 1:1, no rounding issues (A+ 97–100, A 93–96, …, F 0–59).

If the teacher wants a different scale ("we use 90/80/70/60 for A/B/C/D"), use that. Don't over-engineer — the table is a quick reference, not a contract.

### 5. Consider competency alignment

Call `list_competencies`. If a framework is configured (your school's framework, if one is configured), **always** spend a moment identifying which 1–3 competencies this assessment naturally evaluates. Assessments almost always target specific competencies — even a closed-book MC test exercises Knowledge-Based Reasoning; a project usually targets two or three.

This is a *thinking* step that informs your slot content (especially `description` and `structure_and_grading`). Pick 1–3 competencies, not all of them. Don't shoehorn — only call out competencies the assessment genuinely measures.

In step 6 (preview), surface the suggested alignment and ask whether to call them out explicitly in the `description` slot. If the teacher already told you which competency they're targeting, treat that as authoritative.

If `list_competencies` returns `configured: false`, skip this step entirely.

### 6. Preview before creating the draft

Show the teacher an outline of what each slot will contain, plus the suggested competency alignment if you identified one in step 5:

```
Assessment draft — "Watershed Unit Test"
Kind: in-class MC test • 20 points • group: Tests (15%) • 45 minutes • due Fri Oct 16

• Description: 20-question MC test on watershed geography
• Pre-Work: 4-item review checklist (lesson pages, worksheet, textbook, practice quiz)
• Structure & Grading: 20 × 1pt, no partial credit; 15% weight; grade boundaries table (A+ = 20, A = 19, ..., F = 0-9)
• Submission: In-class on paper, hand in to teacher
• Time: 45 min standard, 60 min extended
• AI Use: Default policy for closed-book test (no AI tools allowed)
• Parent portal: yes • Final assessment: no

Suggested competencies this assessment evaluates: Knowledge-Based Reasoning + Systems Thinking.
Want me to call these out explicitly in the description, or keep them implicit?

Ready to create this as a draft in Canvas?
```

Wait for approval or revision requests. If the teacher asks for changes, iterate on the affected slots — don't regenerate everything.

### 7. Create the draft in Canvas

**Default (assignment):** call `create_assignment` with the assessment template — the server wraps the description, composes the title, and creates it unpublished:

```
create_assignment(
  course_identifier: "<course code or id>",
  name: "<assessment name>",
  template: "assessment",
  fair_asmt: <true if posting to the parent portal>,
  final_asmt: <true if a final/culminating assessment>,
  assignment_group: "<group name or id from step 1b>",
  due_at: "<ISO due date>",
  points_possible: <total points>,
  submission_types: [...],          // e.g. ["online_upload"] or ["on_paper"]
  asmt_percent: <only if the group had no usable weight>,
  slots: {
    description: "...",
    pre_work: "...",
    structure_and_grading: "...",
    submission: "...",
    time: "...",
    ai_use: "..."
  }
)
```

The response includes:

- **`suggested_title`** — the title composed to the school's format (type from the group, week from the calendar, percent from the group weight, FAIR/FINAL flags). Propose it to the teacher; if they accept and it differs from the `name` you created with, apply it via `update_assignment(name: suggested_title)`.
- **`warnings[]`** — including the precise reason if the week is `?` (break / outside the year). Relay these to the teacher in their words.

**Page variant (only when the teacher wants a standalone page):** `create_page(course_identifier, title, template: "assessment", slots: {...same 6...})`, rendering the title yourself from `title_format`. For the `{week}` value, use the due date only if the server has confirmed the week for that date elsewhere (e.g., a parallel `create_assignment` response) — otherwise ask the teacher which week number to print. Never compute it with raw date math.

Confirm to the teacher with the artifact's `html_url` from the response:

> Created draft assessment **Test: Watershed Unit Test [Week 8] 15% FAIR ASMT** in DSGN 9. It's saved as a draft — open it in Canvas at <html_url>, review, and click **Publish** when you're ready.

**Never tell the teacher you "published" anything.**

### 8. Module placement (only if asked)

If the teacher said "add it after the watershed lesson," call `list_modules(course_identifier, include_items: true)`, find the right module + position, then `add_module_item`:

- Assignment: `add_module_item(type: "Assignment", content_id: <assignment id>, title: ..., position: <n>)`
- Page: `add_module_item(type: "Page", content_id: "<page-slug>", title: ..., position: <n>)`

## Updating an existing assessment

Use `update_assignment` with the same template machinery — pass `template: "assessment"` plus **all 6 slots** to rebuild the description (the MCP doesn't preserve previous slot content from the on-Canvas HTML). Re-applying the assessment template requires the same three answers (parent-portal flag, final flag, assignment group) — reuse them from the conversation, or ask again in plain language. If you don't have the slot content from earlier in the conversation, call `get_assignment_details` first and reconstruct from what's visible, OR ask the teacher what should stay vs. change.

For the page variant: `edit_page_content(course_identifier, page_url, template: "assessment", slots: {...all 6...})` — never `create_page` (that makes a `-2` slug duplicate).

## Linking from a lesson page

If the teacher asks to link this assessment from a lesson page (e.g., "add it as the related assessment on the watershed lesson"), use `edit_page_content` on the lesson:

```
edit_page_content(
  course_identifier: ...,
  page_url: "<lesson-slug>",
  template: "lesson",
  include_sections: ["assessment"],   // turn on the assessment section if not already
  slots: {
    ...all lesson slots...,
    assessment: '<p>See <a href="<html_url from the create response>">Watershed Unit Test</a>, due Friday.</p>'
  }
)
```

Same caveat: you must provide all the lesson's slots in the rebuild. Use the assignment's real `html_url` — never construct URLs.

## Common mistakes to avoid

- **Don't compute the academic week yourself.** The server derives it from the school's week calendar (breaks included) and tells you exactly why when it can't. Raw date math produces wrong weeks whenever the year has a break.
- **Don't ask the teacher for the weighting from memory.** It comes from the Canvas assignment group's weight (`list_assignment_groups`). Only fall back to asking (or the syllabus) when the group has no usable weight.
- **Don't surface parameter names.** Ask "should this be posted to the parent reporting portal?" — never "should I set fair_asmt?".
- **Don't offer to skip the school template, and don't ask whether to create as a draft.** Templating is the default; drafts are always drafts.
- **Don't use `create_page` for updates.** Use `update_assignment` / `edit_page_content` — same template machinery, no duplicate.
- **Don't generate grade boundaries with rounding bugs.** Verify each grade has a sensible point range for the total. For small point totals where percentages collapse, either bump to a bigger total or use percentage thresholds explicitly.
- **Don't use a generic AI policy.** Match it to the assessment type. A take-home essay has very different AI rules than a closed-book test.
- **Don't pad pre-work with generic items.** If you don't know what the unit covered, ask. "Review your notes" is not pre-work.
- **Don't make up Canvas URLs.** Use `html_url` from tool responses.
- **Never publish.** The MCP forces `published: false`; don't try to flip it, don't suggest you have, and don't tell the teacher you "published" anything.
