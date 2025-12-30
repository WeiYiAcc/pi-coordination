import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CustomAgentTool, CustomToolFactory, ToolAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Message } from "@mariozechner/pi-ai";
import { discoverAgents, type AgentConfig } from "../subagent/agents.js";
import { getFinalOutput } from "../subagent/render.js";

function getStreamingOutput(messages: Message[]): string {
	const texts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) {
					texts.push(part.text);
				}
			}
		}
	}
	return texts.join("\n");
}
import { runSingleAgent } from "../subagent/runner.js";
import type { SingleResult, SubagentDetails } from "../subagent/types.js";
import { FileBasedStorage } from "./state.js";
import type { CoordinationState } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

interface TUIMessage {
	from: string;
	content: string;
	timestamp: number;
}

interface WorkerInfo {
	id: string;
	identity: string;
	agent: string;
	status: string;
	step: number | null;
}

interface CoordinationDetails {
	sessionId: string;
	coordDir: string;
	status: string;
	coordinatorResult: SingleResult;
	workersSpawned: number;
	workersCompleted: number;
	workers: WorkerInfo[];
	pendingAgents: string[];
	filesModified: string[];
	deviations: string[];
	tuiMessages: TUIMessage[];
}

type OnUpdateCallback = (partial: AgentToolResult<CoordinationDetails>) => void;

const CoordinateParams = Type.Object({
	plan: Type.String({ description: "Path to markdown plan file" }),
	agents: Type.Array(Type.String(), { description: "Agent types to use (e.g. ['worker', 'worker'])" }),
});

const factory: CustomToolFactory = (pi) => {
	const tool: CustomAgentTool<typeof CoordinateParams, CoordinationDetails> = {
		name: "coordinate",
		label: "Coordinate",
		description:
			"Start multi-agent coordination session. Splits a plan across parallel workers, manages dependencies, and returns unified results.",
		parameters: CoordinateParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			const coordSessionId = randomUUID();
			const sessionDir = process.env.PI_SESSION_DIR || path.join(os.homedir(), ".pi", "sessions", "default");
			const coordDir = path.join(sessionDir, "coordination", coordSessionId);

			const storage = new FileBasedStorage(coordDir);
			await storage.initialize();

			const planPath = path.resolve(pi.cwd, params.plan);
			const planDir = path.dirname(planPath);
			let planContent: string;
			try {
				planContent = await fs.readFile(planPath, "utf-8");
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to read plan file: ${planPath}\n${err}` }],
					isError: true,
				};
			}

			const initialState: CoordinationState = {
				sessionId: coordSessionId,
				planPath,
				planHash: hash(planContent),
				status: "analyzing",
				workers: {},
				contracts: {},
				deviations: [],
				startedAt: Date.now(),
			};
			await storage.setState(initialState);

			process.env.PI_ACTIVE_COORDINATION_DIR = coordDir;
			process.env.PI_COORDINATION_DIR = coordDir;
			process.env.PI_AGENT_IDENTITY = "coordinator";

			const coordinatorToolsPath = path.join(__dirname, "coordinator-tools", "index.ts");

			const discovery = discoverAgents(pi.cwd, "user");
			const agents = discovery.agents;

			const coordinatorAgent = agents.find(a => a.name === "coordinator");
			if (!coordinatorAgent) {
				delete process.env.PI_ACTIVE_COORDINATION_DIR;
				return {
					content: [{ type: "text", text: "Coordinator agent not found. Create ~/.pi/agent/agents/coordinator.md" }],
					isError: true,
				};
			}

			const augmentedAgents: AgentConfig[] = agents.map(a => {
				if (a.name === "coordinator") {
					return {
						...a,
						tools: [...(a.tools || []), coordinatorToolsPath],
					};
				}
				return a;
			});

			const task = `## Coordination Session

You are managing a coordination session. Your job is to spawn worker agents and summarize results.

### Plan to Execute
\`\`\`markdown
${planContent}
\`\`\`

### Available Agent Types
${params.agents.join(", ")}

### Coordination Directory
${coordDir}

### Workflow

1. **Call spawn_workers()** with detailed handshake specs for each step
   - This spawns workers in parallel and WAITS for all to complete
   - Each worker needs: agent type, step numbers, and detailed handshakeSpec
   
2. **Call done()** with a summary of what was accomplished
   - done() validates that workers were spawned and completed successfully

### Example spawn_workers() call:
\`\`\`json
{
  "workers": [
    {"agent": "worker", "steps": [1], "handshakeSpec": "Create src/types.ts with User interface containing id (string), name (string), email (string). Export the interface."},
    {"agent": "worker", "steps": [2], "handshakeSpec": "Create src/service.ts with createUser function that imports User from ./types and returns a User object."}
  ]
}
\`\`\`

### handshakeSpec Guidelines
- Be specific about file paths, function names, types
- Include what to import and export
- Describe the expected implementation details`;

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results,
			});

			const makeCoordDetails = (result: SingleResult, state?: CoordinationState, tuiMessages?: TUIMessage[], pendingAgents?: string[]): CoordinationDetails => {
				const stateWorkers = state ? Object.values(state.workers) : [];
				const workers: WorkerInfo[] = stateWorkers.map(w => ({
					id: w.id,
					identity: w.identity,
					agent: w.agent || "worker",
					status: w.status,
					step: w.currentStep,
				}));
				return {
					sessionId: coordSessionId,
					coordDir,
					status: state?.status || "unknown",
					coordinatorResult: result,
					workersSpawned: workers.length,
					workersCompleted: workers.filter(w => w.status === "complete").length,
					workers,
					pendingAgents: pendingAgents || [],
					filesModified: [],
					deviations: state?.deviations?.map(d => d.description) || [],
					tuiMessages: tuiMessages || [],
				};
			};

			let statusInterval: NodeJS.Timeout | null = null;
			let lastCoordResult: SingleResult = { agent: "coordinator", agentSource: "user", task: "", exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
			
			const coordOnUpdate: typeof onUpdate = onUpdate ? (partial) => {
				const result = partial.details?.results[0];
				if (result) {
					lastCoordResult = result;
					storage.getState().then(async state => {
						const tuiMsgs = await storage.getTUIMessages();
						onUpdate({
							content: [{ type: "text", text: "coordinating..." }],
							details: makeCoordDetails(result, state, tuiMsgs, params.agents),
						});
					}).catch(() => {
						onUpdate({
							content: [{ type: "text", text: "working..." }],
							details: makeCoordDetails(result, undefined, undefined, params.agents),
						});
					});
				}
			} : undefined;
			
			if (onUpdate) {
				statusInterval = setInterval(async () => {
					try {
						const state = await storage.getState();
						const tuiMsgs = await storage.getTUIMessages();
						onUpdate({
							content: [{ type: "text", text: "updating..." }],
							details: makeCoordDetails(lastCoordResult, state, tuiMsgs, params.agents),
						});
					} catch {}
				}, 100);
			}

			try {
				const result = await runSingleAgent(
					pi,
					augmentedAgents,
					"coordinator",
					task,
					planDir,
					undefined,
					signal,
					coordOnUpdate,
					makeDetails,
				);

				const finalState = await storage.getState();
				const tuiMessages = await storage.getTUIMessages();
				const details = makeCoordDetails(result, finalState, tuiMessages, params.agents);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";

				const summary = getFinalOutput(result.messages) || 
					(finalState.status === "complete" ? "Coordination completed" : `Coordination ended: ${finalState.status}`);

				return {
					content: [{ type: "text", text: summary }],
					details,
					isError,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Coordination failed: ${err}` }],
					isError: true,
				};
			} finally {
				if (statusInterval) {
					clearInterval(statusInterval);
				}
				delete process.env.PI_ACTIVE_COORDINATION_DIR;
				delete process.env.PI_COORDINATION_DIR;
				delete process.env.PI_AGENT_IDENTITY;
			}
		},

		renderCall(args, theme) {
			const planPath = args.plan || "...";
			const agentCount = args.agents?.length || 0;
			let text = theme.fg("toolTitle", theme.bold("coordinate ")) +
				theme.fg("accent", planPath) +
				theme.fg("muted", ` (${agentCount} agents)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const { details } = result;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const isError = result.isError;
			const icon = isError ? theme.fg("error", "x") : theme.fg("success", "ok");

			if (expanded) {
				const container = new Container();
				let header = `${icon} ${theme.fg("toolTitle", theme.bold("Coordination"))} `;
				header += theme.fg("muted", `[${details.status}]`);
				container.addChild(new Text(header, 0, 0));

				container.addChild(new Text(
					theme.fg("muted", `Workers: ${details.workersCompleted}/${details.workersSpawned} complete`),
					0, 0
				));

				if (details.tuiMessages && details.tuiMessages.length > 0) {
					container.addChild(new Text(theme.fg("muted", "--- Activity ---"), 0, 0));
					for (const msg of details.tuiMessages.slice(-20)) {
						const line = `[${msg.from}] ${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}`;
						container.addChild(new Text(theme.fg("dim", line), 0, 0));
					}
				}

				if (details.coordinatorResult?.usage?.turns > 0) {
					const usage = details.coordinatorResult.usage;
					const usageStr = `${usage.turns} turns, $${usage.cost.toFixed(4)}`;
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}

				const output = getFinalOutput(details.coordinatorResult?.messages || []);
				if (output) {
					container.addChild(new Text(theme.fg("muted", "--- Output ---"), 0, 0));
					const preview = output.length > 500 ? output.slice(0, 500) + "..." : output;
					container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
				}

				if (details.deviations.length > 0) {
					container.addChild(new Text(theme.fg("warning", "Deviations:"), 0, 0));
					for (const d of details.deviations) {
						container.addChild(new Text(theme.fg("dim", `  - ${d}`), 0, 0));
					}
				}

				return container;
			}

			try {
				const container = new Container();
				const msgCount = details.tuiMessages?.length || 0;
				const workers = details.workers || [];
				const complete = workers.filter(w => w.status === "complete").length;
				const failed = workers.filter(w => w.status === "failed").length;
				const allDone = workers.length > 0 && (complete + failed) === workers.length;
				
				if (allDone) {
					const statusText = failed > 0 
						? theme.fg("warning", `${complete}/${workers.length} completed, ${failed} failed`)
						: theme.fg("success", `${complete}/${workers.length} completed`);
					container.addChild(new Text(`${icon} ${statusText}`, 0, 0));
					
					let agentLine = "";
					for (const w of workers) {
						const agentType = String(w.agent || "worker").slice(0, 6);
						const shortId = String(w.identity || w.id || "?").replace(/^worker:/, "").slice(-4);
						const statusIcon = w.status === "complete" ? theme.fg("success", "ok") 
							: theme.fg("error", "x");
						agentLine += `${statusIcon} ${theme.fg("accent", agentType)}:${theme.fg("muted", shortId)}  `;
					}
					container.addChild(new Text(agentLine, 0, 0));
					
					const output = getFinalOutput(details.coordinatorResult?.messages || []);
					if (output) {
						container.addChild(new Text(theme.fg("muted", "---"), 0, 0));
						const lines = output.split("\n").slice(0, 10);
						for (const line of lines) {
							container.addChild(new Text(theme.fg("dim", line.slice(0, 80)), 0, 0));
						}
					}
					
					if (details.deviations && details.deviations.length > 0) {
						container.addChild(new Text(theme.fg("warning", "Deviations:"), 0, 0));
						for (const d of details.deviations.slice(0, 5)) {
							container.addChild(new Text(theme.fg("dim", `  - ${d}`), 0, 0));
						}
					}
				} else {
					const totalAgents = workers.length || details.pendingAgents?.length || 0;
					let headerLine = `${icon} ${complete}/${totalAgents} agents | ${msgCount} msgs`;
					container.addChild(new Text(headerLine, 0, 0));
					
					if (workers.length > 0) {
						let agentLine = "";
						for (const w of workers) {
							const agentType = String(w.agent || "worker").slice(0, 6);
							const shortId = String(w.identity || w.id || "?").replace(/^worker:/, "").slice(-4);
							const statusIcon = w.status === "complete" ? theme.fg("success", "ok") 
								: w.status === "failed" ? theme.fg("error", "x") 
								: theme.fg("warning", "..");
							agentLine += `${statusIcon} ${theme.fg("accent", agentType)}:${theme.fg("muted", shortId)}  `;
						}
						container.addChild(new Text(agentLine, 0, 0));
					} else if (details.pendingAgents && details.pendingAgents.length > 0) {
						const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
						const frameIndex = Math.floor(Date.now() / 80) % spinnerFrames.length;
						const spinner = spinnerFrames[frameIndex];
						let pendingLine = "";
						for (const agent of details.pendingAgents) {
							const agentType = String(agent).slice(0, 6);
							pendingLine += `${theme.fg("warning", spinner)} ${theme.fg("accent", agentType)}  `;
						}
						container.addChild(new Text(pendingLine, 0, 0));
					}
					
					const messages = details.tuiMessages || [];
					if (messages.length > 0) {
						const recentMsgs = messages.slice(-10);
						const firstTs = recentMsgs[0]?.timestamp || 0;
						for (const msg of recentMsgs) {
							const fromShort = String(msg.from || "?").replace("worker:", "").slice(0, 10);
							const contentPreview = String(msg.content || "").slice(0, 50);
							const isCoord = String(msg.from || "").includes("coordinator");
							const fromColored = isCoord ? theme.fg("warning", `[${fromShort}]`) : theme.fg("accent", `[${fromShort}]`);
							const elapsed = msg.timestamp ? `+${((msg.timestamp - firstTs) / 1000).toFixed(1)}s` : "";
							const timeStr = elapsed ? theme.fg("muted", `${elapsed} `) : "";
							container.addChild(new Text(`${timeStr}${fromColored} ${theme.fg("dim", contentPreview)}`, 0, 0));
						}
					} else {
						const output = getStreamingOutput(details.coordinatorResult?.messages || []);
						if (output) {
							const lines = output.split("\n").slice(0, 5);
							for (const line of lines) {
								container.addChild(new Text(theme.fg("dim", line.slice(0, 80)), 0, 0));
							}
						} else {
							container.addChild(new Text(theme.fg("dim", "Coordinator starting up (waiting for LLM response)..."), 0, 0));
						}
					}
				}
				
				return container;
			} catch (e) {
				return new Text(`Error: ${e}`, 0, 0);
			}
		},
	};

	return tool;
};

export default factory;
