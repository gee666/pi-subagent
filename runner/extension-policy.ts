import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";

export function excludedExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...new Set(
      [env["PI-SUBAGENT-EXCLUDE-EXTENSIONS"], env.PI_SUBAGENT_EXCLUDE_EXTENSIONS]
        .flatMap((value) => (value ?? "").split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function subagentDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return [env.PI_SUBAGENT_DISABLED, env["PI-SUBAGENT-DISABLED"]].some(
    (value) => value === "1" || value?.toLowerCase() === "true",
  );
}

function resolvedPath(value: string, cwd: string): string {
  const absolute = path.resolve(cwd, value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
  return fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
}

function npmName(source: string): string | undefined {
  const spec = source.replace(/^npm:/, "");
  return /^(?:@[^/\s]+\/)?[^/@\s]+(?:@[^\s]+)?$/.test(spec)
    ? spec.slice(0, spec.indexOf("@", 1) === -1 ? undefined : spec.indexOf("@", 1))
    : undefined;
}

function manifestName(directory: string): string | undefined {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  return typeof parsed === "object" && parsed !== null && "name" in parsed && typeof parsed.name === "string"
    ? parsed.name
    : undefined;
}

function packageName(resource: ResolvedResource, cwd: string, agentDir: string): string | undefined {
  if (resource.metadata.source.startsWith("npm:")) return npmName(resource.metadata.source);
  if (resource.metadata.origin === "package" && resource.metadata.baseDir) {
    const base = resolvedPath(resource.metadata.baseDir, cwd);
    if (fs.existsSync(path.join(base, "package.json"))) return manifestName(base);
  }

  const resourcePath = resolvedPath(resource.path, cwd);
  let directory = fs.statSync(resourcePath).isDirectory() ? resourcePath : path.dirname(resourcePath);
  const boundaries = new Set(
    [
      cwd,
      agentDir,
      path.join(cwd, ".pi"),
      path.join(cwd, ".pi/extensions"),
      path.join(agentDir, "extensions"),
      os.homedir(),
    ].map((entry) => resolvedPath(entry, cwd)),
  );
  // A loose hook belongs to neither the surrounding workspace nor Pi's config
  // directory. Resolve symlinks first, and stop at the nearest manifest even if unnamed.
  while (!boundaries.has(directory) && directory !== path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, "package.json"))) return manifestName(directory);
    directory = path.dirname(directory);
  }
  return undefined;
}

function isExcluded(resource: ResolvedResource, excludes: string[], cwd: string, agentDir: string): boolean {
  const resourcePath = resolvedPath(resource.path, cwd);
  const name = packageName(resource, cwd, agentDir);
  return excludes.some((exclude) => {
    if (
      (resource.metadata.origin === "package" && exclude === resource.metadata.source) ||
      (name !== undefined && npmName(exclude) === name)
    )
      return true;
    const excludedPath = resolvedPath(exclude, cwd);
    return resourcePath === excludedPath || resourcePath.startsWith(`${excludedPath}${path.sep}`);
  });
}

function isRemote(source: string): boolean {
  return /^(?:npm:|git:|https?:\/\/|git@|ssh:)/.test(source);
}

/** Resolve before loading: filtering Extension objects would already have executed their factories. */
export async function childExtensionArgs(
  args: string[],
  cwd: string,
  projectTrusted = false,
  excludes = excludedExtensions(),
  agentDir = getAgentDir(),
): Promise<string[]> {
  if (excludes.length === 0) return args;
  const rest: string[] = [];
  const explicit: string[] = [];
  let noExtensions = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-ne" || arg === "--no-extensions") noExtensions = true;
    else if (arg === "-e" || arg === "--extension") {
      const source = args[++index];
      if (!source) throw new Error("Missing explicit extension source");
      explicit.push(source);
    } else if (["-a", "--approve", "-na", "--no-approve"].includes(arg)) {
      // The live parent's decision is authoritative, not stale startup flags.
    } else rest.push(arg);
  }
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
  if (settingsManager.drainErrors().length > 0) throw new Error("Cannot resolve child extensions: invalid Pi settings");
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const automatic = noExtensions ? [] : (await manager.resolve(async () => "error")).extensions;
  const explicitResources: ResolvedResource[] = [];
  for (const source of explicit) {
    let resolved;
    if (isRemote(source)) {
      // resolveExtensionSources can install or refresh remote sources. Use the read-only
      // missing-source policy instead; temporary-only remote installs must be installed normally first.
      const explicitSettings = SettingsManager.inMemory(
        {
          npmCommand: settingsManager.getGlobalSettings().npmCommand,
          packages: [source],
        },
        { projectTrusted: false },
      );
      const explicitManager = new DefaultPackageManager({ cwd, agentDir, settingsManager: explicitSettings });
      if (!explicitManager.getInstalledPath(source, "user")) {
        throw new Error(`Explicit extension source must be installed before exclusion filtering: ${source}`);
      }
      resolved = await explicitManager.resolve(async () => "error");
      for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
        resolved[kind] = resolved[kind].filter(
          (resource) => resource.metadata.origin === "package" && resource.metadata.source === source,
        );
      }
      if (Object.values(resolved).every((resources) => resources.length === 0)) {
        throw new Error(`No installed resources match explicit extension source: ${source}`);
      }
    } else {
      const local = resolvedPath(source, cwd);
      if (!fs.existsSync(local)) throw new Error(`Missing explicit extension source: ${source}`);
      resolved = await manager.resolveExtensionSources([local], { temporary: true });
    }
    explicitResources.push(...resolved.extensions);
    for (const [kind, flag] of [
      ["skills", "--skill"],
      ["prompts", "--prompt-template"],
      ["themes", "--theme"],
    ] as const) {
      for (const resource of resolved[kind]) if (resource.enabled) rest.push(flag, resource.path);
    }
  }
  const kept = new Set<string>();
  for (const resource of [...explicitResources, ...automatic]) {
    if (!resource.enabled || isExcluded(resource, excludes, cwd, agentDir)) continue;
    if (!fs.statSync(resource.path).isFile()) {
      throw new Error(`Extension source did not resolve to files: ${resource.path}. Pass its entry point explicitly.`);
    }
    kept.add(resource.path);
  }
  return [
    ...rest,
    projectTrusted ? "--approve" : "--no-approve",
    "--no-extensions",
    ...[...kept].flatMap((entry) => ["-e", entry]),
  ];
}
