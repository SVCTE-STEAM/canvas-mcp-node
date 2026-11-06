# Canvas for Teachers (SVCTE edition)

A Claude Desktop extension that lets Claude work in your Canvas courses — draft lesson pages, build modules, grade with rubrics, check on your classes, message students, run accessibility and course-quality checks — while **you approve everything that students will see**.

- **Teacher-only.** There are no student tools.
- **One-click install on Windows and Mac.** No Python, no terminal: Claude Desktop runs it with its built-in Node.js.
- **Student privacy by default.** Claude sees students as `Student 1`, `Student 2`, … never their real names.

Built on [Jaymes Dec's canvas-mcp-node](https://github.com/awesome-town/canvas-mcp-node) (Franklin School) and [Vishal Sachdev's canvas-mcp](https://github.com/vishalsachdev/canvas-mcp). MIT licensed.

---

## Install (3 minutes)

1. Download **`canvas-mcp-svcte-<version>.mcpb`** from this repo's [Releases](https://github.com/SVCTE-STEAM/canvas-mcp-node/releases) page (or from wherever your colleague shared it).
2. **Double-click** the file. Claude Desktop opens an install dialog. (If it doesn't: Claude Desktop → Settings → Extensions → drag the file in.)
3. Fill in:
   - **Canvas URL** — your Canvas address, e.g. `https://yourschool.instructure.com`.
   - **Canvas access token** — in Canvas: *Account → Settings → + New Access Token*. Copy and paste it. It is stored in your computer's keychain and only sent to your Canvas address.
   - Leave the other settings as they are.
4. Make sure the extension is **enabled**, then start a new chat and ask: *"List my Canvas courses."*

### Add the skills (recommended)

Skills teach Claude *how* to do common teaching jobs well (plan a lesson, run a morning check, QC a course). Download the skill `.zip` files from the release, then in Claude Desktop: **Settings → Capabilities → Skills → Upload skill**, one zip at a time. (Claude Code / Cowork users can install `canvas-teaching-skills.plugin` instead, which contains all of them.)

| Skill | Say something like… |
|-------|---------------------|
| `canvas-morning-check` | "Morning check for Auto Tech" |
| `canvas-course-qc` | "Is my Culinary 1 course ready for students?" |
| `canvas-accessibility-auditor` | "Audit accessibility in Medical Assisting" |
| `canvas-discussion-facilitator` | "Who hasn't posted in this week's discussion?" |
| `canvas-peer-review-manager` | "How are peer reviews going on the portfolio critique?" |
| `canvas-course-builder` | "Copy last year's course structure into my new shell" |
| `plan-lesson` / `post-lesson-page` | "Plan a lesson on brake systems" → "Post it to Canvas" |
| `plan-assessment` / `post-quiz` | "Draft a 15-question quiz from this lesson page" |
| `plan-module` / `plan-course` | "Plan a 4-week module on food safety" |
| `setup-rubric` | "Use the lab report rubric for Assignment 6" |
| `grade-submissions` | "Grade the knife-skills reflection with the rubric" |

---

## What stays safe

**Student names never reach Claude.** Every student comes back as a stable pseudonym (`Student 7` is the same student next week and in every chat). Teachers and TAs appear by name. When you message students, write `{first_name}` and the real name is filled in **on your computer** at send time — Claude still never sees it.

**Nothing publishes itself.**
- Pages, modules, assignments, quizzes and discussions are created **unpublished**. You publish them in Canvas.
- Announcements are always **scheduled** at least 30 minutes ahead, so you can review or delete them.
- Grades follow your assignment's posting policy (manual posting keeps them hidden until you post).

**Preview, then approve.** Messages to students, discussion posts and replies, bulk page edits, syllabus replacement, accessibility fixes, peer-review assignments and course copies all work in two steps: Claude first gets a **preview** (who, what, how many) and a one-time code, and only after you approve does a second call — with that exact code and the exact same content — do it. If anything changes after the preview, the code stops working.

**Your token stays on your computer.** It is only sent to your Canvas address.

**Code execution is off.** The advanced `execute_typescript` tool (Claude writing and running code for very large batch jobs) is disabled unless you turn it on in the extension's settings.

### Installer settings

| Setting | Default | Meaning |
|---------|---------|---------|
| Canvas URL | — | Your Canvas address. |
| Canvas access token | — | Your personal token (stored in the OS keychain). |
| Allow real student names in Claude's view | Off | Turn on only for a task that truly needs real names, then off again. |
| School config file | (blank) | Optional JSON with your school's competency framework and page templates. Blank = the bundled plain templates (`configs/generic.json`). See [`docs/SCHOOL_CONFIG.md`](docs/SCHOOL_CONFIG.md) and [`configs/example.json`](configs/example.json). |
| Enable execute_typescript | Off | Advanced batch scripting. |

---

## What Claude can do (99 tools)

- **Courses & structure:** list courses, course details, full module/item tree, syllabus, front page, content overview, files list, course copy into a new shell.
- **Modules & pages:** create/update modules and items; create (draft), edit and delete pages; template-based lesson/assessment pages; bulk page settings.
- **Assignments, quizzes & rubrics:** create (draft) and update assignments; New Quizzes with questions; find, create and attach rubrics.
- **Grading:** grade one submission, grade with a rubric, bulk-grade with a dry run; read submissions and rubric assessments; download attachments.
- **Discussions & announcements:** list/read topics and entries (names pseudonymized), create draft topics, reply and post (preview first), scheduled announcements.
- **Messaging:** inbox, conversations, unread count; personalized messages to students (preview first).
- **Analytics:** assignment analytics (submission rates, score stats, who's missing) and student analytics.
- **Peer reviews:** assignments, completion, follow-up lists, comment quality, problem reviews, reports, reminders.
- **Accessibility:** scan pages/assignments for common WCAG issues, UFIXIT report parsing, safe mechanical fixes (preview first).
- **People:** roster and enrollments (pseudonymized), groups.

Ask Claude *"What can the Canvas tools do?"* for the full list.

---

## Troubleshooting

- **"Missing required environment variable"** — open Settings → Extensions → Canvas for Teachers and fill in the URL and token.
- **401 / Unauthorized** — the token was mistyped or has expired; make a new one in Canvas.
- **"requires account-admin scope"** — that tool needs a Canvas admin token; teacher tokens can't use it.
- **A preview keeps coming back instead of sending** — that's by design until you approve; Claude must call again with the `confirmation_token` and the identical content.
- Logs: Claude Desktop → Settings → Developer → open logs folder (`mcp-server-canvas-mcp-svcte.log`).

---

## For maintainers

Requires Node.js 20+ (22 LTS recommended).

```bash
npm ci
npm test              # vitest
npm run build:mcpb    # → build/mcpb/canvas-mcp-svcte-<version>.mcpb
npm run build:skills  # → build/skills/*.zip and canvas-teaching-skills.plugin
```

Release: bump `version` in `manifest.json`, `package.json` and `SERVER_VERSION` in `src/index.ts`, build both, and attach the `.mcpb`, the skill zips and the `.plugin` to a GitHub Release.

Design notes and invariants: [`CLAUDE.md`](CLAUDE.md). Ideas backlog: [`docs/IDEAS.md`](docs/IDEAS.md). Upstream history and the Python → TypeScript migration: [`docs/MIGRATION.md`](docs/MIGRATION.md).

To pull improvements from Jaymes's upstream: `git fetch upstream && git merge upstream/main`.
