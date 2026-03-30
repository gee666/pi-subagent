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
	type ExtensionFactory,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import {
	type DelegationMode,
	type SingleResult,
	type SubagentDetails,
	DEFAULT_DELEGATION_MODE,
	buildSubagentDetails,
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
} from "./shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDelegationMode(raw: unknown): DelegationMode | null {
	if (raw === undefined) return DEFAULT_DELEGATION_MODE;
	if (typeof raw !== "string") return null;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "spawn" || normalized === "fork") return normalized;
	return null;
}

/**
 * Serialise a ReadonlySessionManager's current branch to JSONL.
 * Mirrors buildForkSessionSnapshotJsonl() in index.ts — kept here so child
 * extension factories can snapshot their own session for grandchild fork mode.
 */
function buildForkSnapshotJsonl(sessionManager: {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;
	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

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
// Child subagent extension factory
// ---------------------------------------------------------------------------

interface ChildExtensionOpts {
	depth: number;
	maxDepth: number;
	stack: string[];
	preventCycles: boolean;
	agents: AgentConfig[];
}

/**
 * Returns an ExtensionFactory that injects a depth-aware `subagent` tool into
 * a child AgentSession.  Depth, max-depth, ancestor stack, and cycle-prevention
 * flag are captured in the closure — not read from environment variables — so
 * every nested level gets the correct values regardless of process.env.
 */
export function makeChildSubagentExtension(opts: ChildExtensionOpts): ExtensionFactory {
	const { depth, maxDepth, stack, preventCycles, agents } = opts;

	const ChildTaskItem = Type.Object({
		agent: Type.String({ description: "Name of an available agent (must match exactly)" }),
		task: Type.String({
			description:
				"Task description. In spawn mode include all required context; in fork mode the subagent also sees this session's context.",
		}),
		cwd: Type.Optional(Type.String({ description: "Working directory for this agent" })),
	});
	const ChildSubagentParams = Type.Object({
		tasks: Type.Array(ChildTaskItem, { minItems: 1 }),
		mode: Type.Optional(
			Type.String({
				description: "'spawn' (default) or 'fork'",
				default: DEFAULT_DELEGATION_MODE,
			}),
		),
	});

	const agentList = agents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");

	return (pi: any) => {
		// Append available-agents list and delegation context to child system prompt
		pi.on("before_agent_start", async (event: any) => ({
			systemPrompt:
				event.systemPrompt +
				`\n\n## Available Subagents\n\n${agentList}\n\n` +
				`### Delegation depth\nCurrent depth: ${depth}, max: ${maxDepth}\n` +
				`Ancestor stack: ${stack.length > 0 ? stack.join(" -> ") : "(root)"}`,
		}));

		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate work to specialized subagents.",
				"",
				`Current delegation depth: ${depth}, max: ${maxDepth}.`,
				`Ancestor stack: ${stack.length > 0 ? stack.join(" -> ") : "(root)"}`,
			].join("\n"),
			parameters: ChildSubagentParams,

			async execute(
				_toolCallId: string,
				params: any,
				signal: AbortSignal | undefined,
				onUpdate: any,
				ctx: any,
			) {
				const tasks: Array<{ agent: string; task: string; cwd?: string }> =
					params.tasks ?? [];
				if (tasks.length === 0) {
					return {
						content: [{ type: "text", text: "No tasks provided." }],
						isError: true,
					};
				}

				const delegationMode = parseDelegationMode(params.mode);
				if (!delegationMode) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid mode "${params.mode}". Expected "spawn" or "fork".`,
							},
						],
						isError: true,
					};
				}

				// Cycle check
				if (preventCycles && stack.length > 0) {
					const stackSet = new Set(stack);
					const cycles = tasks.map((t) => t.agent).filter((n) => stackSet.has(n));
					if (cycles.length > 0) {
						return {
							content: [
								{
									type: "text",
									text: `Blocked: delegation cycle detected. Agents already in stack: ${cycles.join(", ")}. Stack: ${stack.join(" -> ")}`,
								},
							],
							isError: true,
						};
					}
				}

				// Fork mode: snapshot THIS child's session for its own children
				let forkSessionSnapshotJsonl: string | undefined;
				if (delegationMode === "fork") {
					const snap = buildForkSnapshotJsonl(ctx.sessionManager);
					if (!snap) {
						return {
							content: [
								{
									type: "text",
									text: 'Cannot use mode="fork": failed to snapshot current session context.',
								},
							],
							isError: true,
						};
					}
					forkSessionSnapshotJsonl = snap;
				}

				const executionMode = tasks.length === 1 ? "single" : "parallel";
				const makeDetails = (results: SingleResult[]) =>
					buildSubagentDetails(executionMode, delegationMode, null, results);

				if (tasks.length === 1) {
					const [t] = tasks;
					const result = await runAgentSameProcess({
						cwd: ctx.cwd,
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
						modelRegistry: ctx.modelRegistry,
						parentModel: ctx.model,
						signal,
						onUpdate,
						makeDetails,
					});

					if (isResultError(result)) {
						const errMsg =
							result.errorMessage ||
							result.stderr ||
							getFinalOutput(result.messages) ||
							"(no output)";
						return {
							content: [
								{
									type: "text",
									text: `Agent ${result.stopReason || "failed"}: ${errMsg}`,
								},
							],
							details: makeDetails([result]),
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: getFinalOutput(result.messages) || "(no output)",
							},
						],
						details: makeDetails([result]),
					};
				}

				return executeParallelSameProcess(
					tasks,
					delegationMode,
					forkSessionSnapshotJsonl,
					agents,
					ctx.cwd,
					depth,
					maxDepth,
					stack,
					preventCycles,
					ctx.modelRegistry,
					ctx.model,
					signal,
					onUpdate,
					makeDetails,
				);
			},

			renderCall: (args: any, theme: any) => renderCall(args, theme),
			renderResult: (result: any, opts: any, theme: any) =>
				renderResult(result, opts.expanded, theme),
		} as ToolDefinition);
	};
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
		};
	}

	const childDepth = Math.max(0, Math.floor(parentDepth)) + 1;
	const childStack = [...parentAgentStack, agentName];
	const canChildDelegate = childDepth < maxDepth;
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

	try {
		// noExtensions: true prevents auto-loading of the subagent extension (and all
		// others) inside child sessions.  Without this, the extension would be loaded
		// again and would read PI_SUBAGENT_DEPTH=0 from process.env — the root value —
		// making every child think it is unconstrained.  We inject our own depth-aware
		// subagent tool via extensionFactories instead.
		const extensionFactories: ExtensionFactory[] = canChildDelegate
			? [
					makeChildSubagentExtension({
						depth: childDepth,
						maxDepth,
						stack: childStack,
						preventCycles,
						agents,
					}),
				]
			: [];

		const loader = new DefaultResourceLoader({
			cwd: effectiveCwd,
			noExtensions: true,
			// Append agent system prompt on top of the base pi prompt —
			// matches the --append-system-prompt behaviour of the subprocess runner
			...(agent.systemPrompt.trim() ? { appendSystemPrompt: agent.systemPrompt } : {}),
			extensionFactories,
		});
		await loader.reload();

		// Resolve model: agent config overrides parent fallback
		const model = agent.model
			? (resolveModelByName(agent.model, modelRegistry) ?? parentModel)
			: parentModel;

		// Thinking level from agent config (same string values as --thinking flag)
		const thinkingLevel = agent.thinking as any | undefined;

		const sessionManager = forkTmpPath
			? SessionManager.open(forkTmpPath)
			: SessionManager.inMemory();

		const { session } = await createAgentSession({
			cwd: effectiveCwd,
			sessionManager,
			resourceLoader: loader,
			tools: buildAgentTools(agent, effectiveCwd),
			...(model ? { model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
		});

		// Forward abort signal to the child session
		const onAbort = () => session.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

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
