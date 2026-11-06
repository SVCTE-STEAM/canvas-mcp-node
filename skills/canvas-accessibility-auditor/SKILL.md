---
name: canvas-accessibility-auditor
description: Accessibility audit and remediation for a Canvas LMS course — scan pages, assignments and the syllabus for common WCAG problems (missing alt text, empty or skipped headings, tables without headers, vague link text, low contrast and more), report by priority, apply safe fixes with teacher approval, re-scan, and write a summary. Use when the teacher says "audit accessibility", "check WCAG", "is my course accessible", "fix accessibility issues", or "accessibility review".
---

# Canvas Accessibility Auditor

Scan → prioritized report → guided fixes (teacher approves every change) → re-scan → summary.

## Steps

### 1. Course

Resolve the course with `list_courses`. If none was named:

> Which course should I audit for accessibility?

### 2. Scan

- **Built-in scan (always):** `scan_course_content_accessibility` (course, `content_types`: `"pages,assignments"` by default; add `syllabus` to include it). Results are grouped per page/assignment with an `issue_types` legend (WCAG criterion and level for each issue type).
- **UFIXIT / UDOIT report (only if the school uses it):** `fetch_ufixit_report` (course; `page_title` if the report page has a different name) → `parse_ufixit_violations` (the report) → `format_accessibility_summary` (the parsed violations). If the course has no report page, the tool says so — skip this part and rely on the built-in scan.

### 3. Prioritized report

```
## Accessibility Audit: HLTH-1 AM
Scanned: 22 pages · 14 assignments · syllabus
Issues: 15 (Level A: 9 · Level AA: 4 · other: 2) · auto-fixable: 5

### Level A (must fix)
1. Images missing alt text — 5 images on 3 pages
   - "Week 1 Overview" (2), "Lab Instructions" (2), Assignment "Final Project" (1)
2. Tables without header cells — 2 tables ("Grade Scale", "Schedule")
3. Vague link text ("click here") — 3 links

### Level AA (should fix)
4. Empty or out-of-order headings — 2 pages

### Needs a human check (can't be tested automatically)
- Color contrast in images, captions on videos, accessibility of uploaded PDFs/slides
```

### 4. Fixes

**Automatic, mechanical fixes** — `fix_accessibility_issues` (course, `fix_types`, `content_types`). Available `fix_types`:

| fix_type | What it does |
|----------|--------------|
| `th_scope` | Adds `scope="col"` / `scope="row"` to table header cells |
| `low_contrast` | Replaces a known low-contrast orange text color with an accessible one |
| `legacy_designplus` | Removes leftover DesignPlus/Kennethware wrapper classes |
| `redundant_alt_prefix` | Removes "image of…" / "picture of…" from alt text (never empties it) |

1. Call it **without** `confirmation_token` → you get a per-page preview of every change and a token. Nothing is written.
2. Show the teacher the preview (pages affected, before/after examples).
3. After a clear yes, call again with identical arguments plus `confirmation_token`. If anyone edited those pages in Canvas in the meantime, the token stops working — preview again.

**Guided fixes** (need judgment) — page by page, with the teacher:

- **Missing alt text:** `get_page_content` → find the `<img>` tags without `alt` → propose alt text from context (or `alt=""` if purely decorative) → teacher approves → `edit_page_content` (course, page_url, `body` = full corrected HTML, `template: "none"` so no page template is re-applied).
- **Vague links:** propose descriptive text ("Download the brake-system diagram (PDF)") → approve → edit as above.
- **Empty/skipped headings:** ask whether to remove the heading or give it text; fix heading levels so they don't skip (h2 → h4).
- **Tables without headers:** ask which row/column holds headers; turn those `<td>` into `<th>` (then `th_scope` can add scopes).

For assignments, edit the description with `update_assignment` (description). Show the teacher the changed HTML before every edit; edit one page at a time.

### 5. Re-scan

Run `scan_course_content_accessibility` again and report: "Fixed 11 of 15. 4 need manual review."

### 6. Summary for records

```
## Accessibility Review Summary — HLTH-1 AM (2026-11-06)
Scanned 37 items · found 15 · fixed 11 · manual review 4
Fixes: alt text on 5 images, headers on 2 tables, 3 link texts, 1 heading
Outstanding: captions on 2 embedded videos; 1 scanned-image PDF
Note: automated checks cover common WCAG 2.1 A/AA issues only; a manual review is still recommended.
```

## Tools used

`list_courses`, `scan_course_content_accessibility`, `fetch_ufixit_report`, `parse_ufixit_violations`, `format_accessibility_summary`, `fix_accessibility_issues`, `get_page_content`, `edit_page_content`, `update_assignment`.

## Notes

- Can't check automatically: contrast inside images, video captions, audio description, PDF/slide accessibility, keyboard behavior of embedded tools. Always list these as manual checks.
- Before each guided edit, keep the page's original HTML (from `get_page_content`) in the conversation so you can put it back if the teacher doesn't like the result.
- Pairs with `canvas-course-qc` for a full pre-semester review.
