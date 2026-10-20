import * as fs from "node:fs";

/** Linux start time distinguishes a worker from a later process reusing its PID. */
export interface ProcessIdentity {
  pid: number;
  startTime?: string;
}

function procInfo(pid: number): { startTime: string; dead: boolean } | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { startTime: fields[19], dead: fields[0] === "Z" || fields[0] === "X" };
  } catch {
    return undefined;
  }
}

export function processIdentity(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid worker PID");
  return { pid, startTime: procInfo(pid)?.startTime };
}

export function processIsAlive(identity: ProcessIdentity): boolean {
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1) return false;
  const current = procInfo(identity.pid);
  if (current) {
    if (current.dead) return false;
    return !identity.startTime || identity.startTime === current.startTime;
  }
  try {
    process.kill(identity.pid, 0);
    return true;
  } catch (error) {
    // EPERM and unreadable /proc are not proof that a process exited.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startTime === b.startTime;
}
