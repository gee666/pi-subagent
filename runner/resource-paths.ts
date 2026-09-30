import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Pin explicit filesystem resources before a resume switches the child to another project. */
export function resolveInheritedResource(flag: string, value: string, startupCwd: string): string {
  if (path.isAbsolute(value)) return value;
  if (value.startsWith("file://")) return fileURLToPath(value);
  // Keep package/URL/builtin references, but do not mistake Windows drive paths for URI schemes.
  if (!/^[a-z]:/i.test(value) && (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("git@"))) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
    return path.join(os.homedir(), value.slice(2));
  // Bare theme identifiers stay names; explicit paths and existing local theme resources are pinned.
  if (
    flag === "--theme" &&
    !/[\\/]/.test(value) &&
    !value.endsWith(".json") &&
    !fs.existsSync(path.resolve(startupCwd, value))
  )
    return value;
  // Resolve even missing files so a same-named file in the saved project cannot replace them.
  return path.resolve(startupCwd, value);
}
