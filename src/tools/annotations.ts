import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool annotations. Claude's Customize > Connectors > Permissions tab groups
 * tools by these hints (read-only vs write/delete), so a teacher can set every
 * read-only tool to "Always allow" in one place and keep approval on writes.
 * A tool without annotations is treated as a write, so every tool carries one
 * of these (tests/toolAnnotations.test.ts enforces it).
 */

/** Reads Canvas; changes nothing. */
export const READS_CANVAS: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

/** Reads local data only (school config, pseudonym-map status, bundled workflows). */
export const READS_LOCAL: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** Adds something new in Canvas (a draft page, a module, a message). Repeating it adds another. */
export const CREATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Overwrites existing Canvas content or settings (edits, grades). */
export const UPDATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** Permanently deletes something in Canvas. */
export const DELETES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** Changes reversible state that loses nothing (marking inbox messages read). */
export const MARKS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Reads Canvas and saves files on the teacher's computer (downloads, the pseudonym map). */
export const SAVES_LOCAL_FILES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Runs model-written code on the teacher's computer. */
export const RUNS_CODE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
