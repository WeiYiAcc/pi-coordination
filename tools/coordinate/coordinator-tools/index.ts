import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CustomAgentTool, CustomToolFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { FileBasedStorage } from "../state.js";
import type { WorkerState } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WorkerHandle {
	workerId: string;
	identity: string;
	pid: number;
	proc: ChildProcess;
	promise: Promise<number>;
}

function spawnWorkerProcess(
	config: { agent: string; handshakeSpec: string; steps: number[] },
	coordDir: string,
	cwd: string,
	storage: FileBasedStorage,
): WorkerHandle {
	const workerToolsPath = path.join(__dirname, "..", "worker-tools", "index.ts");
	const reservationHookPath = path.join(__dirname, "..", "worker-hooks", "reservation.ts");

	const workerId = randomUUID();
	const identity = `worker:${config.agent}-${workerId.slice(0, 4)}`;

	const args = [
		"--model", "claude-sonnet-4-20250514",
		"--mode", "json",
		"-p",
		"--no-session",
		"--tool", workerToolsPath,
		"--hook", reservationHookPath,
		`Task: ${config.handshakeSpec}`,
	];

	const proc = spawn("pi", args, {
		cwd,
		env: {
			...process.env,
			PI_COORDINATION_DIR: coordDir,
			PI_AGENT_IDENTITY: identity,
			PI_WORKER_ID: workerId,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (!proc.pid) {
		throw new Error(`Failed to start worker process for ${config.agent}`);
	}

	let buffer = "";
	proc.stdout?.on("data", (data) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const text = event.message.content?.find((c: { type: string }) => c.type === "text")?.text;
					if (text) {
						storage.appendTUIMessage({
							from: identity,
							content: text.slice(0, 200) + (text.length > 200 ? "..." : ""),
							timestamp: Date.now(),
						}).catch(() => {});
					}
				}
				if (event.type === "tool_execution_start") {
					storage.appendTUIMessage({
						from: identity,
						content: `[tool] ${event.toolName}`,
						timestamp: Date.now(),
					}).catch(() => {});
				}
			} catch {}
		}
	});

	proc.stderr?.on("data", (data) => {
		const text = data.toString().trim();
		if (text) {
			storage.appendTUIMessage({
				from: identity,
				content: `[stderr] ${text.slice(0, 100)}`,
				timestamp: Date.now(),
			}).catch(() => {});
		}
	});

	const promise = new Promise<number>((resolve) => {
		proc.on("close", (code) => {
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer);
					if (event.type === "message_end") {
						storage.appendTUIMessage({
							from: identity,
							content: "(completed)",
							timestamp: Date.now(),
						}).catch(() => {});
					}
				} catch {}
			}
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));
	});

	return { workerId, identity, pid: proc.pid, proc, promise };
}

const WorkerSpec = Type.Object({
	agent: Type.String({ description: "Agent type name" }),
	handshakeSpec: Type.String({ description: "Detailed task specification for the worker" }),
	steps: Type.Array(Type.Number(), { description: "Step numbers assigned to this worker" }),
});

const factory: CustomToolFactory = (pi) => {
	const coordDir = process.env.PI_COORDINATION_DIR;
	const identity = process.env.PI_AGENT_IDENTITY;

	if (!coordDir || !identity) {
		throw new Error("Coordinator tools require PI_COORDINATION_DIR and PI_AGENT_IDENTITY environment variables");
	}

	const storage = new FileBasedStorage(coordDir);

	const tools: CustomAgentTool[] = [
		{
			name: "spawn_workers",
			description: "Spawn workers in parallel, wait for all to complete, and return results. This blocks until all workers finish.",
			parameters: Type.Object({
				workers: Type.Array(WorkerSpec, { description: "Worker specifications" }),
			}),
			async execute(_toolCallId, params) {
				const handles: WorkerHandle[] = [];

				for (const w of params.workers) {
					const handle = spawnWorkerProcess(w, coordDir, pi.cwd, storage);
					handles.push(handle);

					await storage.addWorker(handle.workerId, {
						id: handle.workerId,
						identity: handle.identity,
						agent: w.agent,
						pid: handle.pid,
						status: "working",
						assignedSteps: w.steps,
						completedSteps: [],
						currentStep: w.steps[0] || null,
						blockers: [],
						handshakeSpec: w.handshakeSpec,
					});
				}

				await storage.appendTUIMessage({
					from: identity,
					content: `Spawned ${handles.length} workers: ${handles.map((h) => h.identity).join(", ")}`,
					timestamp: Date.now(),
				});

				const exitCodes = await Promise.all(handles.map((h) => h.promise));

				for (let i = 0; i < handles.length; i++) {
					const handle = handles[i];
					const exitCode = exitCodes[i];
					await storage.updateWorker(handle.workerId, (w) => {
						if (!w) return undefined;
						if (w.status !== "complete") {
							return { ...w, status: exitCode === 0 ? "complete" : "failed" };
						}
						return w;
					});
				}

				await storage.appendTUIMessage({
					from: identity,
					content: `All ${handles.length} workers finished`,
					timestamp: Date.now(),
				});

				const state = await storage.getState();
				const workerResults = handles.map((h, i) => {
					const w = state.workers[h.workerId];
					return `- ${h.identity}: ${w?.status || "unknown"} (exit ${exitCodes[i]})`;
				});

				return {
					content: [{ type: "text", text: `All ${handles.length} workers completed:\n${workerResults.join("\n")}` }],
					details: { workers: handles.map((h) => ({ workerId: h.workerId, identity: h.identity, pid: h.pid })) },
				};
			},
		},

		{
			name: "check_status",
			description: "Get current status of all workers, contracts, and reservations",
			parameters: Type.Object({}),
			async execute() {
				const state = await storage.getState();
				const messages = await storage.getMessages({ since: Date.now() - 60000 });
				const reservations = await storage.getActiveReservations();

				const workerSummaries = Object.values(state.workers).map((w: WorkerState) => ({
					identity: w.identity,
					status: w.status,
					currentStep: w.currentStep,
					completedSteps: w.completedSteps,
					blockers: w.blockers,
				}));

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									coordinationStatus: state.status,
									workers: workerSummaries,
									contracts: state.contracts,
									activeReservations: reservations.length,
									recentMessages: messages.length,
								},
								null,
								2,
							),
						},
					],
					details: { workers: state.workers, contracts: state.contracts, reservations, messages },
				};
			},
		},

		{
			name: "broadcast",
			description: "Send a message to all workers",
			parameters: Type.Object({
				message: Type.String({ description: "Message content" }),
			}),
			async execute(_toolCallId, params) {
				await storage.sendMessage({
					id: randomUUID(),
					from: identity,
					to: "all",
					type: "status",
					content: params.message,
					timestamp: Date.now(),
				});

				await storage.appendTUIMessage({
					from: identity,
					content: `Broadcast: ${params.message}`,
					timestamp: Date.now(),
				});

				const state = await storage.getState();
				return {
					content: [{ type: "text", text: `Broadcast sent to ${Object.keys(state.workers).length} workers` }],
				};
			},
		},

		{
			name: "escalate_to_user",
			description: "Ask the user a question with timed auto-decision",
			parameters: Type.Object({
				question: Type.String({ description: "Question to ask" }),
				options: Type.Array(Type.String(), { description: "Available options" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 60)" })),
				defaultOption: Type.Optional(Type.Number({ description: "Index of default option (0-based)" })),
			}),
			async execute(_toolCallId, params) {
				const id = randomUUID();
				const timeout = params.timeout || 60;

				await storage.appendEscalation({
					id,
					from: identity,
					question: params.question,
					options: params.options,
					timeout,
					defaultOption: params.defaultOption,
					createdAt: Date.now(),
				});

				const deadline = Date.now() + timeout * 1000;
				while (Date.now() < deadline) {
					const response = await storage.getEscalationResponse(id);
					if (response) {
						return {
							content: [{ type: "text", text: `User chose: ${response.choice}${response.wasTimeout ? " (auto-selected)" : ""}` }],
							details: response,
						};
					}
					await sleep(1000);
				}

				const choice = params.options[params.defaultOption || 0];
				await storage.writeEscalationResponse({
					id,
					choice,
					wasTimeout: true,
					respondedAt: Date.now(),
				});

				return {
					content: [{ type: "text", text: `Timeout - using default: ${choice}` }],
					details: { id, choice, wasTimeout: true, respondedAt: Date.now() },
				};
			},
		},

		{
			name: "create_contract",
			description: "Define a contract/interface between workers",
			parameters: Type.Object({
				item: Type.String({ description: "Contract item name (e.g., 'AuthUser type')" }),
				type: Type.String({ description: "Contract type: 'type', 'function', or 'file'" }),
				provider: Type.String({ description: "Worker identity that will provide this" }),
				waiters: Type.Array(Type.String(), { description: "Worker identities waiting for this" }),
				signature: Type.Optional(Type.String({ description: "Expected signature" })),
			}),
			async execute(_toolCallId, params) {
				await storage.updateContract(params.item, () => ({
					id: randomUUID(),
					item: params.item,
					type: params.type as "type" | "function" | "file",
					provider: params.provider,
					status: "pending",
					waiters: params.waiters,
					expectedSignature: params.signature,
				}));

				await storage.appendTUIMessage({
					from: identity,
					content: `Contract created: ${params.item} (provider: ${params.provider}, waiters: ${params.waiters.join(", ")})`,
					timestamp: Date.now(),
				});

				return {
					content: [{ type: "text", text: `Contract created: ${params.item}` }],
				};
			},
		},

		{
			name: "update_progress",
			description: "Update the PROGRESS.md file in the coordination directory",
			parameters: Type.Object({
				content: Type.String({ description: "Markdown content for PROGRESS.md" }),
			}),
			async execute(_toolCallId, params) {
				await storage.updateProgress(params.content);
				return {
					content: [{ type: "text", text: "PROGRESS.md updated" }],
				};
			},
		},

		{
			name: "done",
			description: "Signal that coordination is complete. VALIDATION: Fails if no workers were spawned or if any workers are not complete.",
			parameters: Type.Object({
				summary: Type.String({ description: "Summary of what was accomplished" }),
				filesModified: Type.Optional(Type.Array(Type.String(), { description: "List of modified files" })),
				deviations: Type.Optional(Type.Array(Type.String(), { description: "Any deviations from original plan" })),
			}),
			async execute(_toolCallId, params) {
				const state = await storage.getState();
				const workers = Object.values(state.workers);

				if (workers.length === 0) {
					return {
						content: [{
							type: "text",
							text: "ERROR: Cannot complete - no workers have been spawned. You MUST call spawn_workers() first to create workers that will execute the plan.",
						}],
						isError: true,
					};
				}

				const incompleteWorkers = workers.filter((w) => w.status !== "complete");
				if (incompleteWorkers.length > 0) {
					const workerStatus = workers.map((w) => `- ${w.identity}: ${w.status}`).join("\n");
					return {
						content: [{
							type: "text",
							text: `ERROR: Cannot complete - ${incompleteWorkers.length} worker(s) not finished.\n\nWorker status:\n${workerStatus}\n\nCall check_status() to monitor progress and wait for all workers to complete.`,
						}],
						isError: true,
					};
				}

				await storage.sendMessage({
					id: randomUUID(),
					from: identity,
					to: "all",
					type: "status",
					content: "COORDINATION_COMPLETE",
					timestamp: Date.now(),
				});

				const deviations = params.deviations?.map((d) => ({ type: "deviation", description: d, timestamp: Date.now() })) || [];
				const existingDeviations = state.deviations || [];

				await storage.updateState({
					status: "complete",
					completedAt: Date.now(),
					deviations: [...existingDeviations, ...deviations],
				});

				await storage.appendTUIMessage({
					from: identity,
					content: `Coordination complete: ${params.summary}`,
					timestamp: Date.now(),
				});

				for (const worker of workers) {
					if (worker.pid) {
						try {
							process.kill(worker.pid, "SIGTERM");
						} catch {}
					}
				}

				return {
					content: [{ type: "text", text: params.summary }],
					details: { summary: params.summary, filesModified: params.filesModified, deviations: params.deviations },
				};
			},
		},
	];

	return tools;
};

export default factory;
