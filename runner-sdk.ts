/**
 * In-process subagent runner using the pi SDK.
 *
 * Creates an isolated AgentSession per subagent call instead of spawning a
 * separate `pi` process.  All environment variables (PI_SUBAGENT_DEPTH,
 * PI_SUBAGENT_MAX_DEPTH, PI_SUBAGENT_STACK, PI_SUBAGENT_PREVENT_CYCLES,
 * PI_SUBAGENT_MAX_PARALLEL_TASKS, PI_SUBAGENT_MAX_CONCURRENCY, …) are still
 * read at the root level exactly as before — they're just propagated to nested
 * sessions via closure parameters rather than via subprocess env inheritance.
 *
 * Fork mode still writes a JSONL snapshot to a temp file; the child session
 * opens it with SessionManager.open() instead of receiving it via --session.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	createCodingTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import {
	type DelegationMode,
	type LiveLogEntry,
	type SingleResult,
	type SubagentDetails,
	MAX_LIVE_LOG_ENTRIES,
	emptyUsage,
	extractToolCalls,
	getFinalOutput,
	getNestedSubagentErrorSummary,
	isResultError,
} from "./types.js";
import { renderCall, renderResult } from "./render.js";
import {
	DEFAULT_MAX_PARALLEL_TASKS,
	DEFAULT_MAX_CONCURRENCY,
	PARALLEL_HEARTBEAT_MS,
	SUBAGENT_MAX_PARALLEL_TASKS_ENV,
	SUBAGENT_MAX_CONCURRENCY_ENV,
	parseNonNegativeInt,
	mapConcurrent,
	subagentContext,
	type SubagentSessionContext,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function writeForkSessionToTempFile(
	agentName: string,
	sessionJsonl: string,
): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `fork-${safeName}.jsonl`);
	fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
	if (!dir) return;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

/**
 * Build the tool list for a child agent.
 * When the agent config restricts tools, only those are included.
 * Otherwise the full default coding tools are used.
 */
function buildAgentTools(agent: AgentConfig, cwd: string) {
	if (!agent.tools || agent.tools.length === 0) {
		return createCodingTools(cwd);
	}
	const factories: Record<string, () => unknown> = {
		read: () => createReadTool(cwd),
		bash: () => createBashTool(cwd),
		edit: () => createEditTool(cwd),
		write: () => createWriteTool(cwd),
		grep: () => createGrepTool(cwd),
		find: () => createFindTool(cwd),
		ls: () => createLsTool(cwd),
	};
	const tools = agent.tools
		.map((name) => factories[name.toLowerCase()]?.())
		.filter(Boolean) as ReturnType<typeof createCodingTools>;
	return tools.length > 0 ? tools : createCodingTools(cwd);
}

/**
 * Search available models by id.
 * Falls back to undefined when the model name can't be resolved.
 */
function resolveModelByName(modelName: string, modelRegistry: any): any {
	try {
		const available: any[] = modelRegistry.getAvailable();
		return available.find((m) => m.id === modelName) ?? undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Public API: RunAgentSameProcessOptions / runAgentSameProcess
// ---------------------------------------------------------------------------

export interface RunAgentSameProcessOptions {
	cwd: string;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	taskCwd?: string;
	delegationMode: DelegationMode;
	/** JSONL session snapshot for fork mode — same format as subprocess runner */
	forkSessionSnapshotJsonl?: string;
	parentDepth: number;
	parentAgentStack: string[];
	maxDepth: number;
	preventCycles: boolean;
	/** Pass ctx.modelRegistry from the calling tool's ExtensionContext */
	modelRegistry: any;
	/** Pass ctx.model from the calling tool's ExtensionContext */
	parentModel: any;
	signal?: AbortSignal;
	onUpdate?: (partial: any) => void;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
}

/**
 * Run a single subagent in-process using createAgentSession().
 *
 * Replaces runner.ts::runAgentSubprocess — no subprocess is spawned.
 *
 * Environment variables (PI_SUBAGENT_DEPTH, PI_SUBAGENT_MAX_DEPTH,
 * PI_SUBAGENT_STACK, PI_SUBAGENT_PREVENT_CYCLES, …) are read at the root
 * level in index.ts exactly as before.  Here depth/stack propagate via
 * the opts parameters and are captured in closure by child extension
 * factories, so nested levels always see the correct values.
 */
export async function runAgentSameProcess(
	opts: RunAgentSameProcessOptions,
): Promise<SingleResult> {
	const {
		cwd,
		agents,
		agentName,
		task,
		taskCwd,
		delegationMode,
		forkSessionSnapshotJsonl,
		parentDepth,
		parentAgentStack,
		maxDepth,
		preventCycles,
		modelRegistry,
		parentModel,
		signal,
		onUpdate,
		makeDetails,
	} = opts;

	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			toolCalls: {},
			completedTurns: 0,
			turnInProgress: false,
			liveLog: [],
		};
	}

	if (
		delegationMode === "fork" &&
		(!forkSessionSnapshotJsonl || !forkSessionSnapshotJsonl.trim())
	) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: "Cannot run in fork mode: missing parent session snapshot context.",
			usage: emptyUsage(),
			toolCalls: {},
			model: agent.model,
			stopReason: "error",
			errorMessage: "Cannot run in fork mode: missing parent session snapshot context.",
			completedTurns: 0,
			turnInProgress: false,
			liveLog: [],
		};
	}

	const childDepth = Math.max(0, Math.floor(parentDepth)) + 1;
	const childStack = [...parentAgentStack, agentName];
	const effectiveCwd = taskCwd ?? cwd;

	const result: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		toolCalls: {},
		model: agent.model,
		completedTurns: 0,
		turnInProgress: false,
		liveLog: [],
	};

	const emitUpdate = () =>
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
			details: makeDetails([result]),
		});

	emitUpdate();

	// Fork mode: write JSONL to a temp file; opened via SessionManager.open()
	// (same serialisation format as the subprocess runner — backward-compatible)
	let forkTmpDir: string | null = null;
	let forkTmpPath: string | null = null;
	if (delegationMode === "fork" && forkSessionSnapshotJsonl) {
		const tmp = writeForkSessionToTempFile(agentName, forkSessionSnapshotJsonl);
		forkTmpDir = tmp.dir;
		forkTmpPath = tmp.filePath;
	}

	const childCtx: SubagentSessionContext = {
		depth: childDepth,
		maxDepth,
		stack: childStack,
		preventCycles,
	};

	try {
		// Run the child session inside an AsyncLocalStorage context so that all
		// extensions loaded within it — including the subagent extension itself —
		// see the correct depth/stack/limits for this nesting level rather than
		// the stale root values that live in process.env.
		const loader = await subagentContext.run(childCtx, async () => {
			const l = new DefaultResourceLoader({
				cwd: effectiveCwd,
				// Append agent system prompt on top of the base pi prompt —
				// matches the --append-system-prompt behaviour of the subprocess runner
				...(agent.systemPrompt.trim() ? { appendSystemPrompt: agent.systemPrompt } : {}),
			});
			await l.reload();
			return l;
		});

		// Resolve model: agent config overrides parent fallback
		const model = agent.model
			? (resolveModelByName(agent.model, modelRegistry) ?? parentModel)
			: parentModel;

		// Thinking level from agent config (same string values as --thinking flag)
		const thinkingLevel = agent.thinking as any | undefined;

		const sessionManager = forkTmpPath
			? SessionManager.open(forkTmpPath)
			: SessionManager.inMemory();

		const { session } = await subagentContext.run(childCtx, () =>
			createAgentSession({
				cwd: effectiveCwd,
				sessionManager,
				resourceLoader: loader,
				tools: buildAgentTools(agent, effectiveCwd),
				modelRegistry,
				...(model ? { model } : {}),
				...(thinkingLevel ? { thinkingLevel } : {}),
			})
		);

		// Forward abort signal to the child session
		const onAbort = () => session.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		const pushLiveLog = (entry: LiveLogEntry) => {
			result.liveLog.push(entry);
			if (result.liveLog.length > MAX_LIVE_LOG_ENTRIES) result.liveLog.shift();
		};

		const unsub = session.subscribe((event: any) => {
			if (event.type === "message_end" && event.message) {
				result.messages.push(event.message);
				if (event.message.role === "assistant") {
					const u = event.message.usage;
					if (u) {
						result.usage.input += u.input ?? 0;
						result.usage.output += u.output ?? 0;
						result.usage.cacheRead += u.cacheRead ?? 0;
						result.usage.cacheWrite += u.cacheWrite ?? 0;
						result.usage.cost += u.cost?.total ?? 0;
						result.usage.contextTokens = u.totalTokens ?? 0;
						result.usage.turns++;
					}
					if (event.message.stopReason) result.stopReason = event.message.stopReason;
					if (event.message.errorMessage)
						result.errorMessage = event.message.errorMessage;
					if (!result.model && event.message.model) result.model = event.message.model;
				}
				emitUpdate();

			} else if (event.type === "turn_start") {
				result.turnInProgress = true;
				pushLiveLog({ kind: "turn_start" });
				emitUpdate();

			} else if (event.type === "turn_end") {
				result.completedTurns++;
				result.turnInProgress = false;
				const u = (event.message as any)?.usage;
				pushLiveLog({
					kind: "turn_end",
					turn: result.completedTurns,
					inputTokens: u?.input ?? 0,
					outputTokens: u?.output ?? 0,
				});
				emitUpdate();

			} else if (event.type === "tool_execution_start") {
				result.liveToolExecutions ??= {};
				result.liveToolExecutions[event.toolCallId] = {
					toolName: event.toolName,
					args: event.args,
				};
				pushLiveLog({ kind: "tool_start", toolName: event.toolName, args: event.args });
				emitUpdate();

			} else if (event.type === "tool_execution_end") {
				if (result.liveToolExecutions) {
					delete result.liveToolExecutions[event.toolCallId];
				}
				pushLiveLog({ kind: "tool_end", toolName: event.toolName });
				emitUpdate();
			}
		});

		try {
			await session.prompt(`Task: ${task}`);
			result.exitCode = 0;
			result.toolCalls = extractToolCalls(result.messages);

			if (result.exitCode === 0) {
				const nestedError = getNestedSubagentErrorSummary(result.messages);
				if (nestedError) {
					result.exitCode = 1;
					result.stopReason = "error";
					result.errorMessage = nestedError;
					if (!result.stderr.trim()) result.stderr = nestedError;
				}
			}
		} catch (err: any) {
			if (signal?.aborted) {
				result.exitCode = 130;
				result.stopReason = "aborted";
				result.errorMessage = "Subagent was aborted.";
				if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
			} else {
				result.exitCode = 1;
				result.stopReason = "error";
				result.errorMessage = err?.message ?? String(err);
				result.stderr = result.errorMessage ?? "";
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			unsub();
			session.dispose();
		}

		return result;
	} catch (err: any) {
		// Outer safety net: catches anything thrown by loader.reload(),
		// createAgentSession(), or other setup code outside the inner try/catch.
		const msg = err instanceof Error ? err.message : String(err);
		result.exitCode = result.exitCode === -1 ? 1 : result.exitCode;
		result.stopReason = result.stopReason ?? "error";
		result.errorMessage = result.errorMessage ?? msg;
		if (!result.stderr.trim()) result.stderr = msg;
		return result;
	} finally {
		cleanupTempDir(forkTmpDir);
	}
}

// ---------------------------------------------------------------------------
// Parallel execution (shared by root index.ts and child extension factories)
// ---------------------------------------------------------------------------

export async function executeParallelSameProcess(
	tasks: Array<{ agent: string; task: string; cwd?: string }>,
	delegationMode: DelegationMode,
	forkSessionSnapshotJsonl: string | undefined,
	agents: AgentConfig[],
	defaultCwd: string,
	depth: number,
	maxDepth: number,
	stack: string[],
	preventCycles: boolean,
	modelRegistry: any,
	parentModel: any,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: any) => void) | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
) {
	// Limits still read from env vars — same as before
	const maxParallelTasksRaw = process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV];
	const maxParallelTasksParsed = parseNonNegativeInt(maxParallelTasksRaw);
	if (maxParallelTasksRaw !== undefined && maxParallelTasksParsed === null) {
		console.warn(
			`[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_PARALLEL_TASKS_ENV}="${maxParallelTasksRaw}". Expected a non-negative integer.`,
		);
	}
	const maxParallelTasks = maxParallelTasksParsed ?? DEFAULT_MAX_PARALLEL_TASKS;

	const maxConcurrencyRaw = process.env[SUBAGENT_MAX_CONCURRENCY_ENV];
	const maxConcurrencyParsed = parseNonNegativeInt(maxConcurrencyRaw);
	if (maxConcurrencyRaw !== undefined && maxConcurrencyParsed === null) {
		console.warn(
			`[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_CONCURRENCY_ENV}="${maxConcurrencyRaw}". Expected a non-negative integer.`,
		);
	}
	const maxConcurrency = maxConcurrencyParsed ?? DEFAULT_MAX_CONCURRENCY;

	if (tasks.length > maxParallelTasks) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Too many parallel tasks (${tasks.length}). Max is ${maxParallelTasks}.`,
				},
			],
			details: makeDetails([]),
		};
	}

	const allResults: SingleResult[] = tasks.map((t) => ({
		agent: t.agent,
		agentSource: "unknown" as const,
		task: t.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		toolCalls: {},
		completedTurns: 0,
		turnInProgress: false,
		liveLog: [],
	}));

	const emitProgress = () => {
		if (!onUpdate) return;
		const running = allResults.filter((r) => r.exitCode === -1).length;
		const done = allResults.filter((r) => r.exitCode !== -1).length;
		onUpdate({
			content: [
				{
					type: "text",
					text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
				},
			],
			details: makeDetails([...allResults]),
		});
	};

	let heartbeat: NodeJS.Timeout | undefined;
	if (onUpdate) {
		emitProgress();
		heartbeat = setInterval(() => {
			if (allResults.some((r) => r.exitCode === -1)) emitProgress();
		}, PARALLEL_HEARTBEAT_MS);
	}

	let results: SingleResult[];
	try {
		results = await mapConcurrent(tasks, maxConcurrency, async (t, index) => {
			const result = await runAgentSameProcess({
				cwd: defaultCwd,
				agents,
				agentName: t.agent,
				task: t.task,
				taskCwd: t.cwd,
				delegationMode,
				forkSessionSnapshotJsonl,
				parentDepth: depth,
				parentAgentStack: stack,
				maxDepth,
				preventCycles,
				modelRegistry,
				parentModel,
				signal,
				onUpdate: (partial: any) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitProgress();
					}
				},
				makeDetails,
			});
			allResults[index] = result;
			emitProgress();
			return result;
		});
	} finally {
		if (heartbeat) clearInterval(heartbeat);
	}

	const successCount = results.filter((r) => r.exitCode === 0).length;
	const summaries = results.map((r) => {
		const output = getFinalOutput(r.messages);
		return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${output || "(no output)"}`;
	});

	return {
		content: [
			{
				type: "text" as const,
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
			},
		],
		details: makeDetails(results),
	};
}
