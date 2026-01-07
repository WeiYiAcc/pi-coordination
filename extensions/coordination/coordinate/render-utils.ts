/**
 * Shared rendering utilities for coordination displays (sync and async dashboards)
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { PipelinePhase, PhaseResult, WorkerStateFile, Task, CoordinationEvent } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

export const ICONS = {
	complete: "✓",
	running: "●",
	pending: "○",
	failed: "✗",
	waiting: "◐",
	spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

export function getSpinnerFrame(): string {
	const idx = Math.floor(Date.now() / 80) % ICONS.spinner.length;
	return ICONS.spinner[idx];
}

export function getStatusIcon(status: string): string {
	switch (status) {
		case "complete": return ICONS.complete;
		case "working": return ICONS.running;
		case "running": return ICONS.running;
		case "waiting": return ICONS.waiting;
		case "blocked": return ICONS.waiting;
		case "failed": return ICONS.failed;
		case "pending": return ICONS.pending;
		default: return ICONS.pending;
	}
}

export function getStatusColor(status: string): "success" | "warning" | "error" | "muted" | "dim" {
	switch (status) {
		case "complete": return "success";
		case "working": return "warning";
		case "running": return "warning";
		case "waiting": return "muted";
		case "blocked": return "error";
		case "failed": return "error";
		case "pending": return "dim";
		default: return "dim";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

export function formatContextUsage(tokens: number, maxTokens = 200000): string {
	if (!tokens || tokens <= 0) return "";
	const pct = Math.min(100, Math.round((tokens / maxTokens) * 100));
	const k = Math.round(tokens / 1000);
	return `${pct}%/${k}k`;
}

export function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 3) + "...";
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase helpers
// ─────────────────────────────────────────────────────────────────────────────

const PHASE_ORDER: PipelinePhase[] = ["scout", "planner", "coordinator", "workers", "review", "fixes", "complete", "failed"];

export function isPhasePast(phase: PipelinePhase, currentPhase: PipelinePhase): boolean {
	const phaseIdx = PHASE_ORDER.indexOf(phase);
	const currentIdx = PHASE_ORDER.indexOf(currentPhase);
	return phaseIdx < currentIdx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineDisplayState {
	currentPhase: PipelinePhase;
	phases: Record<PipelinePhase, PhaseResult | undefined>;
	cost: number;
	costByPhase?: Record<string, number>;
	elapsed: number; // ms
}

export function renderPipelineRow(
	state: PipelineDisplayState,
	theme: Theme,
	width: number,
): string {
	const phases: PipelinePhase[] = ["scout", "planner", "workers", "review", "complete"];
	const parts: string[] = [];

	for (const phase of phases) {
		const result = state.phases[phase];
		const status = result?.status;
		const isCurrent = phase === state.currentPhase || 
			(phase === "workers" && (state.currentPhase === "coordinator" || state.currentPhase === "fixes"));
		const isPast = isPhasePast(phase, state.currentPhase);
		const isFailed = state.currentPhase === "failed";

		let icon: string;
		let name: string;

		if (phase === state.currentPhase && isFailed) {
			icon = theme.fg("error", ICONS.failed);
			name = theme.fg("error", "failed");
		} else if (status === "complete" || (isPast && status !== "failed")) {
			icon = theme.fg("success", ICONS.complete);
			name = theme.fg("dim", phase);
		} else if (status === "running" || isCurrent) {
			icon = theme.fg("warning", getSpinnerFrame());
			name = theme.fg("accent", phase);
		} else {
			icon = theme.fg("dim", ICONS.pending);
			name = theme.fg("dim", phase);
		}

		parts.push(`${icon} ${name}`);
	}

	const pipeline = parts.join(theme.fg("dim", " → "));
	const cost = theme.fg("muted", formatCost(state.cost));
	const time = theme.fg("dim", formatDuration(state.elapsed));
	const right = `${cost}  ${time}`;

	const leftWidth = visibleWidth(pipeline);
	const rightWidth = visibleWidth(right);
	const gap = Math.max(1, width - leftWidth - rightWidth);

	return pipeline + " ".repeat(gap) + right;
}

export function renderCostBreakdown(
	costByPhase: Record<string, number> | undefined,
	theme: Theme,
): string | null {
	if (!costByPhase) return null;
	
	const abbrevs: Record<string, string> = { 
		scout: "scout", 
		planner: "planner", 
		coordinator: "coord", 
		workers: "workers", 
		review: "review", 
		fixes: "fixes" 
	};
	
	const parts: string[] = [];
	for (const [phase, amount] of Object.entries(costByPhase)) {
		if (amount > 0) {
			const name = abbrevs[phase] || phase;
			parts.push(`${theme.fg("dim", name + ":")} ${formatCost(amount)}`);
		}
	}
	
	if (parts.length === 0) return null;
	return parts.join(theme.fg("dim", "  "));
}

// ─────────────────────────────────────────────────────────────────────────────
// Workers rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerDisplayState {
	id: string;
	shortId: string;
	status: string;
	taskId?: string;
	tokens?: number;
	contextPct?: number;
	cost: number;
	durationMs: number;
	currentFile?: string | null;
	currentTool?: string | null;
}

export function workerStateToDisplay(w: WorkerStateFile): WorkerDisplayState {
	const contextTokens = w.tokens || 0;
	return {
		id: w.id,
		shortId: w.shortId || w.id.slice(0, 4),
		status: w.status,
		taskId: w.currentStep ? `TASK-${String(w.currentStep).padStart(2, "0")}` : undefined,
		tokens: contextTokens,
		contextPct: contextTokens > 0 ? Math.min(100, Math.round((contextTokens / 200000) * 100)) : undefined,
		cost: w.usage?.cost || 0,
		durationMs: w.startedAt ? Date.now() - w.startedAt : 0,
		currentFile: w.currentFile,
		currentTool: w.currentTool,
	};
}

export function renderWorkersCompact(
	workers: WorkerDisplayState[],
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];

	if (workers.length === 0) {
		return [theme.fg("dim", "No workers")];
	}

	// Summary line
	const working = workers.filter(w => w.status === "working").length;
	const complete = workers.filter(w => w.status === "complete").length;
	const failed = workers.filter(w => w.status === "failed").length;
	const totalCost = workers.reduce((sum, w) => sum + w.cost, 0);

	const summary = [
		theme.fg("warning", `${working} active`),
		theme.fg("success", `${complete} done`),
		...(failed > 0 ? [theme.fg("error", `${failed} failed`)] : []),
		theme.fg("muted", formatCost(totalCost)),
	].join(theme.fg("dim", " │ "));

	lines.push(`${theme.fg("muted", "Workers:")} ${summary}`);

	// Active workers detail
	const active = workers.filter(w => w.status === "working" || w.status === "waiting");
	for (const w of active.slice(0, 4)) {
		const icon = theme.fg(getStatusColor(w.status), getSpinnerFrame());
		const id = theme.fg("accent", w.shortId);
		const time = theme.fg("dim", formatDuration(w.durationMs));
		const cost = theme.fg("muted", formatCost(w.cost));
		const ctx = w.contextPct ? theme.fg("dim", `${w.contextPct}%`) : "";
		
		// Show current activity: tool + file
		let activity = "";
		if (w.currentTool) {
			const file = w.currentFile ? ` ${truncateText(w.currentFile.split("/").pop() || "", 20)}` : "";
			activity = theme.fg("dim", `${w.currentTool}${file}`);
		}
		
		lines.push(`  ${icon} ${id} ${time} ${cost} ${ctx} ${activity}`);
	}

	if (active.length > 4) {
		lines.push(theme.fg("dim", `  ... +${active.length - 4} more`));
	}

	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskDisplayState {
	id: string;
	status: string;
	description: string;
}

export function renderTasksCompact(
	tasks: TaskDisplayState[],
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];

	if (tasks.length === 0) {
		return [];
	}

	const claimed = tasks.filter(t => t.status === "claimed");
	const pending = tasks.filter(t => t.status === "pending");
	const complete = tasks.filter(t => t.status === "complete");
	const blocked = tasks.filter(t => t.status === "blocked");

	const summary = [
		...(claimed.length > 0 ? [theme.fg("warning", `${claimed.length} active`)] : []),
		...(pending.length > 0 ? [theme.fg("dim", `${pending.length} pending`)] : []),
		...(complete.length > 0 ? [theme.fg("success", `${complete.length} done`)] : []),
		...(blocked.length > 0 ? [theme.fg("muted", `${blocked.length} blocked`)] : []),
	].join(theme.fg("dim", ", "));

	lines.push(`${theme.fg("muted", "Tasks:")} ${theme.fg("success", String(complete.length))}${theme.fg("dim", "/")}${theme.fg("muted", String(tasks.length))} ${theme.fg("dim", "│")} ${summary}`);

	// Show active tasks
	for (const task of claimed.slice(0, 2)) {
		const icon = theme.fg("warning", ICONS.running);
		const id = theme.fg("accent", task.id);
		const desc = theme.fg("muted", truncateText(task.description, width - 25));
		lines.push(`  ${icon} ${id} ${desc}`);
	}

	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Events rendering
// ─────────────────────────────────────────────────────────────────────────────

export function renderEventLine(
	ev: CoordinationEvent,
	firstTs: number,
	theme: Theme,
	expanded: boolean = false,
): string {
	const elapsed = `+${((ev.timestamp - firstTs) / 1000).toFixed(1)}s`;
	const workerId = (ev as { workerId?: string }).workerId;
	const contextTokens = (ev as { contextTokens?: number }).contextTokens;

	// Determine source label
	let shortId: string;
	const phase = (ev as { phase?: string }).phase;
	if (ev.type === "cost_milestone" || ev.type === "cost_limit_reached") {
		shortId = "$";
	} else if (["phase_complete", "phase_completed", "phase_started", "session_started", "session_completed", "checkpoint_saved", "cost_updated", "review_started", "review_complete", "review_completed", "fix_started", "fix_completed", "fixes_started", "fixes_complete"].includes(ev.type)) {
		shortId = "sys";
	} else if (["coordinator", "planner_review_started", "planner_review_complete"].includes(ev.type)) {
		shortId = "co";
	} else if (ev.type === "activity") {
		shortId = phase || "sys";
	} else if (workerId === "scout") {
		shortId = "scout";
	} else if (workerId === "planner") {
		shortId = "plan";
	} else if (workerId === "coordinator") {
		shortId = "coord";
	} else if (workerId === "review") {
		shortId = "review";
	} else {
		shortId = workerId?.slice(0, 4) || "??";
	}

	// Context usage label
	const ctxLabel = contextTokens && contextTokens > 0 
		? ` ${formatContextUsage(contextTokens)}` 
		: "";

	let line = `${theme.fg("muted", elapsed.padEnd(8))}`;
	line += `${theme.fg("accent", `[${shortId}${ctxLabel}]`)} `;

	// Event-specific content
	switch (ev.type) {
		case "tool_call": {
			const file = ev.file || "";
			const maxLen = expanded ? 200 : 60;
			const displayFile = file.length > maxLen ? "..." + file.slice(-maxLen) : file;
			line += theme.fg("dim", `${ev.tool}${displayFile ? ` ${displayFile}` : ""}`);
			break;
		}
		case "tool_result":
			line += theme.fg("dim", `${ev.tool} ${ev.success ? "ok" : "error"}`);
			break;
		case "waiting":
			line += theme.fg("warning", `waiting for ${ev.item}`);
			break;
		case "contract_received": {
			const fromId = (ev as { from: string }).from.split("-").pop() || "??";
			line += theme.fg("success", `received contract from ${fromId}`);
			break;
		}
		case "worker_spawning": {
			const config = (ev as { config?: { logicalName?: string; handshakeSpec?: string } }).config;
			const name = config?.logicalName || workerId || "?";
			const spec = config?.handshakeSpec?.slice(0, 40) || "";
			line += theme.fg("warning", `spawning ${name}`) + (spec ? theme.fg("dim", ` ${spec}...`) : "");
			break;
		}
		case "worker_started":
			line += theme.fg("success", "started");
			break;
		case "worker_completed":
			line += theme.fg("success", "done");
			break;
		case "worker_failed":
			line += theme.fg("error", `FAILED: ${ev.error}`);
			break;
		case "cost_milestone": {
			const milestone = ev as { totals: Record<string, number>; aggregate: number };
			const totals = Object.entries(milestone.totals)
				.map(([id, cost]) => `${id.slice(0, 4)}: ${formatCost(cost)}`)
				.join(" │ ");
			line += theme.fg("muted", `${totals} │ total: ${formatCost(milestone.aggregate)}`);
			break;
		}
		case "coordinator": {
			const msg = (ev as { message: string }).message;
			line += theme.fg("dim", msg.slice(0, 50));
			break;
		}
		case "phase_complete":
			line += theme.fg("success", `${ev.phase} done (${formatCost(ev.cost)})`);
			break;
		case "phase_started":
			line += theme.fg("muted", `${(ev as { phase?: string }).phase || "?"} started`);
			break;
		case "phase_completed":
			line += theme.fg("success", `${(ev as { phase?: string }).phase || "?"} done`);
			break;
		case "cost_updated":
			line += theme.fg("dim", `cost: ${formatCost((ev as { total?: number }).total || 0)}`);
			break;
		case "checkpoint_saved":
			line += theme.fg("dim", "checkpoint");
			break;
		case "planner_review_started":
			line += theme.fg("muted", "reviewing tasks");
			break;
		case "planner_review_complete":
			line += theme.fg("success", "tasks approved");
			break;
		case "session_started":
			line += theme.fg("muted", "session started");
			break;
		case "session_completed":
			line += theme.fg("success", "session completed");
			break;
		case "cost_limit_reached":
			line += theme.fg("warning", `limit reached: ${formatCost((ev as { total: number }).total)}`);
			break;
		case "review_started":
			line += theme.fg("muted", "review started");
			break;
		case "review_complete":
		case "review_completed":
			line += theme.fg("success", "review complete");
			break;
		case "fix_started":
			line += theme.fg("muted", "fix started");
			break;
		case "fix_completed":
			line += theme.fg("success", "fix completed");
			break;
		case "fixes_started":
			line += theme.fg("muted", "fixes started");
			break;
		case "fixes_complete":
			line += theme.fg("success", "fixes complete");
			break;
		case "activity": {
			const actPhase = (ev as { phase?: string }).phase || "?";
			const actTokens = (ev as { contextTokens?: number }).contextTokens;
			line += theme.fg("dim", `${actPhase} working${actTokens ? ` (${Math.round(actTokens / 1000)}k tokens)` : ""}`);
			break;
		}
		default:
			line += theme.fg("dim", ev.type);
	}

	return line;
}

// ─────────────────────────────────────────────────────────────────────────────
// Box drawing
// ─────────────────────────────────────────────────────────────────────────────

export function drawBoxTop(width: number, title: string, theme: Theme): string {
	const dim = (s: string) => theme.fg("borderMuted", s);
	const titlePart = title ? ` ${title} ` : "";
	const lineLen = width - visibleWidth(titlePart) - 3;
	return dim("╭─") + theme.fg("accent", titlePart) + dim("─".repeat(Math.max(0, lineLen))) + dim("╮");
}

export function drawBoxBottom(width: number, theme: Theme): string {
	const dim = (s: string) => theme.fg("borderMuted", s);
	return dim("╰") + dim("─".repeat(width - 2)) + dim("╯");
}

export function drawBoxLine(content: string, width: number, theme: Theme): string {
	const contentWidth = visibleWidth(content);
	const padding = Math.max(0, width - contentWidth - 2);
	return theme.fg("borderMuted", "│") + content + " ".repeat(padding) + theme.fg("borderMuted", "│");
}
