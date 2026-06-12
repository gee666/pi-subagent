/**
 * Custom footer that places the combined subagent "total" usage line directly
 * below pi's normal stats line, with other extensions' statuses (e.g. SSH) on
 * their own line below.
 *
 * Layout:
 *   <pwd (git branch) line>          — from the builtin footer
 *   parent <stats line>              — builtin stats, prefixed when a total exists
 *   total Σ ...                      — combined parent + subagent usage
 *   <blank>
 *   <other extension statuses>       — joined on one separate line
 *
 * Implementation: pi joins all `ctx.ui.setStatus()` texts onto a single
 * footer line, so multi-line layouts require `ctx.ui.setFooter()`. To avoid
 * re-implementing (and drifting from) the builtin stats line, the builtin
 * FooterComponent is loaded from the running pi installation and wrapped. If
 * that ever fails (pi internals moved), installation reports failure and the
 * caller falls back to the plain single-line setStatus behavior.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { getPiCliScriptPath } from "./runner.js";

export interface SubagentFooterController {
  /** Update the rendered total line (undefined hides it). */
  setTotalLine(text: string | undefined): void;
  /** Track the most recent extension context (model/session may change). */
  updateContext(ctx: any): void;
  /** Restore the builtin footer. */
  dispose(): void;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

async function loadBuiltinFooterComponent(): Promise<any | null> {
  try {
    const cliScript = getPiCliScriptPath();
    if (!cliScript) return null;
    const distDir = path.dirname(fs.realpathSync(cliScript));
    const footerPath = path.join(distDir, "modes", "interactive", "components", "footer.js");
    if (!fs.existsSync(footerPath)) return null;
    const mod = await import(pathToFileURL(footerPath).href);
    return typeof mod?.FooterComponent === "function" ? mod.FooterComponent : null;
  } catch {
    return null;
  }
}

function getThinkingLevel(ctx: any): string {
  try {
    const entries = ctx?.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
        return entry.thinkingLevel;
      }
    }
  } catch {
    /* fall through */
  }
  return "off";
}

/**
 * Install the custom subagent footer. Returns a controller on success or null
 * when the builtin footer component cannot be wrapped (caller should fall back
 * to ctx.ui.setStatus).
 */
export async function installSubagentFooter(
  initialCtx: any,
  ownStatusKey: string,
): Promise<SubagentFooterController | null> {
  const FooterComponent = await loadBuiltinFooterComponent();
  if (!FooterComponent) return null;
  if (typeof initialCtx?.ui?.setFooter !== "function") return null;

  let ctx = initialCtx;
  let totalLine: string | undefined;
  let requestRender: (() => void) | undefined;
  let installed = false;

  const shimSession = {
    get state() {
      return {
        model: ctx?.model,
        thinkingLevel: getThinkingLevel(ctx),
      };
    },
    get sessionManager() {
      return ctx?.sessionManager;
    },
    get modelRegistry() {
      return ctx?.modelRegistry ?? { isUsingOAuth: () => false };
    },
    getContextUsage() {
      try {
        return ctx?.getContextUsage?.();
      } catch {
        return undefined;
      }
    },
  };

  // Smoke-test the wrapped component once before replacing the real footer.
  // If pi's internal constructor or render contract changed, fail installation
  // so the caller falls back to the plain status line instead of risking a
  // broken footer.
  try {
    const probe = new FooterComponent(shimSession, {
      getGitBranch: () => undefined,
      getExtensionStatuses: () => new Map(),
    });
    const probeLines = probe.render(80);
    if (!Array.isArray(probeLines)) return null;
    probe.dispose?.();
  } catch {
    return null;
  }

  try {
    initialCtx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      let builtin: any = null;
      try {
        builtin = new FooterComponent(shimSession, footerData);
      } catch (err) {
        console.error("[pi-subagent] Failed to construct builtin footer wrapper:", err);
      }
      requestRender = () => {
        try {
          tui.requestRender();
        } catch {
          /* TUI gone */
        }
      };
      const unsubscribe = (() => {
        try {
          return typeof footerData?.onBranchChange === "function"
            ? footerData.onBranchChange(() => requestRender?.())
            : undefined;
        } catch {
          return undefined;
        }
      })();

      const fallbackRender = (width: number): string[] => {
        const lines: string[] = [];
        if (totalLine) lines.push(truncateToWidth(theme.fg("dim", totalLine), width, theme.fg("dim", "...")));
        try {
          const extensionStatuses = footerData?.getExtensionStatuses?.();
          if (extensionStatuses && extensionStatuses.size > 0) {
            const statusLine = Array.from(extensionStatuses.entries() as Iterable<[string, string]>)
              .sort(([a], [b]) => a.localeCompare(b))
              .filter(([key]) => key !== ownStatusKey)
              .map(([, text]) => sanitizeStatusText(text))
              .join(" ");
            if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }
        } catch {
          /* statuses unavailable */
        }
        return lines.length > 0 ? lines : [""];
      };

      return {
        dispose() {
          try {
            unsubscribe?.();
          } catch {
            /* ignore */
          }
          try {
            builtin?.dispose?.();
          } catch {
            /* ignore */
          }
        },
        invalidate() {
          try {
            builtin?.invalidate?.();
          } catch {
            /* ignore */
          }
        },
        render(width: number): string[] {
          try {
            if (!builtin) return fallbackRender(width);
            const parentPrefix = totalLine ? theme.fg("dim", "parent ") : "";
            const prefixWidth = totalLine ? "parent ".length : 0;
            const builtinLines: string[] = builtin.render(Math.max(20, width - prefixWidth));
            // Builtin layout: [pwdLine, statsLine, joinedExtensionStatuses?].
            // We re-render the status section ourselves on a separate line.
            const lines: string[] = [];
            if (builtinLines.length >= 2) {
              const pwdLine = prefixWidth > 0 ? builtin.render(width)[0] : builtinLines[0];
              lines.push(pwdLine ?? builtinLines[0]);
              lines.push(parentPrefix + builtinLines[1]);
            } else {
              lines.push(...builtinLines.slice(0, 2));
            }
            if (totalLine) lines.push(truncateToWidth(theme.fg("dim", totalLine), width, theme.fg("dim", "...")));

            const statuses: string[] = [];
            const extensionStatuses = footerData?.getExtensionStatuses?.();
            if (extensionStatuses && extensionStatuses.size > 0) {
              for (const [key, text] of Array.from(extensionStatuses.entries() as Iterable<[string, string]>).sort(
                ([a], [b]) => a.localeCompare(b),
              )) {
                if (key === ownStatusKey) continue;
                statuses.push(sanitizeStatusText(text));
              }
            }
            if (statuses.length > 0) {
              lines.push("");
              lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
            }
            return lines;
          } catch (err) {
            console.error("[pi-subagent] Custom footer render failed:", err);
            return fallbackRender(width);
          }
        },
      };
    });
    installed = true;
  } catch {
    return null;
  }
  if (!installed) return null;

  return {
    setTotalLine(text: string | undefined) {
      const next = text ? `total ${text}` : undefined;
      if (next === totalLine) return;
      totalLine = next;
      requestRender?.();
    },
    updateContext(nextCtx: any) {
      if (nextCtx) ctx = nextCtx;
    },
    dispose() {
      try {
        ctx?.ui?.setFooter?.(undefined);
      } catch {
        /* ignore */
      }
    },
  };
}
