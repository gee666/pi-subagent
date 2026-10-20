import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadPiSubagentsConfig } from "../config.js";
import { clearSessionBudgetLimit, readBudget, setSessionBudgetLimit } from "../budget.js";
import { configuredEnv, withSessionSettings, type SettingEnv } from "../settings.js";
import { DEFAULT_MAX_TASKS_PER_CALL, parseNonNegativeInt } from "../shared.js";
import { saveSubagentSettings } from "../storage/save-settings.js";
import { subagentDisabled } from "../runner/extension-policy.js";
import { ensureSubagentToolActive, resolveDelegationDepthConfig } from "./policy.js";
import { updateCombinedUsageStatus } from "./runtime.js";
import { registerToolsWithConfig } from "./tool-registration.js";
import { schedulerFor } from "./scheduler.js";
import { isSubagentToolName, STOP_SUBAGENT_TOOL_NAME } from "../types.js";
import type { ExtensionState } from "./state.js";

type Control = {
  name: string;
  env: SettingEnv;
  description: string;
  defaultValue: string;
  choices?: string[];
  choiceHints?: Record<string, string>;
  inverted?: boolean;
  positive?: boolean;
};

export const SESSION_CONTROLS: Control[] = [
  {
    name: "max-total",
    env: "PI_SUBAGENT_MAX_TOTAL_AGENTS",
    description: "Limit how many workers can be created in total, including workers started by other workers",
    defaultValue: "50",
  },
  {
    name: "max-tasks-per-call",
    env: "PI_SUBAGENT_MAX_TASKS_PER_CALL",
    description: "Limit how many tasks the assistant can submit in a single launch",
    defaultValue: "20",
    positive: true,
  },
  {
    name: "max-concurency",
    env: "PI_SUBAGENT_MAX_CONCURRENCY",
    description:
      "Limit live worker processes across the entire nested tree, including waiting parents; extra work queues",
    defaultValue: "8",
    positive: true,
  },
  {
    name: "max-depth",
    env: "PI_SUBAGENT_MAX_DEPTH",
    description: "Limit nesting: 1 allows direct workers only; 0 blocks worker launches",
    defaultValue: "3",
  },
  {
    name: "prevent-cycles",
    env: "PI_SUBAGENT_PREVENT_CYCLES",
    description: "Stop a worker from delegating back to an agent type already in its chain",
    defaultValue: "true",
    choices: ["on", "off"],
  },
  {
    name: "auto-resume",
    env: "PI_SUBAGENT_DISABLE_RESUME",
    description: "Recover unfinished worker tasks when reopening a chat or navigating its history",
    choiceHints: {
      on: "Enable recovery; resume-prompt controls whether to ask first",
      off: "Do not automatically recover unfinished tasks; named resumes still work",
    },
    defaultValue: "false",
    choices: ["on", "off"],
    inverted: true,
  },
  {
    name: "resume-prompt",
    env: "PI_SUBAGENT_RESUME_PROMPT",
    description: "Ask before recovering unfinished tasks; off continues without asking, not without recovery",
    choiceHints: {
      on: "Ask before recovery in the interactive terminal",
      off: "Recover without asking; use auto-resume off to disable recovery",
    },
    defaultValue: "true",
    choices: ["on", "off"],
  },
  {
    name: "intelligence",
    env: "PI_SUBAGENT_INTELLIGENCE",
    description: "Use your configured worker model presets, such as junior and senior",
    defaultValue: "true",
    choices: ["on", "off"],
  },
  {
    name: "confirm-project",
    env: "PI_SUBAGENT_CONFIRM_PROJECT_AGENTS",
    description: "Choose whether to ask before running agent definitions supplied by this repository",
    choiceHints: {
      ask: "Ask for approval before running repository-defined agents",
      session: "Treat repository-defined agents as approved for this session",
      never: "Never ask for approval; this allows project agents, it does not block them",
    },
    defaultValue: "ask",
    choices: ["ask", "session", "never"],
  },
];

function valueFor(state: ExtensionState, control: Control): string {
  let value = configuredEnv(control.env, state.settings) ?? control.defaultValue;
  if (control.name === "max-total" && state.currentBudget) value = String(readBudget(state.currentBudget).limit);
  if (control.name === "max-depth") value = String(state.maxDepth);
  if (control.name === "prevent-cycles") value = String(state.preventCycles);
  if (control.name === "max-concurency") value = String(schedulerFor(state).concurrency);
  if (control.choices?.includes("on")) {
    const enabled = value === "true" || value === "1";
    return enabled !== !!control.inverted ? "on" : "off";
  }
  return value;
}

function parseValue(control: Control, raw: string): string {
  if (control.choices?.includes("on")) {
    if (!["on", "off", "true", "false"].includes(raw)) throw new Error("Use on or off.");
    return String((raw === "on" || raw === "true") !== !!control.inverted);
  }
  if (control.choices) {
    if (!control.choices.includes(raw)) throw new Error(`Use ${control.choices.join(", ")}.`);
    return raw;
  }
  const minimum = control.positive ? 1 : 0;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum)
    throw new Error(`Use a safe integer of ${minimum} or greater.`);
  return String(Number(raw));
}

function applySettings(state: ExtensionState, ctx: ExtensionCommandContext): void {
  const config = loadPiSubagentsConfig(ctx.cwd, ctx.isProjectTrusted(), state.sessionSettings);
  state.settings = config.settings;
  Object.assign(state, resolveDelegationDepthConfig(state.pi, state.settings));
  // Explicit main-session commands also override startup CLI flags.
  if (state.sessionSettings?.PI_SUBAGENT_MAX_DEPTH !== undefined)
    state.maxDepth = Number(state.sessionSettings.PI_SUBAGENT_MAX_DEPTH);
  if (state.sessionSettings?.PI_SUBAGENT_PREVENT_CYCLES !== undefined)
    state.preventCycles = state.sessionSettings.PI_SUBAGENT_PREVENT_CYCLES === "true";
  state.disabled = subagentDisabled(process.env, state.settings);
  state.canDelegate = !state.disabled && state.currentDepth < state.maxDepth;
  state.maxTasksPerCall =
    parseNonNegativeInt(configuredEnv("PI_SUBAGENT_MAX_TASKS_PER_CALL", state.settings)) ?? DEFAULT_MAX_TASKS_PER_CALL;
  schedulerFor(state);
  registerToolsWithConfig(state, ctx.cwd, ctx.isProjectTrusted(), true, config);
  state.pi.setActiveTools(
    state.pi
      .getActiveTools()
      .filter((name) => !isSubagentToolName(name) || name === STOP_SUBAGENT_TOOL_NAME || state.canDelegate),
  );
  if (state.canDelegate) ensureSubagentToolActive(state.pi);
  updateCombinedUsageStatus(state, ctx);
}

function editable(state: ExtensionState, ctx: ExtensionCommandContext, allowBusy = false): boolean {
  if (state.currentDepth > 0) {
    ctx.ui.notify("Change session settings in the main session, not in a child with an inherited grant.", "warning");
    return false;
  }
  if (!allowBusy && !ctx.isIdle()) {
    ctx.ui.notify("Wait for the current assistant turn to finish before changing settings.", "warning");
    return false;
  }
  return true;
}

export function registerSettingsCommands(state: ExtensionState): void {
  if (typeof state.pi.registerCommand !== "function") return;
  state.pi.on("session_shutdown", () => {
    if (state.currentBudget) clearSessionBudgetLimit(state.currentBudget);
    state.sessionSettings = {};
  });
  for (const enabled of [true, false]) {
    state.pi.registerCommand(`subagent:${enabled ? "enable" : "disable"}`, {
      description: enabled
        ? "Allow new worker launches and resumes for this session"
        : "Block new worker launches and resumes for this session; running workers keep going",
      handler: async (args, ctx) => {
        if (args.trim()) {
          ctx.ui.notify("This command takes no arguments.", "warning");
          return;
        }
        if (!editable(state, ctx)) return;
        state.sessionSettings = { ...state.sessionSettings, PI_SUBAGENT_DISABLED: String(!enabled) };
        applySettings(state, ctx);
        ctx.ui.notify(
          `Subagents ${enabled ? "enabled" : "disabled"} for this session. Running workers are unchanged.`,
          "info",
        );
      },
    });
  }
  for (const control of SESSION_CONTROLS) {
    state.pi.registerCommand(`subagent:${control.name}`, {
      description: `${control.description}. Session only; omit the value for help`,
      getArgumentCompletions: control.choices
        ? (prefix) =>
            control
              .choices!.filter((value) => value.startsWith(prefix))
              .map((value) => ({ value, label: value, description: control.choiceHints?.[value] }))
        : undefined,
      handler: async (args, ctx) => {
        try {
          const raw = args.trim();
          if (!raw) {
            ctx.ui.notify(
              [
                `${control.name}: ${valueFor(state, control)}`,
                control.description,
                ...Object.entries(control.choiceHints ?? {}).map(([value, hint]) => `${value}: ${hint}`),
                `Use /subagent:${control.name} ${control.choices?.join("|") ?? "<number>"}. Changes apply only to this session.`,
              ].join("\n"),
              "info",
            );
            return;
          }
          const liveLimit = control.name === "max-concurency" || control.name === "max-total";
          if (!editable(state, ctx, liveLimit)) return;
          const value = parseValue(control, raw);
          if (control.name === "max-total" && state.currentBudget)
            setSessionBudgetLimit(state.currentBudget, Number(value));
          state.sessionSettings = { ...state.sessionSettings, [control.env]: value };
          if (liveLimit) {
            state.settings = withSessionSettings(state.settings ?? {}, state.sessionSettings);
            if (control.name === "max-concurency") schedulerFor(state);
          } else applySettings(state, ctx);
          ctx.ui.notify(`${control.name}: ${valueFor(state, control)}. Session only; not saved.`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  }
  state.pi.registerCommand("subagent:settings", {
    description: "Show session settings and available settings commands",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(
          [
            `Subagents: ${state.disabled ? "disabled" : "enabled"}. Changes are session-only.`,
            "/subagent:enable | /subagent:disable",
            ...SESSION_CONTROLS.map(
              (control) =>
                `/subagent:${control.name} ${control.choices?.join("|") ?? "<number>"} = ${valueFor(state, control)}\n  ${control.description}`,
            ),
            "/subagent:save-settings [project|global] saves only command overrides.",
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
  state.pi.registerCommand("subagent:save-settings", {
    description: "Keep your session changes for future chats; choose this project or all projects",
    getArgumentCompletions: (prefix) =>
      ["project", "global"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!editable(state, ctx)) return;
      let scope = args.trim();
      if (scope && scope !== "project" && scope !== "global") {
        ctx.ui.notify("Use /subagent:save-settings [project|global].", "warning");
        return;
      }
      const overrides = { ...state.sessionSettings };
      if (!Object.keys(overrides).length) {
        ctx.ui.notify("No session setting changes to save.", "info");
        return;
      }
      const generation = state.lifecycleGeneration;
      if (!scope) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Choose project or global explicitly.", "warning");
          return;
        }
        scope = (await ctx.ui.select("Save subagent settings", ["project", "global"])) ?? "";
      }
      if ((scope !== "project" && scope !== "global") || generation !== state.lifecycleGeneration) return;
      try {
        const file = await saveSubagentSettings(ctx.cwd, scope, overrides);
        ctx.ui.notify(
          `Saved subagent setting overrides to ${file}. Environment and project precedence still apply in future sessions.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
