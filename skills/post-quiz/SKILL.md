---
name: post-quiz
description: Build and post a Canvas Quiz (the actual graded object with questions) as a draft from source content the teacher provides — a Canvas lesson page, a PDF reading, a Google Doc, or plain text. Use when the teacher says "post a quiz", "create a quiz", "make a quiz", "build a Canvas quiz", "generate quiz questions", "convert this quiz to Canvas", or drops in a document and wants quiz questions from it. Drafts AI-generated questions OR extracts existing ones from a pre-written quiz doc; teacher reviews with source citations, edits, and the skill creates the Canvas Quiz as a draft. Composes with plan-assessment for quiz-style assessments.
---

# Post Quiz

Draft and create a Canvas Quiz with AI-generated (or extracted) questions, anchored to source citations the teacher can verify in seconds. Always a draft. Teacher publishes manually.

> **This skill never publishes anything.** The Canvas Quiz is created with `published: false` (enforced server-side by the MCP). Teachers review in Canvas and click **Publish** themselves when ready. This is a hard policy — don't try to flip the published flag, and don't describe what the skill does as "publishing."

## When to use

A teacher wants a Canvas Quiz built from something they have. Common phrasings:

- "Create a quiz on the water cycle from this lesson page"
- "Convert this Word doc / PDF / Google Doc to a Canvas quiz"
- "Make 10 multiple-choice questions about my photosynthesis reading"
- "I have a paper quiz I need to put in Canvas — here it is"
- "Quiz this lesson — 20 questions, no essay"
- "Add the actual quiz object for the assessment page I just made" (compose-with-plan-assessment case)

## When NOT to use

- **Just a Canvas Page describing an assessment** (no actual quiz questions inside) — that's `plan-assessment`. Some assessments need BOTH a description page (plan-assessment) AND a graded quiz object (post-quiz) — they compose, see "Linkage with plan-assessment" below.
- **Wholesale rebuilding an existing Canvas Quiz** — prefer editing in place: the MCP has `list_quizzes` / `get_quiz` to inspect, `update_quiz` for settings, and `update_quiz_question` / `delete_quiz_question` / `create_quiz_question` for question-level edits. On New Quizzes, `question_id` in the edit/delete tools is the **item id** from `get_quiz` → `items[].id`. There is no `delete_quiz` tool — removing a whole quiz is a Canvas-UI action.

## Prerequisites

- canvas-mcp installed and configured (**v0.5.0+**, the New Quizzes release).
- **New Quizzes** enabled in the target Canvas course (Canvas's default). This skill builds a New Quiz via the `/api/quiz/v1` service. Classic Quizzes are no longer supported by these tools.
- For Google Docs input: the **Claude Drive MCP** (already authenticated in the Claude.ai / Claude Desktop session).
- A school config is not required. `list_competencies` is consulted only if the teacher asks for competency-aligned questions.

## Workflow

### 1. Capture inputs + precondition checks

Confirm with the teacher (asking only for what's missing):

- **Which Canvas course?** Code or numeric id. If ambiguous, call `list_courses` and confirm the match.
- **What's the source content?** A Canvas Page URL, a PDF file, a Google Doc URL, or text pasted into chat.
- **What's the quiz title?** Propose one based on the source topic if the teacher gave only a description.

Then run **two precondition checks** before any drafting:

#### 1a. Source sufficiency check

Read the source via the appropriate tool:

- **Canvas Page URL**: `get_page_content(course_identifier, page_url)`. Strip the template HTML wrapper (the lesson template's banner, nav, accordion chrome) — only the substantive content inside the slots is testable material.
- **PDF**: Use Read tool natively.
- **Google Doc**: extract the file id from the URL (between `/d/` and the next `/`), then `mcp__claude_ai_Google_Drive__read_file_content(fileId: "<id>")` (note the camelCase `fileId` parameter — the Drive MCP does not use snake_case).
- **Plain text**: use what's in the chat directly.

Estimate testable-proposition density of the source. Rough heuristic: word count + number of distinct concrete claims / facts / definitions / examples. A 1,000-word Canvas Page with rich content can easily support 10 questions. A 200-word lesson page with three bullet points cannot — that's maybe 4–5 questions.

If the source is too thin for the requested question count, propose a smaller N or ask for more material:

> This source is about 200 words and covers ~4 distinct concepts (watershed definition, runoff, infiltration, evapotranspiration). I can reliably generate 4–5 questions about it. Want fewer questions, or supplement the source with another page / your lecture notes / the textbook chapter?

#### 1b. Mode selection (generation vs conversion)

If the source has **clear quiz-like structure** (numbered question list, "(a) (b) (c)" lettered options, "T/F:" or "True/False:" prefixes, an "Answer Key" header, etc.), ASK the teacher explicitly:

> I see structured questions in this source — should I **extract them as-is** (conversion mode: I'll convert your existing quiz to a Canvas Quiz, preserving your questions and answers), or **use this as reference to generate new questions about the same topic** (generation mode: I'll draft fresh questions)?

If the source has no quiz-like structure, default to generation mode silently (the teacher's intent was clearly to generate from reference content).

**Do not auto-detect silently.** If you're unsure whether the input is a quiz or reference content, ask.

### 2. Draft the questions

(Note: there is no separate "spec preview" step. The default spec is applied directly and shown at the top of the draft table — the teacher adjusts the mix in the same review loop.)

**Default spec** (used unless the teacher specified otherwise up-front):

- **10 questions**
- **Type mix: 7 MC + 2 short_answer + 1 multiple_answers**
- **1 point per question** → 10 points total
- **No time limit**
- **1 attempt allowed**
- **shuffle_answers: true**, **show_correct_answers: false**

If the teacher specified different parameters in their initial request ("20 questions, all MC, 15 minutes"), use those instead.

**Supported question types (New Quizzes):** `multiple_choice`, `true_false`, `multiple_answers`, `short_answer`, `essay`, `matching`, `ordering`. Two behavior notes that come from New Quizzes:

- **`short_answer` and `essay` are manually graded.** New Quizzes has no auto-graded fill-in item — `short_answer` becomes an essay item, and the accepted-answer variants you write are attached as **grader notes** the teacher sees in SpeedGrader. Both types require the teacher to grade each response by hand.
- **No `text_only` "section divider" questions** — New Quizzes can't author them via API. Don't offer them; if a source has divider text, fold it into the next question's stem or leave it out.

**Source-coverage rule:** Before drafting individual questions, identify the source's distinct sections / topics. Distribute questions across them proportional to section length, unless the teacher specifies a focus. Don't let all 10 questions cluster on the first paragraph.

For each question, generate:

1. The question stem (the prompt)
2. The correct answer
3. Distractors (for MC) or incorrect options (for MA)
4. **A source citation** — a verbatim quote from the source OR a specific reference (paragraph number, section heading, slide number, page number). This is mandatory. Questions without a source citation are not approved-ready.

### Stable question IDs

Assign every question a stable letter ID: `Q-A`, `Q-B`, `Q-C`, …, `Q-J` (and `Q-K`, `Q-L`, … for longer quizzes). **These IDs do not renumber when questions are removed.** If the teacher drops `Q-C`, the remaining questions stay `Q-A`, `Q-B`, `Q-D`, `Q-E`, … New questions added during review get the next available letter (`Q-K`, `Q-L`, …).

### Draft-table format

Present all questions in a single markdown table with the spec preamble on top:

```
Planned quiz: "Watershed Unit Quiz" (course DSGN 9)
Source: Canvas Page "The Water Cycle"
Spec: 10 questions • 7 MC + 2 SA + 1 MA • 10 points • No time limit • 1 attempt
Coverage: 4 questions on watershed structure, 4 on the cycle phases, 2 on human impact

| ID  | Type | Question | Correct | Distractors / Notes | Pts | Source citation |
|-----|------|----------|---------|---------------------|-----|-----------------|
| Q-A | MC | What drives the water cycle? | the Sun | gravity; plate tectonics; atmospheric pressure | 1 | "Solar energy drives evaporation, the engine of the water cycle" (paragraph 2) |
| Q-B | MC | Which is NOT a phase of the water cycle? | sublimation | precipitation; evaporation; runoff | 1 | "The four main phases are precipitation, evaporation, condensation, and runoff." (paragraph 4) |
| Q-C | T/F | All watersheds drain to the ocean. | False | — | 1 | "Endorheic watersheds drain to interior basins, not the ocean" (paragraph 6) |
| Q-D | SA | What is evapotranspiration? | (accepts: the combined process of evaporation and plant transpiration; water moving from plants AND soil into the atmosphere) | — | 1 | "Evapotranspiration is the combined process by which water is transferred from the land to the atmosphere via evaporation from soil and transpiration from plants" (paragraph 3) |
| Q-E | MA | Which of these are types of precipitation? (select all) | Correct: rain; snow; sleet; hail | Incorrect: dew; runoff | 1 | "Precipitation forms include rain, snow, sleet, and hail" (paragraph 5) |
| ... | ...  | ... | ... | ... | ... | ... |
```

**Per-type column conventions:**

| Type | `Correct` content | `Distractors / Notes` content |
|---|---|---|
| `multiple_choice` | Single correct answer text | The 3 incorrect option texts, semicolon-separated |
| `true_false` | "True" or "False" | `—` |
| `short_answer` | `(accepts: A; B; C)` listing accepted variants (kept as SpeedGrader grader notes — **manually graded**) | `—` |
| `essay` | `(grading notes, optional)` — **manually graded** | `—` |
| `multiple_answers` | `Correct: A; B; C; D` (correct options) | `Incorrect: X; Y` (incorrect options) |
| `matching` | `Left → Right` pairs, one per line | Optional extra unmatched right-side options as `Distractors: X; Y` |
| `ordering` | The items in their **correct order**, numbered | Optional `Top label` / `Bottom label` |

### 3. Teacher review loop

The teacher can:

- **Approve the whole batch** — "looks good, create it" / "go ahead" / "ship it"
- **Edit individual questions by ID** — "change Q-B — sublimation IS a phase, swap the answer with evapotranspiration as the correct response"
- **Batch-edit** — "rewrite all MC questions to be harder" / "make the questions reference the lesson's diagrams more"
- **Flag for redraft** — "redraft Q-E to focus on watershed runoff instead of precipitation"
- **Add questions** — "add 2 more short-answer questions about evapotranspiration"
- **Remove questions** — "drop Q-G" (Q-G is gone; the other questions keep their IDs)

**Multi-edit messages** are parsed and all operations applied in one pass. Example: *"Change Q-A — the answer should be 'evaporation' not 'the Sun', also drop Q-C and add a question about runoff"* — apply all three operations together, then re-print the full table.

**After every edit, re-print the full canonical draft table** so the teacher always sees the current state. This is the source of truth across turns. Don't just describe the change — show the updated table.

Iterate until the teacher gives explicit approval. Don't proceed until they confirm.

### 4. Confirm quiz settings

Before creating the Canvas Quiz, confirm:

- **Title** (already confirmed in step 1)
- **Description** — auto-generated from the spec ("10 questions on watershed geography, 10 points total, no time limit") but the teacher can edit it. Optional but useful.
- **Time limit** — default none; ask if the teacher wants one
- **Allowed attempts** — default 1; ask if different
- **Due at** — optional ISO timestamp

Other settings get sensible defaults passed explicitly on the `create_quiz` call: `shuffle_answers: true`, `show_correct_answers: false` (New Quizzes' own default is to SHOW correct answers, so this must be sent). `quiz_type` is accepted but ignored by New Quizzes — you can omit it.

### 5. Create the Canvas Quiz

Two-step:

#### 5a. Create the quiz container

```
create_quiz(
  course_identifier: <course>,
  title: "Watershed Unit Quiz",
  description: "<auto-generated or teacher-confirmed description>",  // becomes the quiz instructions
  time_limit: <minutes if specified, otherwise omit>,
  allowed_attempts: 1,
  shuffle_answers: true,
  show_correct_answers: false,
  due_at: "<ISO timestamp if specified>"
)
```

(New Quizzes require canvas-mcp **v0.5.0+**.)

The quiz is created **unpublished** (forced by the MCP). Capture the returned `quiz_id` (which is the New Quiz's assignment id) and the `html_url` from the response — you'll need both. All item calls in step 5b use that `quiz_id`.

#### 5b. Add each question

For each question in the approved draft (in their stable-ID order, which is also the order the teacher sees them), call:

```
create_quiz_question(
  course_identifier: <course>,
  quiz_id: <from step 5a>,
  question: {
    question_name: "Question N",  // or use a short stem-derived name
    question_text: "<the stem, with HTML formatting if useful>",
    question_type: "multiple_choice_question",  // or other types per spec
    points_possible: 1,
    answers: [
      { answer_text: "the Sun", answer_weight: 100 },
      { answer_text: "gravity", answer_weight: 0 },
      { answer_text: "plate tectonics", answer_weight: 0 },
      { answer_text: "atmospheric pressure", answer_weight: 0 }
    ],
    neutral_comments: "Source: 'Solar energy drives evaporation, the engine of the water cycle' (paragraph 2 of the Water Cycle lesson page)"
  }
)
```

**Answer encoding.** The MCP keeps the friendly `answer_weight` 100/0 convention and translates it into the New Quizzes item schema (generating UUIDs and scoring data for you). By type:

- **multiple_choice** (`question_type: "multiple_choice_question"`): one answer has `answer_weight: 100`, the others `answer_weight: 0`.
- **true_false** (`"true_false_question"`): two answers (True / False), the correct one has `answer_weight: 100`.
- **short_answer** (`"short_answer_question"`): each accepted variant is a separate answer entry with `answer_weight: 100`. In New Quizzes this becomes a **manually-graded essay** with your accepted variants attached as grader notes — the teacher grades each response by hand.
- **essay** (`"essay_question"`): no `answers[]` needed; pass grading guidance in `neutral_comments`. Manually graded.
- **multiple_answers** (`"multiple_answers_question"`): every correct option `answer_weight: 100`, every incorrect option `answer_weight: 0`. Students must select all corrects + no incorrects for full credit.
- **matching** (`"matching_question"`): instead of `answers[]`, pass `matches: [{ left, right }]` (prompt → correct answer). Optional `distractors: ["..."]` adds extra unmatched right-side options.
- **ordering** (`"ordering_question"`): instead of `answers[]`, pass `ordering_items: ["First", "Second", ...]` in the **correct order**. Optional `ordering_top_label` / `ordering_bottom_label`.

Example — a matching item:

```
create_quiz_question(
  course_identifier: <course>,
  quiz_id: <from step 5a>,
  question: {
    question_name: "Cellular respiration locations",
    question_text: "Match each pathway to its subcellular location.",
    question_type: "matching_question",
    points_possible: 3,
    matches: [
      { left: "Glycolysis", right: "Cytoplasm" },
      { left: "Citric Acid Cycle", right: "Mitochondrial Matrix" },
      { left: "Oxidative Phosphorylation", right: "Inner Mitochondrial Membrane" }
    ],
    distractors: ["Peroxisome"],
    neutral_comments: "Source: 'Respiration stages and their locations' (Table 2, cellular respiration handout)"
  }
)
```

**Embed the source citation in `neutral_comments`** so it stays with the question in Canvas (visible in the SpeedGrader and the question editor) — this gives teachers the citation when they later edit the question, not just in the chat that drafted it.

#### 5c. Partial-failure policy

If `create_quiz` succeeds but one or more `create_quiz_question` calls fail:

1. **Continue attempting the remaining questions** — don't abort the batch on one failure.
2. **Track every failure**: which question ID, what Canvas returned (status code + error message), what was in the payload.
3. **Do NOT auto-delete the partially-built quiz** — there's no `delete_quiz` MCP tool, and the teacher may prefer to keep the partial draft and add the failed questions manually.
4. Surface the partial state clearly in step 6.

### 6. Confirm to teacher

**On full success**, use the `html_url` from the `create_quiz` response (don't construct it):

> Drafted **Watershed Unit Quiz** in DSGN 9 — 10 questions, 10 points, no time limit. Saved as a draft.
>
> Open in Canvas at <html_url from create_quiz response>, review the source citations on each question, and click **Publish** when you're ready.

**If the quiz includes any `short_answer` or `essay` questions, add this warning to the confirmation:**

> Heads up on the short-answer/essay questions (Q-X, Q-Y): New Quizzes doesn't auto-grade these — they come through as essay items you grade by hand in SpeedGrader. The accepted answers you wrote are attached as grader notes so you have the answer key right there while grading.

**On partial success**:

> Drafted **Watershed Unit Quiz** in DSGN 9 — **8 of 10 questions created** (2 failed; details below). Saved as a draft.
>
> Failed:
> - **Q-E** (matching): Canvas returned 422 — invalid item payload
> - **Q-G** (multiple_answers): Canvas returned 500 — server error
>
> Want me to retry the 2 failed questions? Or open in Canvas at <html_url> and add them manually.

**Never tell the teacher you "published" the quiz.** It's a draft until they publish manually.

## Conversion mode (when chosen explicitly at step 1b)

When the teacher confirmed conversion mode, the workflow changes in these ways:

- **Step 2 (drafting) becomes extraction.** Instead of generating questions from reference content, parse the source's existing questions:
  - Look for numbered/lettered question lists (`1.`, `2.`, `(a)`, `(b)`, `(c)`)
  - Identify question type from structural cues: `(a)/(b)/(c)/(d)` → MC; "True/False:" → T/F; long write-in space or "Essay:" → essay; short fill-in → short_answer (manually-graded essay); "Select all that apply" → multiple_answers; "Match the following" / two-column lists → matching; "put in order" / "sequence" → ordering
  - Map answer keys (if present in the source) to correct answers. If no answer key is provided, mark the correct answer as unknown and flag for the teacher to fill in.
- **Source citation becomes location reference**: "page 2, question 3 of the original PDF" instead of a verbatim quote.
- **Flag low-confidence extractions** in the draft table with a specific reason: "question stem was truncated by a page break — verify it's complete", "answer key wasn't in the source — please fill in the correct answer", "this question's format doesn't fit any supported type — manual review needed".
- **All other steps (3, 4, 5, 6) are the same** as generation mode.

## Linkage with plan-assessment

When the teacher's broader workflow involves a **quiz-style assessment**, two artifacts are typically needed: a Canvas Page describing the assessment (`plan-assessment`) AND the actual Canvas Quiz object with questions (`post-quiz`). The two skills compose, with **enforced linkage**:

### When `plan-assessment` finishes and the assessment type was "test" or "quiz"

`plan-assessment` offers the handoff explicitly:

> Want me to create the actual Canvas Quiz for this assessment now? I'll use the spec you just confirmed (20 MC questions, 1 point each, 45 minutes, no AI tools allowed). Just say "yes" or run `/post-quiz` and I'll inherit those values.

### When `post-quiz` runs in a course with a matching plan-assessment page

At step 1, before asking the teacher for spec details, call `list_pages(course_identifier)` and look for a page whose title matches the proposed quiz title (or is provided as context). If you find a match, call `get_page_content(course_identifier, page_url)` and **read the spec from the page** — title, point total, type mix (from the description slot), time limit, weighting, AI-use policy. Tell the teacher:

> I see you have a plan-assessment page titled **Watershed Unit Test** in this course. I'll use its spec as the starting point: 20 questions, 1 point each, 45 minutes, no AI tools, manual posting. Sound good? Or want to override anything?

### Drift detection

If the teacher edits the quiz spec during review and it diverges from the linked plan-assessment page, surface the drift before creating:

> Heads up — your plan-assessment page says **20 questions, 1 point each (20 points)**, but the draft now has **15 questions for 15 points total**. Want me to:
> - Update the plan-assessment page to match the new quiz?
> - Update the quiz to match the page?
> - Keep them divergent (you'll have to remember to update the page yourself)?

## Quality requirements

- **Source-quote anchoring is mandatory.** Every drafted question MUST cite a verbatim source quote or a specific source reference. Questions without a citation are not approved-ready; the table flags them for the teacher to fill in.
- **Coverage and balance.** Questions distribute across the source's identifiable sections proportional to section length, unless the teacher specifies a focus. Show the planned coverage in the table preamble so the teacher can spot clustering bias before reviewing individual questions.
- **Distractor quality.** For MC, distractors must be plausible but wrong. No "Earth is square" obvious-wrong choices. Distractors should be similar in length and grammatical form to the correct answer.
- **No double-negatives or ambiguous wording.** Each question tests one concept. Avoid "all of the above" / "none of the above" unless the teacher specifically requested them.
- **Multiple-answers needs both halves verified.** For MA questions, the source citation must support both *which options are correct* AND *which options are incorrect*. The draft table shows correct and incorrect option lists separately for this reason.
- **Bloom's level matching.** When the teacher specifies "test recall" vs "test application", question stems use appropriate verbs (identify/describe/list for recall; apply/analyze/explain for application).
- **Source faithfulness.** Generation-mode questions must be answerable from the source content. If a question's correct answer requires knowledge not in the source, fix the question or flag it as out-of-scope.

## Common mistakes to avoid

- **Don't auto-detect generation vs conversion silently.** When the input has quiz-like structure, ASK the teacher which mode they want (step 1b). Misdetection silently produces the wrong artifact.
- **Don't use ✅ / ⚠️ to suggest the skill has verified correctness.** The skill DOES NOT self-verify. Source-quote citations are the safeguard; teacher review is the gate. Don't manufacture false confidence with green checkmarks.
- **Don't renumber question IDs when the teacher removes a question.** Q-A, Q-B, Q-D, Q-E (skipping Q-C) is correct after dropping Q-C. Renumbering breaks references the teacher made in earlier turns.
- **Don't generate without a source citation.** Every question needs one — verbatim quote or specific reference. If the source genuinely doesn't ground a correct answer, that's a problem with the question, not a citation to skip.
- **Don't cluster questions on one section of the source.** Show planned coverage in the draft-table preamble so the teacher can catch clustering bias.
- **Don't promise auto-grading for `short_answer` or `essay`.** New Quizzes makes both manually-graded essay items. Tell the teacher they'll grade those by hand (the accepted answers ride along as grader notes).
- **Don't try to author `text_only` dividers or Stimulus passages.** New Quizzes can't create them via API. Fold divider text into a question stem or leave it out.
- **Don't auto-delete a partially-failed quiz.** There's no `delete_quiz` MCP tool. List the failed questions, offer retry, leave the partial for the teacher to clean up.
- **Don't fabricate `html_url`.** Use the `html_url` field from the `create_quiz` response (the MCP constructs it from the New Quiz's assignment id). Don't hand-build a URL yourself.
- **Don't tell the teacher you "published" anything.** Quizzes are drafts. Teachers publish manually in Canvas. Use "drafted" or "created as a draft" — never "published."
- **Don't try to mimic the teacher's voice.** Default question phrasing only. Voice/tone matching is the teacher's manual edit step if they want it.

## Example

**Teacher:** "Create a 10-question quiz for DSGN 9 on this watershed lesson page: https://yourschool.instructure.com/courses/914/pages/the-water-cycle"

**Skill walks through:**

1. Confirms course 914 (DSGN 9), proposed title "Water Cycle Quiz".
2. Calls `get_page_content` → reads the Water Cycle lesson page → ~800 words across 5 sections. Sufficient for 10 questions.
3. Source has no quiz-like structure → generation mode (no explicit ask needed).
4. Drafts 10 questions per default spec (7 MC + 2 SA + 1 MA, 1 pt each), distributes across the 5 sections (2 per section), every question with a source citation.
5. Presents the draft table with spec preamble + coverage line + 10 rows with Q-A through Q-J.
6. Teacher reviews — says "Q-B's correct answer is wrong, sublimation IS a phase; swap with 'condensation' as the wrong option" and "make Q-D harder."
7. Skill applies both edits, re-prints the full table. Teacher says "looks good, create it."
8. Skill confirms quiz settings — title, no description override, no time limit, 1 attempt, no due date.
9. `create_quiz` → returns quiz_id (the New Quiz's assignment id) and html_url.
10. Loop `create_quiz_question` 10 times. All 10 succeed. Each question's `neutral_comments` includes the source citation.
11. Confirms to teacher: "Drafted **Water Cycle Quiz** in DSGN 9 — 10 questions, 10 points, no time limit. Saved as a draft. Open in Canvas at <html_url>, review the source citations on each question, and click **Publish** when you're ready."

Total elapsed teacher time: ~4 minutes including review.
