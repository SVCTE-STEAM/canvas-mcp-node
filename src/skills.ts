import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Teacher workflows ("skills") shipped inside the .mcpb.
 *
 * Claude Desktop has no way to install skills from an extension, and asking
 * teachers to upload 14 zip files defeats a one-click install. So the
 * SKILL.md files ride along in <install>/skills/ and the server serves them
 * itself: a get_skill tool (catalog in its description, so the model knows
 * when to load one), MCP prompts for picking a workflow by hand, and a
 * pointer in the server instructions.
 */

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md content without the YAML frontmatter. */
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkill(text: string, source: string): Skill {
  const match = text.match(FRONTMATTER);
  if (!match) throw new Error(`${source}: missing YAML frontmatter`);
  const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error(`${source}: frontmatter needs name and description`);
  return { name, description, body: text.slice(match[0].length).trim() };
}

/**
 * Load every <dir>/<skill>/SKILL.md. A missing directory yields [] (the server
 * still runs; the workflows are an add-on). A malformed SKILL.md is skipped
 * with a warning rather than taking the whole server down.
 */
export async function loadSkills(
  dir: string,
  warn: (message: string) => void = () => undefined,
): Promise<Skill[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    warn(`skills directory not found at ${dir}; built-in workflows disabled`);
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    try {
      const skill = parseSkill(text, file);
      if (skill.name !== entry.name) {
        warn(`${file}: frontmatter name "${skill.name}" does not match folder "${entry.name}"; skipped`);
        continue;
      }
      skills.push(skill);
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
