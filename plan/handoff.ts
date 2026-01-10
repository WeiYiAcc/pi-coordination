/**
 * Handoff Phase - Review spec and decide next action.
 *
 * Shows the spec summary and offers three choices:
 * 1. Execute now - Hand off to coordinate tool
 * 2. Refine further - Loop back to interview with existing spec
 * 3. Save and exit - Just save the spec file
 *
 * Timeout (60s) defaults to "Save and exit" to prevent accidental execution.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import type { Spec, Priority } from "../coordinate/spec-parser.js";
import { serializeSpec } from "../coordinate/spec-parser.js";

/**
 * Handoff choice options.
 */
export type HandoffChoice = "execute" | "refine" | "exit";

/**
 * Handoff configuration.
 */
export interface HandoffConfig {
	/** Timeout in seconds (default: 60) */
	timeout?: number;
	/** Abort signal */
	signal?: AbortSignal;
	/** Whether to auto-save (default: true) */
	autoSave?: boolean;
}

/**
 * Result from handoff phase.
 */
export interface HandoffResult {
	/** User's choice */
	choice: HandoffChoice;
	/** Path where spec was saved */
	specPath: string;
	/** Whether choice was made via timeout */
	wasTimeout: boolean;
}

/**
 * Format a spec summary for display.
 */
export function formatSpecSummary(spec: Spec, specPath: string): string {
	const lines: string[] = [];

	const taskCount = spec.tasks.length;
	const fileCount = new Set(spec.tasks.flatMap((t) => t.files.map((f) => f.path))).size;
	const priorityCounts: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
	for (const task of spec.tasks) {
		priorityCounts[task.priority]++;
	}

	// Header
	lines.push("╭─────────────────────────────────────────────────────────────────╮");
	lines.push("│                      Spec Ready for Review                      │");
	lines.push("╰─────────────────────────────────────────────────────────────────╯");
	lines.push("");

	// Title
	lines.push(`  📋 ${spec.title || "(Untitled)"}`);
	lines.push("");

	// Stats
	lines.push(`  📁 Saved to: ${specPath}`);
	lines.push("");
	lines.push(`  📊 Summary:`);
	lines.push(`     • Tasks: ${taskCount}`);
	lines.push(`     • Files: ${fileCount}`);

	const priorityStr = Object.entries(priorityCounts)
		.filter(([_, count]) => count > 0)
		.map(([p, count]) => `${p}: ${count}`)
		.join(" | ");
	lines.push(`     • Priority: ${priorityStr}`);
	lines.push("");

	// Task list
	lines.push(`  📝 Tasks:`);
	for (const task of spec.tasks.slice(0, 8)) {
		const deps = task.dependsOn.length > 0 ? ` → ${task.dependsOn.join(", ")}` : "";
		const status = task.dependsOn.length === 0 ? "🟢" : "⏳";
		lines.push(`     ${status} ${task.id}: ${task.title}${deps}`);
	}
	if (spec.tasks.length > 8) {
		lines.push(`     ... and ${spec.tasks.length - 8} more`);
	}
	lines.push("");

	return lines.join("\n");
}

/**
 * Run handoff phase - show summary and get user choice.
 */
export async function runHandoff(
	spec: Spec,
	specPath: string,
	config: HandoffConfig = {},
	ctx?: Pick<ExtensionContext, "hasUI" | "ui">,
): Promise<HandoffResult> {
	const { timeout = 60, signal, autoSave = true } = config;

	// Save spec first if autoSave enabled
	if (autoSave) {
		const specContent = serializeSpec(spec);
		await fs.mkdir(path.dirname(specPath), { recursive: true });
		await fs.writeFile(specPath, specContent, "utf-8");
	}

	// Check if already aborted
	if (signal?.aborted) {
		return {
			choice: "exit",
			specPath,
			wasTimeout: false,
		};
	}

	// Show summary (always, regardless of TTY status)
	console.log(formatSpecSummary(spec, specPath));

	// Non-TTY or no UI context: save and exit (don't auto-execute)
	if (!process.stdin.isTTY || !process.stdout.isTTY || !ctx?.hasUI) {
		const reason = !ctx?.hasUI 
			? "(No UI context - saving and exiting)"
			: "(Non-TTY environment - saving and exiting)";
		console.log(reason);
		return {
			choice: "exit",
			specPath,
			wasTimeout: false,
		};
	}

	// Use pi-tui overlay for selection
	const result = await ctx.ui.custom<SelectResult<HandoffChoice>>(
		(tui, _theme, _kb, done) => {
			return new HandoffSelectComponent(
				[
					{ label: "Execute now", value: "execute", icon: "🚀" },
					{ label: "Refine further", value: "refine", icon: "✏️" },
					{ label: "Save and exit", value: "exit", icon: "💾" },
				],
				timeout,
				"exit", // Don't auto-execute
				() => tui.requestRender(),
				done,
			);
		},
		{ overlay: true },
	);

	return {
		choice: result.value,
		specPath,
		wasTimeout: result.wasTimeout,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// HandoffSelectComponent - TUI Component for Handoff Choice Selection
// ─────────────────────────────────────────────────────────────────────────────

interface SelectOption<T> {
	label: string;
	value: T;
	icon?: string;
}

interface SelectResult<T> {
	value: T;
	wasTimeout: boolean;
}

/**
 * HandoffSelectComponent - TUI component for handoff choice selection
 */
class HandoffSelectComponent {
	private selectedIndex: number;
	private timeRemaining: number;
	private initialTimeout: number;
	private timerId: ReturnType<typeof setInterval> | null = null;
	private requestRender: () => void;
	private resolved = false;

	constructor(
		private options: SelectOption<HandoffChoice>[],
		timeout: number,
		defaultOnTimeout: HandoffChoice,
		requestRender: () => void,
		private done: (result: SelectResult<HandoffChoice>) => void,
	) {
		this.initialTimeout = timeout;
		this.timeRemaining = timeout;
		this.selectedIndex = options.findIndex((o) => o.value === defaultOnTimeout);
		if (this.selectedIndex < 0) this.selectedIndex = 0;
		this.requestRender = requestRender;
		this.startTimer();
	}

	private startTimer(): void {
		this.timerId = setInterval(() => {
			if (this.resolved) return;
			this.timeRemaining--;
			if (this.timeRemaining <= 0) {
				this.resolved = true;
				this.cleanup();
				this.done({ value: this.options[this.selectedIndex].value, wasTimeout: true });
			}
			this.requestRender();
		}, 1000);
	}

	handleInput(data: string): void {
		if (this.resolved) return;

		// Reset timer on interaction
		this.timeRemaining = this.initialTimeout;

		// Escape - select exit option
		if (matchesKey(data, "escape")) {
			this.resolved = true;
			this.cleanup();
			const exitOption = this.options.find((o) => o.value === "exit");
			this.done({ value: exitOption?.value ?? "exit", wasTimeout: false });
			return;
		}

		// Enter - confirm selection
		if (matchesKey(data, "return")) {
			this.resolved = true;
			this.cleanup();
			this.done({ value: this.options[this.selectedIndex].value, wasTimeout: false });
			return;
		}

		// Arrow keys
		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}

		// Number keys for quick selection
		const num = Number.parseInt(data, 10);
		if (num >= 1 && num <= this.options.length) {
			this.selectedIndex = num - 1;
			this.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		lines.push("");
		lines.push(`  What would you like to do? [${this.timeRemaining}s]`);
		lines.push("");

		for (let i = 0; i < this.options.length; i++) {
			const opt = this.options[i];
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? "  › " : "    ";
			const icon = opt.icon ? `${opt.icon} ` : "";
			const label = isSelected ? bold(opt.label) : opt.label;
			lines.push(`${prefix}${icon}${label}`);
		}

		lines.push("");
		lines.push(dim("  [↑↓] select  [Enter] confirm  [Esc] save & exit"));
		lines.push("");

		return lines;
	}

	invalidate(): void {
		// No cached state to clear
	}

	private cleanup(): void {
		if (this.timerId) {
			clearInterval(this.timerId);
			this.timerId = null;
		}
	}

	dispose(): void {
		this.cleanup();
	}
}

// Export the component class for use in runHandoff
export { HandoffSelectComponent, type SelectOption, type SelectResult };

/**
 * Generate default spec filename from title.
 */
export function generateSpecFilename(title: string): string {
	const safeName = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);

	return `${safeName || "spec"}.md`;
}

/**
 * Resolve spec path - use provided path or generate from title.
 */
export function resolveSpecPath(cwd: string, output: string | undefined, title: string): string {
	if (output) {
		return path.isAbsolute(output) ? output : path.join(cwd, output);
	}

	const filename = generateSpecFilename(title);
	return path.join(cwd, "specs", filename);
}
