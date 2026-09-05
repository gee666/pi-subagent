import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set([".git", "node_modules", "tmp"]);
const maxLines = 350;

async function checkDirectory(directory) {
  let valid = true;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) {
      valid = (await checkDirectory(file)) && valid;
    } else if (entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name)) {
      const text = await readFile(file, "utf8");
      const lines = text.split("\n").length - Number(text.endsWith("\n"));
      if (lines > maxLines) {
        console.error(`${path.relative(root, file)}: ${lines} lines, maximum ${maxLines}`);
        valid = false;
      }
    }
  }
  return valid;
}

if (!(await checkDirectory(root))) process.exitCode = 1;
