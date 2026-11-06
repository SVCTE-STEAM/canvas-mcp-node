/**
 * HTML accessibility checks and mechanical fixes, ported from the Python
 * canvas-mcp accessibility tools (scanner rules, fixers, UFIXIT report parser).
 *
 * The tokenizer follows the WHATWG tokenizer's rules for tags, comments and
 * raw-text elements rather than approximating them, because the fixers write
 * back to live pages: a "<th>" inside <script>, <style>, <textarea> or a
 * comment is text to the browser, and editing it would change what students
 * see or run. Tag names, and the end tag that closes a raw-text element,
 * compare with ASCII-only case folding: the Python version's Unicode folding
 * let "</ſcript>" and "</scrİpt>" end a script block early.
 */

export interface HtmlAttribute {
  value: string;
  /** Offsets of the raw value in the source, inside the quotes when quoted. */
  valueStart: number;
  valueEnd: number;
  nameEnd: number;
  /** `"` or `'` when quoted, "" when unquoted, null for a bare attribute with no `=`. */
  quote: '"' | "'" | "" | null;
}

export interface HtmlTag {
  start: number;
  end: number;
  nameEnd: number;
  /** ASCII-lowercased tag name; "" for comments, doctypes and bogus comments. */
  name: string;
  closing: boolean;
  attributes: Map<string, HtmlAttribute>;
}

const RAW_TEXT_ELEMENTS = new Set([
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

function isHtmlSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
}

function isAsciiAlpha(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function isTagNameTerminator(ch: string | undefined): boolean {
  return isHtmlSpace(ch) || ch === "/" || ch === ">";
}

function matchesTagName(text: string, at: number, name: string): boolean {
  return (
    asciiLower(text.slice(at, at + name.length)) === name && isTagNameTerminator(text[at + name.length])
  );
}

function marker(start: number, end: number): HtmlTag {
  return { start, end, nameEnd: end, name: "", closing: false, attributes: new Map() };
}

function commentEnd(text: string, start: number): number {
  const body = start + 4;
  if (text[body] === ">") return body + 1;
  if (text[body] === "-" && text[body + 1] === ">") return body + 2;
  let cursor = body;
  for (;;) {
    const dashes = text.indexOf("--", cursor);
    if (dashes < 0) return text.length;
    if (text[dashes + 2] === ">") return dashes + 3;
    if (text[dashes + 2] === "!" && text[dashes + 3] === ">") return dashes + 4;
    cursor = dashes + 1;
  }
}

function bogusCommentEnd(text: string, from: number): number {
  const close = text.indexOf(">", from);
  return close < 0 ? text.length : close + 1;
}

/** Parse one tag from its name onward; null when EOF arrives first (the browser drops such a tag). */
function parseTag(text: string, start: number, nameStart: number, closing: boolean): HtmlTag | null {
  const length = text.length;
  let i = nameStart;
  while (i < length && !isTagNameTerminator(text[i])) i++;
  if (i >= length) return null;
  const nameEnd = i;
  const name = asciiLower(text.slice(nameStart, nameEnd));
  const attributes = new Map<string, HtmlAttribute>();
  while (i < length) {
    const ch = text[i];
    if (isHtmlSpace(ch) || ch === "/") {
      i++;
      continue;
    }
    if (ch === ">") {
      return { start, end: i + 1, nameEnd, name, closing, attributes };
    }
    const attrNameStart = i;
    i++; // the first character always belongs to the name, even "="
    while (i < length && !isTagNameTerminator(text[i]) && text[i] !== "=") i++;
    const attrNameEnd = i;
    const attrName = asciiLower(text.slice(attrNameStart, attrNameEnd));
    let attribute: HtmlAttribute = {
      value: "",
      valueStart: attrNameEnd,
      valueEnd: attrNameEnd,
      nameEnd: attrNameEnd,
      quote: null,
    };
    while (i < length && isHtmlSpace(text[i])) i++;
    if (text[i] === "=") {
      i++;
      while (i < length && isHtmlSpace(text[i])) i++;
      if (i >= length) return null;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, i + 1);
        if (close < 0) return null;
        attribute = {
          value: text.slice(i + 1, close),
          valueStart: i + 1,
          valueEnd: close,
          nameEnd: attrNameEnd,
          quote,
        };
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < length && !isHtmlSpace(text[i]) && text[i] !== ">") i++;
        attribute = { value: text.slice(valueStart, i), valueStart, valueEnd: i, nameEnd: attrNameEnd, quote: "" };
      }
    }
    if (!attributes.has(attrName)) attributes.set(attrName, attribute);
  }
  return null;
}

function findRawTextEnd(text: string, from: number, name: string): number {
  let cursor = from;
  for (;;) {
    const candidate = text.indexOf("</", cursor);
    if (candidate < 0) return -1;
    if (matchesTagName(text, candidate + 2, name)) return candidate;
    cursor = candidate + 2;
  }
}

/**
 * Script data has escape states: inside "<!--", a "<script" opens a
 * double-escaped run whose "</script>" does not end the element.
 */
function findScriptEnd(text: string, from: number): number {
  let state: "data" | "escaped" | "double" = "data";
  for (let i = from; i < text.length; i++) {
    if (state === "data") {
      if (text[i] !== "<") continue;
      if (text[i + 1] === "/" && matchesTagName(text, i + 2, "script")) return i;
      if (text.startsWith("<!--", i)) {
        state = "escaped";
        i += 1; // resume on the "--" so "<!-->" closes the escape at once
      }
      continue;
    }
    if (text.startsWith("-->", i)) {
      state = "data";
      i += 2;
      continue;
    }
    if (text[i] !== "<") continue;
    if (state === "escaped") {
      if (text[i + 1] === "/" && matchesTagName(text, i + 2, "script")) return i;
      if (matchesTagName(text, i + 1, "script")) {
        state = "double";
        i += 6;
      }
    } else if (text[i + 1] === "/" && matchesTagName(text, i + 2, "script")) {
      state = "escaped";
      i += 7;
    }
  }
  return -1;
}

/** Tokenize HTML into tags and comment markers in one forward pass. */
export function tokenizeHtml(text: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const lt = text.indexOf("<", cursor);
    if (lt < 0) break;
    const next = text[lt + 1];
    if (next === "!" || next === "?") {
      const end = text.startsWith("<!--", lt) ? commentEnd(text, lt) : bogusCommentEnd(text, lt + 2);
      tags.push(marker(lt, end));
      cursor = end;
      continue;
    }
    let closing = false;
    let nameStart = lt + 1;
    if (next === "/") {
      const after = text[lt + 2];
      if (after === undefined) break;
      if (after === ">") {
        cursor = lt + 3;
        continue;
      }
      if (!isAsciiAlpha(after)) {
        const end = bogusCommentEnd(text, lt + 2);
        tags.push(marker(lt, end));
        cursor = end;
        continue;
      }
      closing = true;
      nameStart = lt + 2;
    } else if (!isAsciiAlpha(next)) {
      cursor = lt + 1;
      continue;
    }
    const tag = parseTag(text, lt, nameStart, closing);
    if (!tag) break;
    tags.push(tag);
    cursor = tag.end;
    if (closing) continue;
    if (tag.name === "plaintext") break;
    if (tag.name === "script" || RAW_TEXT_ELEMENTS.has(tag.name)) {
      const endAt = tag.name === "script" ? findScriptEnd(text, cursor) : findRawTextEnd(text, cursor, tag.name);
      if (endAt < 0) break;
      const endTag = parseTag(text, endAt, endAt + 2, true);
      if (!endTag) break;
      tags.push(endTag);
      cursor = endTag.end;
    }
  }
  return tags;
}

/** Remove complete tags and comments, keeping the text between them. */
export function removeHtmlTags(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const token of tokenizeHtml(text)) {
    parts.push(text.slice(cursor, token.start));
    cursor = token.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

export interface ElementRange {
  open: HtmlTag;
  /** Offsets of the element's inner HTML. */
  start: number;
  end: number;
}

/** Pair opening and closing tags by name; an element missing its closing tag yields nothing. */
export function elementRanges(tags: HtmlTag[], name: string, outermost = false): ElementRange[] {
  const opened: HtmlTag[] = [];
  const ranges: ElementRange[] = [];
  for (const token of tags) {
    if (token.name !== name) continue;
    if (token.closing) {
      const opening = opened.pop();
      if (opening && (!outermost || opened.length === 0)) {
        ranges.push({ open: opening, start: opening.end, end: token.start });
      }
    } else {
      opened.push(token);
    }
  }
  return ranges;
}

function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hasMarker(sortedPositions: number[], start: number, end: number): boolean {
  return lowerBound(sortedPositions, end) > lowerBound(sortedPositions, start);
}

/** Parse an inline style; a later declaration loses to an earlier `!important` one. */
export function styleProperties(style: string): Map<string, string> {
  const properties = new Map<string, string>();
  const important = new Set<string>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    // CSS keywords are ASCII case-insensitive; Unicode folding would read "bacKground" (Kelvin sign) as background.
    const name = asciiLower(declaration.slice(0, colon).trim());
    const value = asciiLower(declaration.slice(colon + 1).trim());
    const priority = /!\s*important\s*$/.exec(value);
    if (important.has(name) && !priority) continue;
    properties.set(name, priority ? value.slice(0, priority.index).trim() : value);
    if (priority) important.add(name);
  }
  return properties;
}

const WHITE_VALUES = new Set(["white", "#fff", "#ffffff"]);

function isWhiteOnOrange(properties: Map<string, string>): boolean {
  return properties.get("background-color") === "#ff5f05" && WHITE_VALUES.has(properties.get("color") ?? "");
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function codePointSlice(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

const NBSP_ENTITY = /&(?:nbsp|#160|#x0*a0);/gi;

/** Blank to a screen reader: only whitespace and non-breaking spaces, no markup. */
function isBlankMarkup(inner: string): boolean {
  return inner.replace(NBSP_ENTITY, " ").trim() === "";
}

function visibleLinkText(inner: string): string {
  return removeHtmlTags(inner)
    .replace(NBSP_ENTITY, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!:]+$/, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export type IssueType =
  | "missing_alt_text"
  | "empty_heading"
  | "table_without_headers"
  | "non_descriptive_link"
  | "empty_link"
  | "url_as_link_text"
  | "th_missing_scope"
  | "heading_skip"
  | "low_contrast"
  | "legacy_designplus"
  | "filename_alt_text"
  | "redundant_alt_prefix"
  | "short_alt_text"
  | "long_alt_text"
  | "doc_link_no_type"
  | "video_caption_check"
  | "underline_not_link"
  | "small_font_size"
  | "manual_bullets"
  | "color_only_meaning";

export type FixType = "th_scope" | "low_contrast" | "legacy_designplus" | "redundant_alt_prefix";

export interface IssueDefinition {
  wcag_criterion: string;
  wcag_level: string;
  severity: "serious" | "moderate" | "minor";
  description: string;
  remediation: string;
  auto_fixable: boolean;
  fix_type?: FixType;
}

export const ISSUE_DEFINITIONS: Record<IssueType, IssueDefinition> = {
  missing_alt_text: {
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "serious",
    description: "Image missing alt attribute",
    remediation: "Add descriptive alt text to all images",
    auto_fixable: false,
  },
  empty_heading: {
    wcag_criterion: "2.4.6",
    wcag_level: "AA",
    severity: "moderate",
    description: "Empty heading element found",
    remediation: "Remove empty headings or add descriptive text",
    auto_fixable: false,
  },
  table_without_headers: {
    wcag_criterion: "1.3.1",
    wcag_level: "A",
    severity: "serious",
    description: "Table missing header cells",
    remediation: "Add <th> elements to define table headers",
    auto_fixable: false,
  },
  non_descriptive_link: {
    wcag_criterion: "2.4.4",
    wcag_level: "A",
    severity: "moderate",
    description: "Link text is not descriptive",
    remediation: "Use descriptive link text that explains the destination",
    auto_fixable: false,
  },
  empty_link: {
    wcag_criterion: "2.4.4",
    wcag_level: "A",
    severity: "serious",
    description: "Link has no text content",
    remediation: "Add descriptive text or remove the empty link",
    auto_fixable: false,
  },
  url_as_link_text: {
    wcag_criterion: "2.4.4",
    wcag_level: "A",
    severity: "moderate",
    description: "Raw URL used as link text instead of descriptive text",
    remediation: "Replace URL with descriptive text explaining the destination",
    auto_fixable: false,
  },
  th_missing_scope: {
    wcag_criterion: "1.3.1",
    wcag_level: "A",
    severity: "serious",
    description: "Table header <th> missing scope attribute",
    remediation: 'Add scope="col" or scope="row" to all <th> elements',
    auto_fixable: true,
    fix_type: "th_scope",
  },
  heading_skip: {
    wcag_criterion: "1.3.1",
    wcag_level: "A",
    severity: "moderate",
    description: "Heading level skipped",
    remediation: "Use sequential heading levels without skipping (H2 → H3, not H2 → H4)",
    auto_fixable: false,
  },
  low_contrast: {
    wcag_criterion: "1.4.3",
    wcag_level: "AA",
    severity: "serious",
    description: "White text on #ff5f05 orange background (~3.1:1 contrast, needs 4.5:1)",
    remediation: "Change text color to #000000 (black) for 6.77:1 contrast on orange",
    auto_fixable: true,
    fix_type: "low_contrast",
  },
  legacy_designplus: {
    wcag_criterion: "N/A",
    wcag_level: "N/A",
    severity: "minor",
    description: "Legacy DesignPLUS kl_ classes found",
    remediation: "Migrate kl_ classes to dp- equivalents for new DesignPLUS sidebar",
    auto_fixable: true,
    fix_type: "legacy_designplus",
  },
  filename_alt_text: {
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "moderate",
    description: "Image alt text appears to be a filename",
    remediation: "Replace filename with descriptive alt text",
    auto_fixable: false,
  },
  redundant_alt_prefix: {
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "minor",
    description: "Alt text starts with redundant 'image of' / 'graphic of' prefix",
    remediation: "Remove the prefix — screen readers already announce it as an image",
    auto_fixable: true,
    fix_type: "redundant_alt_prefix",
  },
  short_alt_text: {
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "moderate",
    description: "Alt text is very short",
    remediation: "Alt text should describe the image content and function",
    auto_fixable: false,
  },
  long_alt_text: {
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "minor",
    description: "Alt text is very long — consider a long description link",
    remediation: "Shorten alt text and provide a linked long description for complex images",
    auto_fixable: false,
  },
  doc_link_no_type: {
    wcag_criterion: "2.4.4",
    wcag_level: "A",
    severity: "minor",
    description: "Link to a document file doesn't indicate the file type",
    remediation: "Add the file type (e.g. [PDF], [Word]) to the link text so users know what opens",
    auto_fixable: false,
  },
  video_caption_check: {
    wcag_criterion: "1.2.2",
    wcag_level: "A",
    severity: "moderate",
    description: "Embedded video — verify captions are present and accurate",
    remediation: "Ensure synchronized captions exist; auto-generated captions should be reviewed",
    auto_fixable: false,
  },
  underline_not_link: {
    wcag_criterion: "1.3.1",
    wcag_level: "A",
    severity: "minor",
    description: "Underlined text that is not a link — underlines signal hyperlinks",
    remediation: "Use bold or italics for emphasis instead of underline",
    auto_fixable: false,
  },
  small_font_size: {
    wcag_criterion: "1.4.4",
    wcag_level: "AA",
    severity: "moderate",
    description: "Inline font-size below readable threshold",
    remediation: "Use at least 12px or remove inline font-size styling",
    auto_fixable: false,
  },
  manual_bullets: {
    wcag_criterion: "1.3.1",
    wcag_level: "A",
    severity: "minor",
    description: "Text uses manual bullet characters instead of <ul>/<ol> list elements",
    remediation: "Convert to proper HTML lists for screen reader navigation",
    auto_fixable: false,
  },
  color_only_meaning: {
    wcag_criterion: "1.4.1",
    wcag_level: "A",
    severity: "minor",
    description: "Colored text without additional visual indicator (bold/italic)",
    remediation: "Add bold or italic alongside color so meaning isn't conveyed by color alone",
    auto_fixable: false,
  },
};

export interface FoundIssue {
  type: IssueType;
  /** Instance-specific description, only where the static one is not enough. */
  detail?: string;
}

const HEADING_NAMES = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LOW_INFO_LINK_TEXT = new Set(["click here", "here", "read more", "more", "link", "this"]);
const DOC_TYPE_LABELS: Record<string, string> = {
  pdf: "PDF",
  doc: "Word",
  docx: "Word",
  xls: "Excel",
  xlsx: "Excel",
  ppt: "PowerPoint",
  pptx: "PowerPoint",
  csv: "CSV",
};
const VIDEO_HOSTS = ["youtube.com", "youtu.be", "kaltura.com", "vimeo.com", "mediaspace"];
const SHORT_ALT_ALLOWED = new Set(["—", "-", "•", "*", "x", "X"]);
const UNDERLINE_TAGS = new Set(["span", "p", "strong", "em", "div"]);
const EMPHASIS_TAGS = new Set(["strong", "em", "b", "i"]);
const NEUTRAL_COLORS = new Set(["inherit", "initial", "unset", "currentcolor"]);
const MANUAL_BULLET = /\s*[•●○◦►▸▹–—\-*]\s+[\p{L}\p{N}_]/uy;

/** Check one HTML body for the scanner's accessibility rules. */
export function checkContentAccessibility(html: string | null | undefined): FoundIssue[] {
  const issues: FoundIssue[] = [];
  if (!html) return issues;

  const tags = tokenizeHtml(html);
  const opening = tags.filter((tag) => !tag.closing);
  const styles = opening.flatMap((tag) => {
    const style = tag.attributes.get("style");
    return style ? [styleProperties(style.value)] : [];
  });
  const images = opening.filter((tag) => tag.name === "img");
  const imageAlts = images.flatMap((image) => {
    const alt = image.attributes.get("alt");
    return alt ? [alt.value] : [];
  });
  const links = elementRanges(tags, "a", true);

  for (const image of images) {
    if (!image.attributes.has("alt")) issues.push({ type: "missing_alt_text" });
  }

  for (const level of [1, 2, 3, 4, 5, 6]) {
    for (const heading of elementRanges(tags, `h${level}`, true)) {
      if (isBlankMarkup(html.slice(heading.start, heading.end))) issues.push({ type: "empty_heading" });
    }
  }

  const headerCellPositions = opening.filter((tag) => tag.name === "th").map((tag) => tag.start);
  for (const table of elementRanges(tags, "table")) {
    // A layout table declared presentational has no header semantics to miss.
    const role = asciiLower(table.open.attributes.get("role")?.value.trim() ?? "");
    if (role === "presentation" || role === "none") continue;
    if (!hasMarker(headerCellPositions, table.start, table.end)) issues.push({ type: "table_without_headers" });
  }

  for (const link of links) {
    if (LOW_INFO_LINK_TEXT.has(visibleLinkText(html.slice(link.start, link.end)))) {
      issues.push({ type: "non_descriptive_link" });
    }
  }

  for (const link of links) {
    // <a id="top"></a> is a jump target, not a link: without href it is not focusable or announced.
    if (!link.open.attributes.has("href")) continue;
    if (isBlankMarkup(html.slice(link.start, link.end))) issues.push({ type: "empty_link" });
  }

  for (const link of links) {
    if (/^\s*https?:\/\/[^\s<]+\s*$/i.test(html.slice(link.start, link.end))) {
      issues.push({ type: "url_as_link_text" });
    }
  }

  for (const tag of opening) {
    if (tag.name === "th" && !tag.attributes.has("scope")) issues.push({ type: "th_missing_scope" });
  }

  const headingLevels = opening.filter((tag) => HEADING_NAMES.has(tag.name)).map((tag) => Number(tag.name[1]));
  for (let i = 1; i < headingLevels.length; i++) {
    const previous = headingLevels[i - 1]!;
    const current = headingLevels[i]!;
    if (current > previous + 1) {
      issues.push({ type: "heading_skip", detail: `Heading level skipped: H${previous} to H${current}` });
    }
  }

  for (const properties of styles) {
    if (isWhiteOnOrange(properties)) issues.push({ type: "low_contrast" });
  }

  const legacyClasses = new Set(Array.from(html.matchAll(/\bkl_\w+/g), (match) => match[0]));
  if (legacyClasses.size > 0) {
    const sample = [...legacyClasses].sort().slice(0, 5).join(", ");
    issues.push({ type: "legacy_designplus", detail: `Legacy DesignPLUS kl_ classes found: ${sample}` });
  }

  for (const alt of imageAlts) {
    if (/\.(jpg|jpeg|png|gif|svg|webp|bmp)/i.test(alt)) issues.push({ type: "filename_alt_text" });
  }

  for (const alt of imageAlts) {
    if (/^(?:image|graphic|picture|photo|icon)\s+(?:of|showing)\s/i.test(alt)) {
      issues.push({ type: "redundant_alt_prefix" });
    }
  }

  for (const rawAlt of imageAlts) {
    const rawLength = codePointLength(rawAlt);
    if (rawLength < 1 || rawLength > 4) continue;
    const alt = rawAlt.trim();
    if (alt && !SHORT_ALT_ALLOWED.has(alt)) {
      issues.push({
        type: "short_alt_text",
        detail: `Alt text is very short (${codePointLength(alt)} chars): "${alt}"`,
      });
    }
  }

  for (const alt of imageAlts) {
    const length = codePointLength(alt);
    if (length >= 100) {
      issues.push({ type: "long_alt_text", detail: `Alt text is very long (${length} chars)` });
    }
  }

  for (const link of links) {
    const href = link.open.attributes.get("href");
    if (!href) continue;
    const extension = /\.(pdf|docx?|xlsx?|pptx?|csv)$/i.exec(href.value);
    if (!extension) continue;
    const ext = extension[1]!.toLowerCase();
    const label = DOC_TYPE_LABELS[ext] ?? ext.toUpperCase();
    const linkText = removeHtmlTags(html.slice(link.start, link.end)).trim();
    const lowered = linkText.toLowerCase();
    if (!lowered.includes(label.toLowerCase()) && !lowered.includes(ext)) {
      issues.push({
        type: "doc_link_no_type",
        detail: `Link to .${ext} file doesn't indicate file type: "${codePointSlice(linkText, 50)}" — add [${label}]`,
      });
    }
  }

  for (const tag of opening) {
    const src = tag.attributes.get("src");
    if (tag.name !== "iframe" || !src) continue;
    if (VIDEO_HOSTS.some((host) => src.value.includes(host))) issues.push({ type: "video_caption_check" });
  }

  for (const tag of opening) {
    const style = tag.attributes.get("style");
    if (!UNDERLINE_TAGS.has(tag.name) || !style) continue;
    const decoration = styleProperties(style.value).get("text-decoration") ?? "";
    if (decoration.split(/\s+/).includes("underline")) issues.push({ type: "underline_not_link" });
  }

  for (const properties of styles) {
    const size = /^([0-9]+)\s*px$/.exec(properties.get("font-size") ?? "");
    if (!size) continue;
    const digits = size[1]!.replace(/^0+/, "") || "0";
    // Any value with two significant digits is already above the cutoff; skip parsing huge numbers.
    if (digits.length >= 2) continue;
    const pixels = Number(digits);
    if (pixels < 10) {
      issues.push({ type: "small_font_size", detail: `Inline font-size: ${pixels}px is below readable threshold` });
    }
  }

  const hasManualBullets = opening.some((tag) => {
    if (tag.name !== "p" && tag.name !== "br") return false;
    MANUAL_BULLET.lastIndex = tag.end;
    return MANUAL_BULLET.test(html);
  });
  if (hasManualBullets) issues.push({ type: "manual_bullets" });

  const emphasisPositions = opening
    .filter((tag) => {
      if (EMPHASIS_TAGS.has(tag.name)) return true;
      const style = tag.attributes.get("style");
      if (!style) return false;
      const properties = styleProperties(style.value);
      return properties.has("font-weight") || properties.has("font-style");
    })
    .map((tag) => tag.start);
  const newlinePositions: number[] = [];
  for (let at = html.indexOf("\n"); at >= 0; at = html.indexOf("\n", at + 1)) newlinePositions.push(at);
  for (const span of elementRanges(tags, "span")) {
    const style = span.open.attributes.get("style");
    if (!style || span.end - span.start < 5 || hasMarker(newlinePositions, span.start, span.end)) continue;
    const properties = styleProperties(style.value);
    const color = properties.get("color") ?? "";
    if (
      color &&
      !NEUTRAL_COLORS.has(color) &&
      !properties.has("font-weight") &&
      !properties.has("font-style") &&
      !hasMarker(emphasisPositions, span.start, span.end)
    ) {
      issues.push({ type: "color_only_meaning" });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Fixers
// ---------------------------------------------------------------------------

interface Edit {
  start: number;
  end: number;
  replacement: string;
  tag: HtmlTag;
}

export interface FixExample {
  before: string;
  after: string;
}

export interface FixResult {
  html: string;
  count: number;
  change: string | null;
  examples: FixExample[];
}

const EXAMPLE_LIMIT = 2;
const EXAMPLE_MAX_CHARS = 200;

function truncateForPreview(text: string): string {
  return codePointLength(text) > EXAMPLE_MAX_CHARS ? `${codePointSlice(text, EXAMPLE_MAX_CHARS)}…` : text;
}

/** Edits are disjoint and in document order; build the result in one pass. */
function applyEdits(html: string, edits: Edit[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(html.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}

function finishFix(html: string, edits: Edit[], change: (count: number) => string, count = edits.length): FixResult {
  edits.sort((a, b) => a.start - b.start);
  const examples = edits.slice(0, EXAMPLE_LIMIT).map((edit) => {
    const before = html.slice(edit.tag.start, edit.tag.end);
    const after =
      before.slice(0, edit.start - edit.tag.start) + edit.replacement + before.slice(edit.end - edit.tag.start);
    return { before: truncateForPreview(before), after: truncateForPreview(after) };
  });
  return {
    html: edits.length > 0 ? applyEdits(html, edits) : html,
    count,
    change: count > 0 ? change(count) : null,
    examples,
  };
}

/**
 * Add scope to <th> cells that lack one. The Python version always wrote
 * scope="col", which mislabels the row headers of key/value tables
 * ("Due date | Friday"): a <th> that opens a row containing <td> cells heads
 * that row; every other <th> heads its column.
 */
export function fixThScope(html: string): FixResult {
  const rowStack: number[] = [];
  const rowCellCounts: number[] = [];
  const rowHasDataCell = new Set<number>();
  const pending: Array<{ tag: HtmlTag; row: number | null; firstInRow: boolean }> = [];
  for (const tag of tokenizeHtml(html)) {
    if (tag.name === "tr") {
      if (tag.closing) rowStack.pop();
      else {
        rowStack.push(rowCellCounts.length);
        rowCellCounts.push(0);
      }
      continue;
    }
    if (tag.closing || (tag.name !== "td" && tag.name !== "th")) continue;
    const row = rowStack.length > 0 ? rowStack[rowStack.length - 1]! : null;
    const firstInRow = row !== null && rowCellCounts[row] === 0;
    if (row !== null) rowCellCounts[row]! += 1;
    if (tag.name === "td") {
      if (row !== null) rowHasDataCell.add(row);
    } else if (!tag.attributes.has("scope")) {
      pending.push({ tag, row, firstInRow });
    }
  }
  let rows = 0;
  const edits = pending.map(({ tag, row, firstInRow }) => {
    const scope = row !== null && firstInRow && rowHasDataCell.has(row) ? "row" : "col";
    if (scope === "row") rows++;
    return { start: tag.nameEnd, end: tag.nameEnd, replacement: ` scope="${scope}"`, tag };
  });
  return finishFix(
    html,
    edits,
    (count) => `th_scope: ${count} <th> element(s) given a scope (${count - rows} col, ${rows} row)`,
  );
}

/** Recolor white text on #ff5f05 orange to black (3.1:1 → 6.77:1); the background is left alone. */
export function fixOrangeContrast(html: string): FixResult {
  const edits: Edit[] = [];
  for (const tag of tokenizeHtml(html)) {
    const style = tag.attributes.get("style");
    if (tag.closing || !style || style.quote === null) continue;
    if (!isWhiteOnOrange(styleProperties(style.value))) continue;
    // A space would end an unquoted attribute value and spill the rest into new attributes.
    const replacement = style.quote === "" ? "color:#000000" : "color: #000000";
    const fixed = style.value.replace(/(?<![\w-])color\s*:\s*(?:white|#fff(?:fff)?)\b/gi, replacement);
    if (fixed !== style.value) edits.push({ start: style.valueStart, end: style.valueEnd, replacement: fixed, tag });
  }
  return finishFix(html, edits, (count) => `low_contrast: ${count} element(s) recolored to #000000 on #ff5f05`);
}

// CidiLabs DesignPLUS kl_ → dp- class mapping
// Source: https://support.cidilabs.com/knowledgebase/designplus-css-class-and-id-list
const KL_CLASS_MAP: Record<string, string> = {
  kl_wrapper: "dp-wrapper",
  kl_flat_sections: "dp-flat-sections",
  kl_flat_sections_main: "dp-flat-sections-main",
  variation_2: "variation-2",
  kl_mod_text: "dp-header-pre-1",
  kl_mod_num: "dp-header-pre-2",
  kl_subtitle: "dp-header-subtitle",
  kl_ignore: "dp-ignore",
  kl_locked: "dp-locked",
  kl_instructions: "dp-action-item",
  kl_progress_icons: "dp-progress-icons",
  kl_complete: "dp-complete",
  kl_colored_bar: "dp-colored-bar",
  kl_current: "dp-current",
  kl_pending: "dp-pending",
  kl_apple: "dp-apple",
  kl_basic_bar: "dp-basic-bar",
  kl_basic_color: "dp-basic-color",
  kl_bookmark: "dp-bookmark",
  kl_box_left: "dp-box-left",
  kl_circle_left: "dp-circle-left",
  kl_emta: "dp-emta",
  kl_badge: "dp-badge",
  kl_generic: "dp-generic",
  kl_ribbons_main: "dp-ribbons-main",
  kl_rounded_inset: "dp-rounded-inset",
  kl_square_right: "dp-square-right",
  kl_colored_headings_box_left: "dp-colored-headings-box-left",
  kl_basic_color_panel_nav: "dp-basic-color-panel-nav",
};

const KL_ID_TO_CLASS: Record<string, string> = {
  kl_wrapper_3: "dp-wrapper",
  kl_banner: "dp-header",
  kl_banner_left: "dp-header-pre",
  kl_banner_right: "dp-header-title",
  kl_description: "dp-header-description",
  kl_introduction: "dp-content-block",
  kl_objectives: "dp-content-block",
  kl_readings: "dp-content-block",
  kl_lectures: "dp-content-block",
  kl_activities: "dp-content-block",
  kl_assignments: "dp-content-block",
};

const KL_ID_PATTERNS: Array<[RegExp, string]> = [
  [/^kl_custom_block_\d+$/, "dp-content-block"],
  [/^kl_content_block_\d+$/, "dp-content-block"],
  [/^kl_objectives\d+$/, "dp-content-block"],
  [/^kl_readings\d+$/, "dp-content-block"],
];

function hasOwn(map: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

function designPlusClassForId(id: string): string | undefined {
  if (!id.startsWith("kl_")) return undefined;
  if (hasOwn(KL_ID_TO_CLASS, id)) return KL_ID_TO_CLASS[id];
  return KL_ID_PATTERNS.find(([pattern]) => pattern.test(id))?.[1];
}

/**
 * Migrate kl_ classes and ids to dp- classes. Works on parsed class
 * attributes only: the Python version regex-replaced `class="..."` across the
 * whole body, which also rewrote matching text in paragraphs and code samples.
 */
export function fixLegacyDesignPlus(html: string): FixResult {
  const edits: Edit[] = [];
  let count = 0;
  for (const tag of tokenizeHtml(html)) {
    if (tag.closing || !tag.name) continue;
    const classAttr = tag.attributes.get("class");
    const original = classAttr?.value ?? "";
    let renamed = false;
    let classValue = original.replace(/[^\t\n\f\r ]+/g, (token) => {
      if (!hasOwn(KL_CLASS_MAP, token)) return token;
      renamed = true;
      return KL_CLASS_MAP[token]!;
    });
    const idClass = designPlusClassForId(tag.attributes.get("id")?.value ?? "");
    const added = idClass !== undefined && !classValue.split(/[\t\n\f\r ]+/).includes(idClass);
    if (added) classValue = classValue.trim() ? `${classValue.trimEnd()} ${idClass}` : idClass!;
    if (!renamed && !added) continue;

    if (!classAttr) {
      const id = tag.attributes.get("id")!;
      const insertAt = id.quote ? id.valueEnd + 1 : id.valueEnd;
      edits.push({ start: insertAt, end: insertAt, replacement: ` class="${classValue}"`, tag });
    } else if (classAttr.quote === '"' || classAttr.quote === "'") {
      edits.push({ start: classAttr.valueStart, end: classAttr.valueEnd, replacement: classValue, tag });
    } else {
      // Unquoted or bare: the new value has spaces, so it needs quotes that the old value does not contain.
      const quote = classValue.includes('"') ? (classValue.includes("'") ? null : "'") : '"';
      if (quote === null) continue;
      const prefix = classAttr.quote === null ? "=" : "";
      const start = classAttr.quote === null ? classAttr.nameEnd : classAttr.valueStart;
      const end = classAttr.quote === null ? classAttr.nameEnd : classAttr.valueEnd;
      edits.push({ start, end, replacement: `${prefix}${quote}${classValue}${quote}`, tag });
    }
    count += (renamed ? 1 : 0) + (added ? 1 : 0);
  }
  return finishFix(html, edits, (n) => `legacy_designplus: ${n} class(es) migrated`, count);
}

/** Remove "image of" / "graphic of" style prefixes from alt text. */
export function fixRedundantAltPrefix(html: string): FixResult {
  const edits: Edit[] = [];
  for (const tag of tokenizeHtml(html)) {
    const alt = tag.attributes.get("alt");
    if (tag.name !== "img" || tag.closing || !alt) continue;
    const prefix = /^(?:image|graphic|picture|photo|icon)\s+(?:of|showing)\s+/i.exec(alt.value);
    if (!prefix) continue;
    // An empty alt marks the image decorative; never strip "Photo of " down to nothing.
    if (!alt.value.slice(prefix[0].length).trim()) continue;
    edits.push({ start: alt.valueStart, end: alt.valueStart + prefix[0].length, replacement: "", tag });
  }
  return finishFix(html, edits, (count) => `redundant_alt_prefix: ${count} alt text(s) fixed`);
}

export const FIX_TYPES: readonly FixType[] = ["th_scope", "low_contrast", "legacy_designplus", "redundant_alt_prefix"];

const FIXERS: Record<FixType, (html: string) => FixResult> = {
  th_scope: fixThScope,
  low_contrast: fixOrangeContrast,
  legacy_designplus: fixLegacyDesignPlus,
  redundant_alt_prefix: fixRedundantAltPrefix,
};

export interface PlannedFix {
  html: string;
  changes: string[];
  examples: Array<FixExample & { fix: FixType }>;
}

/** Apply the selected fixers in their fixed order, each to the previous one's output. */
export function planFixes(html: string, fixTypes: ReadonlySet<FixType>): PlannedFix {
  let current = html;
  const changes: string[] = [];
  const examples: PlannedFix["examples"] = [];
  for (const fix of FIX_TYPES) {
    if (!fixTypes.has(fix)) continue;
    const result = FIXERS[fix](current);
    if (!result.change) continue;
    current = result.html;
    changes.push(result.change);
    for (const example of result.examples) examples.push({ fix, ...example });
  }
  return { html: current, changes, examples };
}

/** Whitespace-insensitive comparison for verifying what Canvas stored. */
export function normalizeHtml(html: string | null | undefined): string {
  return (html ?? "").split(/\s+/).filter(Boolean).join(" ").replace(/>\s+</g, "><");
}

// ---------------------------------------------------------------------------
// UFIXIT report parsing and summaries
// ---------------------------------------------------------------------------

export interface UfixitViolation {
  wcag_criterion: string;
  type: string;
  severity: string;
  description?: string;
  location?: string;
}

const UFIXIT_ISSUE_PATTERNS: Array<[RegExp, string, string]> = [
  [/missing\s+alt\s+text/i, "missing_alt_text", "Images missing alternative text"],
  [/heading\s+structure/i, "heading_structure", "Improper heading hierarchy"],
  [/color\s+contrast/i, "color_contrast", "Insufficient color contrast"],
  [/link\s+text/i, "link_text", "Non-descriptive link text"],
  [/table\s+header/i, "table_headers", "Tables missing proper headers"],
  [/form\s+label/i, "form_labels", "Form inputs missing labels"],
];

/**
 * Line-oriented extraction from a UFIXIT/UDOIT report page: each "WCAG x.y.z"
 * mention starts a violation; later lines refine its severity, type and location.
 */
export function extractUfixitViolations(html: string): UfixitViolation[] {
  const violations: UfixitViolation[] = [];
  let current: UfixitViolation | null = null;
  for (const line of html.split("\n")) {
    const wcag = /WCAG\s+(\d+\.\d+\.\d+)/i.exec(line);
    if (wcag) {
      if (current) violations.push(current);
      current = { wcag_criterion: wcag[1]!, type: "unknown", severity: "moderate" };
    }
    if (!current) continue;
    const severity = /(critical|serious|moderate|minor|error|warning)/i.exec(line);
    if (severity) current.severity = severity[1]!.toLowerCase();
    for (const [pattern, type, description] of UFIXIT_ISSUE_PATTERNS) {
      if (pattern.test(line)) {
        current.type = type;
        current.description = description;
      }
    }
    const lowered = line.toLowerCase();
    if ((lowered.includes("page") || lowered.includes("assignment")) && current.location === undefined) {
      current.location = codePointSlice(removeHtmlTags(line).trim(), 100);
    }
  }
  if (current) violations.push(current);
  return violations;
}

export interface ViolationSummary {
  total_violations: number;
  by_severity: Record<string, number>;
  by_type: Record<string, number>;
  by_wcag_criterion: Record<string, number>;
  by_content_type: Record<string, number>;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function summarizeViolations(
  violations: Array<{ severity?: string; type?: string; wcag_criterion?: string; content_type?: string }>,
): ViolationSummary {
  const summary: ViolationSummary = {
    total_violations: violations.length,
    by_severity: {},
    by_type: {},
    by_wcag_criterion: {},
    by_content_type: {},
  };
  for (const violation of violations) {
    bump(summary.by_severity, violation.severity ?? "unknown");
    bump(summary.by_type, violation.type ?? "unknown");
    bump(summary.by_wcag_criterion, violation.wcag_criterion ?? "unknown");
    bump(summary.by_content_type, violation.content_type ?? "unknown");
  }
  return summary;
}

function titleCase(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

const SUMMARY_DETAIL_LIMIT = 20;

/** Markdown report for parse_ufixit_violations output. */
export function formatAccessibilitySummary(data: Record<string, unknown>): string {
  const summary = asRecord(data.summary);
  const violations = Array.isArray(data.violations) ? data.violations.map(asRecord) : [];
  const metadata = asRecord(data.report_metadata);
  const lines = ["# Accessibility Report Summary", ""];

  const pageTitle = asText(metadata.page_title);
  const updatedAt = asText(metadata.updated_at);
  if (pageTitle) lines.push(`**Report**: ${pageTitle}`);
  if (updatedAt) lines.push(`**Last Updated**: ${updatedAt}`);
  lines.push("");

  lines.push("## Overview");
  lines.push(`- **Total Violations**: ${asText(summary.total_violations) ?? violations.length}`);
  lines.push("");

  const bySeverity = Object.entries(asRecord(summary.by_severity));
  if (bySeverity.length > 0) {
    lines.push("### By Severity");
    for (const [severity, count] of bySeverity) lines.push(`- ${titleCase(severity)}: ${asText(count) ?? 0}`);
    lines.push("");
  }

  const byCriterion = Object.entries(asRecord(summary.by_wcag_criterion)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (byCriterion.length > 0) {
    lines.push("### By WCAG Criterion");
    for (const [criterion, count] of byCriterion) lines.push(`- WCAG ${criterion}: ${asText(count) ?? 0}`);
    lines.push("");
  }

  if (violations.length > 0) {
    lines.push("## Detailed Violations");
    lines.push("");
    violations.slice(0, SUMMARY_DETAIL_LIMIT).forEach((violation, index) => {
      lines.push(`### ${index + 1}. ${asText(violation.type) || "Unknown Issue"}`);
      const fields: Array<[string, string]> = [
        ["wcag_criterion", "WCAG"],
        ["severity", "Severity"],
        ["description", "Description"],
        ["location", "Location"],
        ["remediation", "How to Fix"],
      ];
      for (const [key, label] of fields) {
        const value = asText(violation[key]);
        if (value) lines.push(`**${label}**: ${value}`);
      }
      lines.push("");
    });
    if (violations.length > SUMMARY_DETAIL_LIMIT) {
      lines.push(`*...and ${violations.length - SUMMARY_DETAIL_LIMIT} more violations*`);
    }
  }

  return lines.join("\n");
}
