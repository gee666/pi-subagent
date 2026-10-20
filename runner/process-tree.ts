import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

/** Snapshot while descendants still have their original PPIDs. */
export function descendantPids(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  const add = (pid: number, parent: number) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parent)) return;
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  };
  try {
    if (process.platform === "linux") {
      for (const directory of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(directory)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${directory}/stat`, "utf8");
          // The comm field can contain spaces and parentheses. PPID follows its final closing parenthesis and state.
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
          add(Number(directory), Number(fields[1]));
        } catch {
          /* A process can exit during the snapshot. */
        }
      }
    } else {
      const snapshot = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
      });
      for (const line of (snapshot.stdout ?? "").trim().split("\n")) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        add(pid, parent);
      }
    }
  } catch {
    /* Still kill the root if process enumeration is unavailable. */
  }
  const found: number[] = [];
  const visited = new Set([rootPid]);
  const pending = [rootPid];
  for (let index = 0; index < pending.length; index++) {
    for (const pid of children.get(pending[index]) ?? []) {
      if (visited.has(pid)) continue;
      visited.add(pid);
      found.push(pid);
      pending.push(pid);
    }
  }
  return found.reverse();
}

/** Stop fork-capable parents before killing children, including detached process groups. */
export function freezeDescendantPids(rootPid: number): number[] {
  const frozen = new Set<number>();
  const freeze = (pid: number) => {
    try {
      process.kill(pid, "SIGSTOP");
    } catch {
      /* Already exited or not signalable. */
    }
  };
  freeze(rootPid);
  // A child may fork between a snapshot and its SIGSTOP. Re-snapshot until the
  // frozen tree is stable; bound passes in case external processes keep changing it.
  for (let pass = 0; pass < 8; pass++) {
    const added = descendantPids(rootPid).filter((pid) => !frozen.has(pid));
    if (!added.length) break;
    for (const pid of added) {
      freeze(pid);
      frozen.add(pid);
    }
  }
  return [...new Set([...descendantPids(rootPid), ...frozen])];
}
