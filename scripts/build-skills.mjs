#!/usr/bin/env node
/**
 * Package the teacher skills for distribution, with no external zip tool
 * (Windows has none by default):
 *
 *   build/skills/<skill-name>.zip         one per skill — upload in Claude Desktop:
 *                                          Settings → Capabilities → Skills → Upload skill
 *   build/skills/canvas-teaching-skills.plugin
 *                                          all skills as one Claude plugin bundle
 *
 * Only SKILL.md files ship. Run with: npm run build:skills
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(repoRoot, "skills");
const outDir = path.join(repoRoot, "build", "skills");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (deflate, UTF-8 names, fixed timestamp for reproducible output). */
function buildZip(entries) {
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function parseFrontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error(`${file}: frontmatter needs name and description`);
  if (description.length > 1024) throw new Error(`${file}: description is ${description.length} chars (max 1024)`);
  return { name, description };
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const dirs = (await fs.readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const pluginEntries = [];
  for (const dir of dirs) {
    const file = path.join(skillsDir, dir, "SKILL.md");
    const data = await fs.readFile(file);
    const { name } = parseFrontmatter(data.toString("utf8"), file);
    if (name !== dir) throw new Error(`${file}: frontmatter name "${name}" must match folder "${dir}"`);
    await fs.writeFile(path.join(outDir, `${dir}.zip`), buildZip([{ name: `${dir}/SKILL.md`, data }]));
    pluginEntries.push({ name: `skills/${dir}/SKILL.md`, data });
    process.stdout.write(`[build-skills] ${dir}.zip\n`);
  }

  const pluginJson = {
    name: "canvas-teaching-skills",
    version: pkg.version,
    description: "Teacher skills for the Canvas for Teachers MCP server: plan lessons, modules, courses and assessments; post pages and quizzes; rubrics and grading; morning check; course QC; accessibility; discussions; peer reviews.",
    author: { name: "SVCTE STEAM (skills adapted from Jaymes Dec and Vishal Sachdev, MIT)" },
    keywords: ["canvas", "teaching", "lms", "grading"],
  };
  const plugin = buildZip([
    { name: ".claude-plugin/plugin.json", data: Buffer.from(JSON.stringify(pluginJson, null, 2)) },
    ...pluginEntries,
  ]);
  await fs.writeFile(path.join(outDir, "canvas-teaching-skills.plugin"), plugin);
  process.stdout.write(`[build-skills] canvas-teaching-skills.plugin (${dirs.length} skills)\n`);
}

main().catch((error) => {
  process.stderr.write(`[build-skills] ERROR: ${error?.message ?? error}\n`);
  process.exit(1);
});
