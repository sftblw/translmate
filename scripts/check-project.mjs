import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const decoder = new TextDecoder("utf-8", { fatal: true });
const textExtensions = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".svelte",
  ".css",
  ".html",
  ".md",
  ".json",
  ".svg",
  ".yaml",
  ".ps1",
  ".sh",
]);
const textConfigs = new Set([".editorconfig", ".gitattributes", ".gitignore", ".prettierignore"]);

async function checkText(directory, recurse) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && recurse) {
      await checkText(path, true);
    } else if (entry.isFile() && (textExtensions.has(extname(path)) || textConfigs.has(basename(path)))) {
      const bytes = await readFile(path);
      try {
        decoder.decode(bytes);
      } catch {
        throw new Error(`Invalid UTF-8 in ${relative(root, path)}`);
      }
    }
  }
}

await checkText(root, false);
for (const folder of ["src", "docs", "public", "scripts", "changelog"]) {
  await checkText(join(root, folder), true);
}

const decisions = join(root, "docs", "decisions");
const indexFiles = new Set(["README.md", "compacted.md", "pending-compaction.md"]);
const records = (await readdir(decisions)).filter((name) => !indexFiles.has(name));
if (records.length > 20) throw new Error("Compact decisions before adding another record.");
for (const name of records) {
  const content = await readFile(join(decisions, name), "utf8");
  if (
    !/^\d{8}-\d{2}-[\w-]+\.md$/.test(name) ||
    !/^상태 `(decided|implemented|superseeded)`$/m.test(content)
  ) {
    throw new Error(`Invalid decision name or status in ${name}`);
  }
}
