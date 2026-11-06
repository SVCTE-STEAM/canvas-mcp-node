import { beforeEach, describe, expect, it } from "vitest";

import {
  buildMockCanvas,
  buildToolHarness,
  parseJsonResult,
  type FakeResponse,
  type ToolResponse,
} from "../_helpers/mockCanvas.js";
import { registerAccessibilityTools } from "../../src/tools/accessibility.js";
import {
  checkContentAccessibility,
  extractUfixitViolations,
  fixLegacyDesignPlus,
  fixOrangeContrast,
  fixRedundantAltPrefix,
  fixThScope,
  tokenizeHtml,
} from "../../src/tools/accessibilityChecks.js";
import { resetConfirmationTokens } from "../../src/tools/confirmGate.js";

const COURSE_ID = 60366;

function issueTypes(html: string): string[] {
  return checkContentAccessibility(html).map((issue) => issue.type);
}

function setup(responses: FakeResponse[] = []) {
  const mock = buildMockCanvas(responses);
  const harness = buildToolHarness();
  registerAccessibilityTools(harness.server as never, mock.client);
  return { ...mock, harness };
}

function errorText(result: ToolResponse): string {
  expect(result.isError).toBe(true);
  return result.content?.[0]?.text ?? "";
}

beforeEach(() => {
  resetConfirmationTokens();
});

describe("registerAccessibilityTools", () => {
  it("registers the five accessibility tools under their Python names", () => {
    const { harness } = setup();
    expect([...harness.tools.keys()].sort()).toEqual([
      "fetch_ufixit_report",
      "fix_accessibility_issues",
      "format_accessibility_summary",
      "parse_ufixit_violations",
      "scan_course_content_accessibility",
    ]);
  });
});

describe("scanner rules", () => {
  it.each([
    ['<img src="chart.png">', "missing_alt_text"],
    ["<h2> </h2>", "empty_heading"],
    ["<h3>&nbsp;</h3>", "empty_heading"],
    ["<table><tr><td>Data</td></tr></table>", "table_without_headers"],
    ['<a href="/detail">click here</a>', "non_descriptive_link"],
    ['<a href="/detail"> <span>Read More</span>. </a>', "non_descriptive_link"],
    ['<a href="/detail"> </a>', "empty_link"],
    ['<a href="/detail">https://example.org</a>', "url_as_link_text"],
    ["<table><th>Heading</th></table>", "th_missing_scope"],
    ["<h2>First</h2><h4>Skipped</h4>", "heading_skip"],
    ['<p style="background-color:#ff5f05;color:white">Text</p>', "low_contrast"],
    ['<div class="kl_wrapper">Text</div>', "legacy_designplus"],
    ['<img src="chart.png" alt="chart.png">', "filename_alt_text"],
    ['<img src="chart.png" alt="image of a chart">', "redundant_alt_prefix"],
    ['<img src="chart.png" alt="abc">', "short_alt_text"],
    [`<img src="chart.png" alt="${"a".repeat(101)}">`, "long_alt_text"],
    ['<a href="handout.pdf">Handout</a>', "doc_link_no_type"],
    ['<iframe src="https://youtube.com/embed/synthetic"></iframe>', "video_caption_check"],
    ['<p style="text-decoration: underline dotted">Text</p>', "underline_not_link"],
    ['<p style="font-size:8px">Text</p>', "small_font_size"],
    ["<p>• Manual bullet</p>", "manual_bullets"],
    ['<span style="color:red">Important</span>', "color_only_meaning"],
    // A bare "<" in text is not a tag; the browser reads "<b, that's true.</p>" as one malformed tag.
    ["<p>if a<b, that's true.</p><img src=\"chart.png\">", "missing_alt_text"],
    ['<p title="Use x<y here">• Manual bullet</p>', "manual_bullets"],
  ])("flags %s as %s", (html, type) => {
    expect(issueTypes(html)).toContain(type);
  });

  it.each([
    ['<span style="color:inherit">Important</span>', "color_only_meaning"],
    ['<span style="color:red;font-weight:bold">Important</span>', "color_only_meaning"],
    ['<span style="color:red"><strong>Important</strong></span>', "color_only_meaning"],
    ['<span style="background-color:red">Important</span>', "color_only_meaning"],
    ['<a id="top"></a>', "empty_link"],
    ['<table role="presentation"><tr><td>Layout</td></tr></table>', "table_without_headers"],
    ['<h2><img src="logo.png" alt="Course logo"></h2>', "empty_heading"],
    ['<a href="/syllabus">Course syllabus</a>', "non_descriptive_link"],
    ['<a href="handout.pdf">Handout [PDF]</a>', "doc_link_no_type"],
    ['<img src="x.png" alt="">', "missing_alt_text"],
    ['<p style="font-size:12px">Text</p>', "small_font_size"],
    ["<h2>A</h2><h3>B</h3><h2>C</h2>", "heading_skip"],
  ])("does not flag %s as %s", (html, type) => {
    expect(issueTypes(html)).not.toContain(type);
  });

  it("does not read markup inside quoted attribute values as attributes", () => {
    const html =
      "<img title='alt=\"Chart\"'><th title='scope=\"row\"'>Header</th>" +
      "<p title='style=\"color:white;background-color:#ff5f05\"'>Text</p>";
    const found = issueTypes(html);
    expect(found).toEqual(expect.arrayContaining(["missing_alt_text", "th_missing_scope"]));
    expect(found).not.toContain("low_contrast");
  });

  it("honours !important when reading white-on-orange contrast", () => {
    expect(issueTypes('<p style="background-color:#ff5f05;color:white !important;color:black">Text</p>')).toContain(
      "low_contrast",
    );
  });

  it("reports instance details for dynamic rules", () => {
    const issues = checkContentAccessibility('<h2>A</h2><h4>B</h4><p style="font-size:7px">x</p>');
    expect(issues.find((issue) => issue.type === "heading_skip")?.detail).toBe("Heading level skipped: H2 to H4");
    expect(issues.find((issue) => issue.type === "small_font_size")?.detail).toContain("7px");
  });

  it("returns no issues for empty or null content", () => {
    expect(checkContentAccessibility("")).toEqual([]);
    expect(checkContentAccessibility(null)).toEqual([]);
  });
});

describe("raw-text elements and ASCII-only end tags", () => {
  it.each([
    ['<script>var s = "<img src=x>";</script>', "script"],
    ["<style>/* <img src=x> */</style>", "style"],
    ["<textarea><img src=x></textarea>", "textarea"],
    ["<title><img src=x></title>", "title"],
    ["<!-- <img src=x> -->", "comment"],
    ['<script><!--<script>"</script>"<img src=x></script>', "double-escaped script"],
  ])("ignores tags inside %s (%s)", (html) => {
    expect(issueTypes(html)).not.toContain("missing_alt_text");
  });

  it.each(["</ſcript>", "</scrİpt>", "</ſtyle>", "</SCRİPT>"])(
    "does not let %s end a raw-text block through Unicode case folding",
    (fakeEnd) => {
      const element = fakeEnd.toLowerCase().includes("tyle") ? "style" : "script";
      const html = `<${element}>x${fakeEnd}<img src=x><th>y</th></${element}>`;
      expect(issueTypes(html)).toEqual([]);
      expect(fixThScope(html).count).toBe(0);
    },
  );

  it("ends raw text at an ASCII case-insensitive closing tag", () => {
    expect(issueTypes("<script>x</SCRIPT ><img src=x>")).toContain("missing_alt_text");
    expect(issueTypes("<STYLE>x</Style><img src=x>")).toContain("missing_alt_text");
  });

  it("lowercases tag names with ASCII rules only", () => {
    const names = tokenizeHtml("<TH><İmg><DIV>").map((tag) => tag.name);
    expect(names).toEqual(["th", "div"]);
  });

  it("finishes in linear time on malformed input", () => {
    const inputs = [
      '<span style="color:' + "a".repeat(300_000),
      '<img style="'.repeat(10_000),
      '<a href="a.pdf">'.repeat(50_000),
      "<table>".repeat(50_000),
      "<!--x-->".repeat(50_000),
      "<script>" + "<!--<script>".repeat(20_000),
      "<p>" + "<".repeat(300_000),
    ];
    const started = Date.now();
    for (const html of inputs) {
      checkContentAccessibility(html);
      fixThScope(html);
      fixOrangeContrast(html);
    }
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("fixers", () => {
  it("adds scope=col to column headers and scope=row to the header that opens a data row", () => {
    const html =
      "<table><tr><th>Day</th><th>Topic</th></tr><tr><th>Mon</th><td>Intro</td></tr></table>";
    const result = fixThScope(html);
    expect(result.count).toBe(3);
    expect(result.html).toBe(
      '<table><tr><th scope="col">Day</th><th scope="col">Topic</th></tr><tr><th scope="row">Mon</th><td>Intro</td></tr></table>',
    );
    expect(result.change).toBe("th_scope: 3 <th> element(s) given a scope (2 col, 1 row)");
    expect(result.examples[0]).toEqual({ before: "<th>", after: '<th scope="col">' });
  });

  it("uses col for headers after a corner <td> in a two-dimensional table", () => {
    const html = "<table><tr><td></td><th>Mon</th></tr><tr><th>9am</th><td>Lab</td></tr></table>";
    expect(fixThScope(html).html).toBe(
      '<table><tr><td></td><th scope="col">Mon</th></tr><tr><th scope="row">9am</th><td>Lab</td></tr></table>',
    );
  });

  it("leaves existing scope alone and only inserts the missing attribute", () => {
    for (const quote of ['"', "'"]) {
      const row = `<TH title=${quote}x<y>z${quote} scope="row">Row</TH>`;
      expect(fixThScope(row).html).toBe(row);
      const missing = `<TH title=${quote}x<y>z${quote}>Column</TH>`;
      expect(fixThScope(missing).html).toBe(missing.replace("<TH", '<TH scope="col"'));
    }
  });

  it("recolors only the foreground on orange and keeps !important", () => {
    const fixed = fixOrangeContrast('<p style="background-color:#ff5f05;color:white !important;color:black">Text</p>');
    expect(fixed.count).toBe(1);
    expect(fixed.html).toBe('<p style="background-color:#ff5f05;color: #000000 !important;color:black">Text</p>');
  });

  it("keeps an unquoted style attribute valid when recoloring", () => {
    const fixed = fixOrangeContrast("<p style=background-color:#ff5f05;color:#fff>Text</p>");
    expect(fixed.html).toBe("<p style=background-color:#ff5f05;color:#000000>Text</p>");
    const tag = tokenizeHtml(fixed.html)[0]!;
    expect([...tag.attributes.keys()]).toEqual(["style"]);
  });

  it("does not recolor white text on other backgrounds", () => {
    const html = '<p style="background-color:#000;color:white">Text</p>';
    expect(fixOrangeContrast(html)).toMatchObject({ html, count: 0, change: null });
  });

  it.each([
    ['<div id="kl_banner">x</div>', '<div id="kl_banner" class="dp-header">x</div>', 1],
    ['<div class="a" id="kl_banner">x</div>', '<div class="a dp-header" id="kl_banner">x</div>', 1],
    ['<div id="kl_custom_block_3" class="b">x</div>', '<div id="kl_custom_block_3" class="b dp-content-block">x</div>', 1],
    ['<div id="kl_banner" class="dp-header">x</div>', '<div id="kl_banner" class="dp-header">x</div>', 0],
    ['<div id="other">x</div>', '<div id="other">x</div>', 0],
    ['<div title="x<y" id="kl_banner">x</div>', '<div title="x<y" id="kl_banner" class="dp-header">x</div>', 1],
    ['<div class="kl_wrapper" id="kl_readings2">x</div>', '<div class="dp-wrapper dp-content-block" id="kl_readings2">x</div>', 2],
    ["<div class=kl_wrapper id=kl_banner>x</div>", '<div class="dp-wrapper dp-header" id=kl_banner>x</div>', 2],
    ['<div class="my-kl_wrapper kl_wrapper_x">x</div>', '<div class="my-kl_wrapper kl_wrapper_x">x</div>', 0],
  ])("migrates DesignPLUS classes: %s", (html, expected, count) => {
    const fixed = fixLegacyDesignPlus(html);
    expect(fixed.html).toBe(expected);
    expect(fixed.count).toBe(count);
  });

  it("never rewrites class-looking text outside a class attribute", () => {
    const html = '<p>Use class="kl_wrapper" in old templates</p><pre>class="kl_banner"</pre>';
    expect(fixLegacyDesignPlus(html).html).toBe(html);
  });

  it("strips redundant alt prefixes but never empties the alt", () => {
    for (const quote of ['"', "'"]) {
      const html = `<img title="x<y>z" alt=${quote}image of a chart${quote}>`;
      expect(fixRedundantAltPrefix(html)).toMatchObject({ html: html.replace("image of ", ""), count: 1 });
    }
    const decorativeRisk = '<img alt="Photo of ">';
    expect(fixRedundantAltPrefix(decorativeRisk)).toMatchObject({ html: decorativeRisk, count: 0 });
  });
});

describe("scan_course_content_accessibility", () => {
  it("scans pages and assignments and groups issues per item with a legend", async () => {
    const { harness, requests } = setup([
      {
        status: 200,
        data: [
          { page_id: 11, url: "week-1", title: "Week 1", body: '<img src="a.png"><table><tr><th>A</th></tr></table>' },
          { page_id: 12, url: "clean", title: "Clean", body: "<p>All good</p>" },
          { page_id: 13, url: "title-only", title: "Title only", body: null },
        ],
      },
      { status: 200, data: [{ id: 501, name: "Essay", description: '<a href="/x">click here</a><h2>A</h2><h5>B</h5>' }] },
    ]);
    const result = await harness.call("scan_course_content_accessibility", { course_identifier: COURSE_ID });
    expect(result.isError).toBeFalsy();
    expect(requests.map((request) => request.url)).toEqual([
      `/api/v1/courses/${COURSE_ID}/pages`,
      `/api/v1/courses/${COURSE_ID}/assignments`,
    ]);
    expect(requests[0]?.params).toMatchObject({ "include[]": ["body"] });
    expect(requests.every((request) => request.method === "GET")).toBe(true);

    const payload = parseJsonResult(result) as {
      items: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      issue_types: Record<string, Record<string, unknown>>;
      items_scanned: Record<string, number>;
      fix_hint?: string;
    };
    expect(payload.items_scanned).toEqual({ page: 3, assignment: 1 });
    expect(payload.items).toEqual([
      {
        content_type: "page",
        content_id: 11,
        content_title: "Week 1",
        page_url: "week-1",
        issues: { missing_alt_text: 1, th_missing_scope: 1 },
      },
      {
        content_type: "assignment",
        content_id: 501,
        content_title: "Essay",
        issues: { non_descriptive_link: 1, heading_skip: 1 },
        details: ["heading_skip: Heading level skipped: H2 to H5"],
      },
    ]);
    expect(payload.summary).toMatchObject({
      total_violations: 4,
      auto_fixable: 1,
      by_content_type: { page: 2, assignment: 2 },
      by_severity: { serious: 2, moderate: 2 },
    });
    expect(payload.issue_types.th_missing_scope).toMatchObject({ auto_fixable: true, fix_type: "th_scope", wcag_criterion: "1.3.1" });
    expect(Object.keys(payload.issue_types).sort()).toEqual(
      ["heading_skip", "missing_alt_text", "non_descriptive_link", "th_missing_scope"].sort(),
    );
    expect(payload.fix_hint).toContain("th_scope");
  });

  it("fetches a page individually when the list omits its body", async () => {
    const { harness, requests } = setup([
      { status: 200, data: [{ page_id: 11, url: "week 1", title: "Week 1" }] },
      { status: 200, data: { page_id: 11, url: "week 1", title: "Week 1", body: '<img src="a.png">' } },
    ]);
    const result = await harness.call("scan_course_content_accessibility", {
      course_identifier: COURSE_ID,
      content_types: "pages",
    });
    expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/pages/week%201`);
    const payload = parseJsonResult(result) as { items: Array<{ issues: Record<string, number> }> };
    expect(payload.items[0]?.issues).toEqual({ missing_alt_text: 1 });
  });

  it("scans the syllabus and warns about unsupported content types", async () => {
    const { harness, requests } = setup([
      { status: 200, data: { id: COURSE_ID, course_code: "BIO101", syllabus_body: '<a href="/a"></a>' } },
    ]);
    const result = await harness.call("scan_course_content_accessibility", {
      course_identifier: COURSE_ID,
      content_types: "syllabus, discussions",
    });
    expect(requests[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}`);
    expect(requests[0]?.params).toMatchObject({ "include[]": ["syllabus_body"] });
    const payload = parseJsonResult(result) as Record<string, unknown>;
    expect(payload.course_code).toBe("BIO101");
    expect(payload.warnings).toEqual([expect.stringContaining("discussions")]);
    expect((payload.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      content_type: "syllabus",
      issues: { empty_link: 1 },
    });
    expect(result.content?.[0]?.text).toContain("in BIO101");
  });

  it("returns an error when Canvas refuses the page list", async () => {
    const { harness } = setup([{ status: 403, data: { errors: [{ message: "user not authorized to perform that action" }] } }]);
    const text = errorText(await harness.call("scan_course_content_accessibility", { course_identifier: COURSE_ID }));
    expect(text).toContain("scan_course_content_accessibility");
    expect(text).toContain("403");
  });

  it("rejects content_types that name nothing scannable without calling Canvas", async () => {
    const { harness, requests } = setup();
    const text = errorText(
      await harness.call("scan_course_content_accessibility", { course_identifier: COURSE_ID, content_types: "quizzes" }),
    );
    expect(text).toContain("pages, assignments, syllabus");
    expect(requests).toHaveLength(0);
  });
});

describe("UFIXIT report tools", () => {
  const REPORT_BODY = [
    "<h2>UFIXIT Report</h2>",
    "<li>WCAG 1.1.1 — Missing alt text (error)</li>",
    "<li>Page: Week 1 Overview</li>",
    "<li>WCAG 1.4.3 color contrast warning on assignment Essay</li>",
  ].join("\n");

  it("fetch_ufixit_report prefers the exact title match and returns the body", async () => {
    const { harness, requests } = setup([
      {
        status: 200,
        data: [
          { url: "ufixit-notes", title: "UFIXIT notes" },
          { url: "ufixit", title: "UFIXIT" },
        ],
      },
      { status: 200, data: { page_id: 9, url: "ufixit", title: "UFIXIT", body: REPORT_BODY, updated_at: "2026-10-01T00:00:00Z" } },
    ]);
    const result = await harness.call("fetch_ufixit_report", { course_identifier: COURSE_ID });
    expect(requests[0]?.params).toMatchObject({ search_term: "UFIXIT" });
    expect(requests[1]?.url).toBe(`/api/v1/courses/${COURSE_ID}/pages/ufixit`);
    expect(parseJsonResult(result)).toMatchObject({
      course_id: COURSE_ID,
      page_title: "UFIXIT",
      page_url: "ufixit",
      page_id: 9,
      body: REPORT_BODY,
    });
  });

  it("fetch_ufixit_report fails with a clear message when the course has no UFIXIT page", async () => {
    const { harness, requests } = setup([{ status: 200, data: [] }]);
    const text = errorText(await harness.call("fetch_ufixit_report", { course_identifier: COURSE_ID }));
    expect(text).toContain('No page titled "UFIXIT"');
    expect(text).toContain("no UFIXIT report");
    expect(text).toContain("scan_course_content_accessibility");
    expect(requests).toHaveLength(1);
  });

  it("fetch_ufixit_report surfaces Canvas errors", async () => {
    const { harness } = setup([{ status: 404, data: { message: "The requested page does not exist" } }]);
    const text = errorText(await harness.call("fetch_ufixit_report", { course_identifier: COURSE_ID, page_title: "Report" }));
    expect(text).toContain("404");
  });

  it("parse_ufixit_violations extracts violations from the fetch output, summary line included", async () => {
    const { harness } = setup([
      { status: 200, data: [{ url: "ufixit", title: "UFIXIT" }] },
      { status: 200, data: { page_id: 9, url: "ufixit", title: "UFIXIT", body: REPORT_BODY } },
    ]);
    const fetched = await harness.call("fetch_ufixit_report", { course_identifier: COURSE_ID });
    const parsed = await harness.call("parse_ufixit_violations", { report_json: fetched.content?.[0]?.text });
    const payload = parseJsonResult(parsed) as {
      violations: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      report_metadata: Record<string, unknown>;
    };
    expect(payload.violations).toEqual([
      {
        wcag_criterion: "1.1.1",
        type: "missing_alt_text",
        severity: "error",
        description: "Images missing alternative text",
        location: "Page: Week 1 Overview",
      },
      {
        wcag_criterion: "1.4.3",
        type: "color_contrast",
        severity: "warning",
        description: "Insufficient color contrast",
        location: "WCAG 1.4.3 color contrast warning on assignment Essay",
      },
    ]);
    expect(payload.summary).toMatchObject({ total_violations: 2, by_wcag_criterion: { "1.1.1": 1, "1.4.3": 1 } });
    expect(payload.report_metadata).toMatchObject({ page_title: "UFIXIT", course_id: COURSE_ID });
  });

  it("parse_ufixit_violations rejects invalid JSON, empty bodies and passes upstream errors through", async () => {
    const { harness } = setup();
    expect(errorText(await harness.call("parse_ufixit_violations", { report_json: "bad-json" }))).toContain(
      "Invalid JSON input",
    );
    expect(
      errorText(await harness.call("parse_ufixit_violations", { report_json: JSON.stringify({ body: "  " }) })),
    ).toContain("Report body is empty");
    expect(
      errorText(
        await harness.call("parse_ufixit_violations", {
          report_json: JSON.stringify({ error: "No page found", suggestion: "Try another page_title" }),
        }),
      ),
    ).toContain("No page found (Try another page_title)");
  });

  it("extractUfixitViolations ignores lines before the first WCAG mention", () => {
    expect(extractUfixitViolations("Page: intro\nserious problem")).toEqual([]);
  });

  it("format_accessibility_summary renders Markdown with totals and details", async () => {
    const { harness } = setup();
    const result = await harness.call("format_accessibility_summary", {
      violations_json: JSON.stringify({
        summary: { total_violations: 2, by_severity: { error: 1, warning: 1 }, by_wcag_criterion: { "1.4.3": 1, "1.1.1": 1 } },
        violations: [
          { type: "Missing alt text", severity: "error", wcag_criterion: "1.1.1", location: "Page: Home", remediation: "Add alt" },
          { type: "Low contrast", severity: "warning", wcag_criterion: "1.4.3" },
        ],
        report_metadata: { page_title: "UFIXIT", updated_at: "2026-01-01T00:00:00Z" },
      }),
    });
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("# Accessibility Report Summary");
    expect(text).toContain("- **Total Violations**: 2");
    expect(text).toContain("- Error: 1");
    expect(text.indexOf("WCAG 1.1.1: 1")).toBeLessThan(text.indexOf("WCAG 1.4.3: 1"));
    expect(text).toContain("### 1. Missing alt text");
    expect(text).toContain("**How to Fix**: Add alt");
    expect(text).toContain("### 2. Low contrast");
  });

  it("format_accessibility_summary handles zero violations and bad input", async () => {
    const { harness } = setup();
    const empty = await harness.call("format_accessibility_summary", {
      violations_json: JSON.stringify({ summary: { total_violations: 0 }, violations: [], report_metadata: {} }),
    });
    expect(empty.content?.[0]?.text).toContain("- **Total Violations**: 0");
    expect(errorText(await harness.call("format_accessibility_summary", { violations_json: "bad-json" }))).toContain(
      "Invalid JSON input",
    );
    expect(
      errorText(
        await harness.call("format_accessibility_summary", { violations_json: JSON.stringify({ error: "Report body is empty" }) }),
      ),
    ).toContain("Report body is empty");
  });
});

describe("fix_accessibility_issues", () => {
  const FIXABLE_BODY = '<table><tr><th>Day</th></tr><tr><th>Mon</th><td>Intro</td></tr></table><img src="a.png" alt="Image of a cell">';
  const FIXED_BODY =
    '<table><tr><th scope="col">Day</th></tr><tr><th scope="row">Mon</th><td>Intro</td></tr></table><img src="a.png" alt="a cell">';

  function pageList(body = FIXABLE_BODY): FakeResponse {
    return {
      status: 200,
      data: [
        { page_id: 11, url: "week-1", title: "Week 1", body, published: true },
        { page_id: 12, url: "clean", title: "Clean", body: "<p>ok</p>", published: false },
      ],
    };
  }

  async function preview(harness: ReturnType<typeof setup>["harness"], args: Record<string, unknown> = {}) {
    const result = await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, ...args });
    expect(result.isError).toBeFalsy();
    return parseJsonResult(result) as Record<string, unknown> & { confirmation_token: string };
  }

  it("previews per-page changes without writing anything", async () => {
    const { harness, requests } = setup([pageList()]);
    const result = await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID });
    expect(result.content?.[0]?.text).toMatch(/^PREVIEW ONLY — nothing was written\./);
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
    const payload = parseJsonResult(result) as Record<string, unknown>;
    expect(payload).toMatchObject({ preview_only: true, items_scanned: 2, items_with_fixes: 1 });
    expect(typeof payload.confirmation_token).toBe("string");
    expect(payload.changes).toEqual([
      {
        content_type: "page",
        title: "Week 1",
        page_url: "week-1",
        published: true,
        changes: [
          "th_scope: 2 <th> element(s) given a scope (1 col, 1 row)",
          "redundant_alt_prefix: 1 alt text(s) fixed",
        ],
        examples: [
          { fix: "th_scope", before: "<th>", after: '<th scope="col">' },
          { fix: "th_scope", before: "<th>", after: '<th scope="row">' },
          { fix: "redundant_alt_prefix", before: '<img src="a.png" alt="Image of a cell">', after: '<img src="a.png" alt="a cell">' },
        ],
      },
    ]);
  });

  it("applies the previewed fixes with the token, sending only the body", async () => {
    const { harness, requests, enqueue } = setup([pageList()]);
    const { confirmation_token } = await preview(harness);
    enqueue(pageList());
    enqueue({ status: 200, data: { url: "week-1", title: "Week 1", body: FIXED_BODY, published: true } });

    const result = await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, confirmation_token });
    expect(result.isError).toBeFalsy();
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("PUT");
    expect(writes[0]?.url).toBe(`/api/v1/courses/${COURSE_ID}/pages/week-1`);
    expect(writes[0]?.data).toEqual({ wiki_page: { body: FIXED_BODY } });
    const payload = parseJsonResult(result) as Record<string, unknown>;
    expect(payload).toMatchObject({ applied: 1, failed: 0 });
    expect(payload.results).toEqual([
      expect.objectContaining({ page_url: "week-1", applied: true, verified: true }),
    ]);
    expect(result.content?.[0]?.text).toContain("Published state was not changed.");
  });

  it("refuses an unknown token and writes nothing", async () => {
    const { harness, requests } = setup([pageList()]);
    const text = errorText(
      await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, confirmation_token: "not-a-token" }),
    );
    expect(text).toContain("unknown, expired");
    expect(text).toContain("Nothing was written.");
    expect(requests.some((request) => request.method !== "GET")).toBe(false);
  });

  it("voids the token when the arguments change", async () => {
    const { harness, requests, enqueue } = setup([pageList()]);
    const { confirmation_token } = await preview(harness);
    enqueue(pageList());
    const text = errorText(
      await harness.call("fix_accessibility_issues", {
        course_identifier: COURSE_ID,
        fix_types: "th_scope",
        confirmation_token,
      }),
    );
    expect(text).toContain("Arguments changed since the preview");
    expect(requests.some((request) => request.method !== "GET")).toBe(false);
  });

  it("voids the token when the page changed in Canvas after the preview", async () => {
    const { harness, requests, enqueue } = setup([pageList()]);
    const { confirmation_token } = await preview(harness);
    enqueue(pageList(`${FIXABLE_BODY}<p>Edited by a colleague</p>`));
    const text = errorText(
      await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, confirmation_token }),
    );
    expect(text).toContain("Content edited in Canvas since the preview");
    expect(requests.some((request) => request.method !== "GET")).toBe(false);
  });

  it("accepts a token only once", async () => {
    const { harness, requests, enqueue } = setup([pageList()]);
    const { confirmation_token } = await preview(harness);
    enqueue(pageList());
    enqueue({ status: 200, data: { url: "week-1", title: "Week 1", body: FIXED_BODY } });
    const first = await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, confirmation_token });
    expect(first.isError).toBeFalsy();

    enqueue(pageList());
    const text = errorText(
      await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, confirmation_token }),
    );
    expect(text).toContain("already used");
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it("dry_run: true previews even with a token, and the token stays usable", async () => {
    const { harness, requests, enqueue } = setup([pageList()]);
    const { confirmation_token } = await preview(harness, { dry_run: true });
    enqueue(pageList());
    const dry = await harness.call("fix_accessibility_issues", {
      course_identifier: COURSE_ID,
      dry_run: true,
      confirmation_token,
    });
    expect(parseJsonResult(dry).preview_only).toBe(true);
    expect(requests.some((request) => request.method !== "GET")).toBe(false);

    enqueue(pageList());
    enqueue({ status: 200, data: { url: "week-1", body: FIXED_BODY } });
    const applied = await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, confirmation_token });
    expect(parseJsonResult(applied)).toMatchObject({ applied: 1 });
  });

  it("re-resolves a course code on every call (bypassCache) before writing", async () => {
    const courses: FakeResponse = { status: 200, data: [{ id: COURSE_ID, course_code: "BIO101", name: "Biology" }] };
    const { harness, requests, enqueue } = setup([courses, pageList()]);
    const result = await harness.call("fix_accessibility_issues", { course_identifier: "BIO101" });
    const { confirmation_token } = parseJsonResult(result) as { confirmation_token: string };
    expect(result.content?.[0]?.text).toContain("in BIO101");
    enqueue(courses);
    enqueue(pageList());
    enqueue({ status: 200, data: { url: "week-1", body: FIXED_BODY } });
    await harness.call("fix_accessibility_issues", { course_identifier: "BIO101", confirmation_token });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /api/v1/courses",
      `GET /api/v1/courses/${COURSE_ID}/pages`,
      "GET /api/v1/courses",
      `GET /api/v1/courses/${COURSE_ID}/pages`,
      `PUT /api/v1/courses/${COURSE_ID}/pages/week-1`,
    ]);
  });

  it("fixes assignment descriptions with a description-only payload", async () => {
    const assignments: FakeResponse = {
      status: 200,
      data: [{ id: 501, name: "Essay", description: "<table><tr><th>Criteria</th></tr></table>", published: true }],
    };
    const { harness, requests, enqueue } = setup([assignments]);
    const { confirmation_token } = await preview(harness, { content_types: "assignments", fix_types: "th_scope" });
    enqueue(assignments);
    const fixed = '<table><tr><th scope="col">Criteria</th></tr></table>';
    enqueue({ status: 200, data: { id: 501, description: fixed } });
    const result = await harness.call("fix_accessibility_issues", {
      course_identifier: COURSE_ID,
      content_types: "assignments",
      fix_types: "th_scope",
      confirmation_token,
    });
    expect(parseJsonResult(result)).toMatchObject({ applied: 1 });
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.url).toBe(`/api/v1/courses/${COURSE_ID}/assignments/501`);
    expect(put?.data).toEqual({ assignment: { description: fixed } });
  });

  it("reports a failed write per item and flags unverified ones", async () => {
    const twoPages: FakeResponse = {
      status: 200,
      data: [
        { url: "a", title: "A", body: "<th>x</th>" },
        { url: "b", title: "B", body: "<th>y</th>" },
      ],
    };
    const { harness, enqueue } = setup([twoPages]);
    const { confirmation_token } = await preview(harness, { fix_types: "th_scope" });
    enqueue(twoPages);
    enqueue({ status: 403, data: { message: "page is locked" } });
    enqueue({ status: 200, data: { url: "b", body: "<th>sanitized</th>" } });
    const result = await harness.call("fix_accessibility_issues", {
      course_identifier: COURSE_ID,
      fix_types: "th_scope",
      confirmation_token,
    });
    const payload = parseJsonResult(result) as { applied: number; failed: number; results: Array<Record<string, unknown>>; error?: string };
    expect(payload).toMatchObject({ applied: 1, failed: 1 });
    expect(payload.error).toBeDefined();
    expect(payload.results[0]).toMatchObject({ page_url: "a", applied: false });
    expect(String(payload.results[0]?.error)).toContain("403");
    expect(payload.results[1]).toMatchObject({ page_url: "b", applied: true, verified: false });
  });

  it("returns a no-op result without a token when nothing is fixable", async () => {
    const { harness, requests } = setup([{ status: 200, data: [{ url: "clean", title: "Clean", body: "<p>ok</p>" }] }]);
    const result = await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID });
    const payload = parseJsonResult(result) as Record<string, unknown>;
    expect(payload.items_with_fixes).toBe(0);
    expect(payload).not.toHaveProperty("confirmation_token");
    expect(requests).toHaveLength(1);
  });

  it("rejects unknown fix or content types before calling Canvas", async () => {
    const { harness, requests } = setup();
    expect(
      errorText(await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, fix_types: "th_scope,alt_text" })),
    ).toContain("Unknown fix_types: alt_text");
    expect(
      errorText(await harness.call("fix_accessibility_issues", { course_identifier: COURSE_ID, content_types: "syllabus" })),
    ).toContain("Unsupported content_types: syllabus");
    expect(requests).toHaveLength(0);
  });
});
