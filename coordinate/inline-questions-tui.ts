/**
 * Inline TUI for sequential clarifying questions
 * Migrated to pi-tui framework to prevent flickering
 */

import { matchesKey } from "@mariozechner/pi-tui";
import type { ClarifyingQuestion, QuestionOption } from "./question-generator.js";

export interface Answer {
	questionId: string;
	question: string;
	type: "select" | "text" | "confirm";
	value: string | boolean;
	selectedOption?: QuestionOption;
	wasTimeout: boolean;
	wasCustom: boolean; // True if user typed custom text instead of selecting option
}

export interface InlineQuestionsTUIOptions {
	questions: ClarifyingQuestion[];
	timeout?: number; // seconds per question, default 60
	signal?: AbortSignal;
}

export interface InlineQuestionsTUIResult {
	answers: Answer[];
	skippedAll: boolean;
	timeoutCount: number;
}

const DEFAULT_TIMEOUT = 60;

/**
 * InlineQuestionsComponent - TUI component for sequential questions
 */
class InlineQuestionsComponent {
	private currentIndex: number = 0;
	private selectedOption: number = 0;
	private customText: string = "";
	private isInCustomField: boolean = false;
	private timeRemaining: number;
	private readonly timeout: number; // Store original timeout for reset
	private answers: Answer[] = [];
	private timerId: ReturnType<typeof setInterval> | null = null;
	private requestRender: () => void;
	private resolved = false;

	constructor(
		private questions: ClarifyingQuestion[],
		timeout: number,
		requestRender: () => void,
		private done: (result: InlineQuestionsTUIResult) => void,
	) {
		// Guard against empty questions array
		if (questions.length === 0) {
			this.timeout = timeout;
			this.timeRemaining = timeout;
			this.requestRender = requestRender;
			// Immediately complete with empty result
			queueMicrotask(() => {
				this.done({ answers: [], skippedAll: false, timeoutCount: 0 });
			});
			return;
		}

		this.timeout = timeout;
		this.timeRemaining = timeout;
		this.requestRender = requestRender;
		
		// Initialize selectedOption based on default
		const firstQuestion = questions[0];
		if (firstQuestion.type === "select") {
			this.selectedOption = typeof firstQuestion.default === "number" ? firstQuestion.default : 0;
			const optionCount = firstQuestion.options?.length ?? 0;
			this.isInCustomField = optionCount === 0;
		} else if (firstQuestion.type === "confirm") {
			// For confirm: 0 = Yes, 1 = No
			this.selectedOption = firstQuestion.default === false ? 1 : 0;
		}
		
		this.startTimer();
	}

	private startTimer(): void {
		this.timerId = setInterval(() => {
			if (this.resolved) return;
			this.timeRemaining--;
			if (this.timeRemaining <= 0) {
				this.handleTimeout();
			}
			this.requestRender();
		}, 1000);
	}

	private handleTimeout(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.cleanup();
		
		const currentQuestion = this.questions[this.currentIndex];
		const answer = this.createDefaultAnswer(currentQuestion, true);
		this.answers.push(answer);
		
		// Use defaults for remaining questions
		for (let i = this.currentIndex + 1; i < this.questions.length; i++) {
			this.answers.push(this.createDefaultAnswer(this.questions[i], true));
		}
		
		this.done({
			answers: this.answers,
			skippedAll: false,
			timeoutCount: this.questions.length - this.currentIndex,
		});
	}

	private getCurrentQuestion(): ClarifyingQuestion {
		return this.questions[this.currentIndex];
	}

	private getOptionCount(): number {
		const q = this.getCurrentQuestion();
		return q.type === "select" ? (q.options?.length ?? 0) : 0;
	}

	handleInput(data: string): void {
		if (this.resolved) return;
		if (this.questions.length === 0) return;

		const question = this.getCurrentQuestion();
		const optionCount = this.getOptionCount();

		// Reset timer on interaction
		this.timeRemaining = this.timeout;

		// Escape - skip all remaining
		if (matchesKey(data, "escape")) {
			this.resolved = true;
			this.cleanup();
			
			// Use defaults for all remaining questions
			for (let i = this.currentIndex; i < this.questions.length; i++) {
				this.answers.push(this.createDefaultAnswer(this.questions[i], true));
			}
			
			this.done({
				answers: this.answers,
				skippedAll: true,
				timeoutCount: this.questions.length - this.currentIndex,
			});
			return;
		}

		// Enter - confirm current answer
		if (matchesKey(data, "return")) {
			this.submitCurrentAnswer();
			return;
		}

		// Handle text input for custom field or text type
		if (this.isInCustomField || question.type === "text") {
			// Backspace
			if (matchesKey(data, "backspace")) {
				this.customText = this.customText.slice(0, -1);
				this.requestRender();
				return;
			}

			// Printable characters
			if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) <= 126) {
				this.customText += data;
				this.requestRender();
				return;
			}
		}

		// Arrow key navigation
		if (matchesKey(data, "up")) {
			if (question.type === "select") {
				if (this.isInCustomField) {
					// Only exit custom field if there are options to navigate to
					if (optionCount > 0) {
						this.isInCustomField = false;
						this.selectedOption = optionCount - 1;
					}
				} else if (this.selectedOption > 0) {
					this.selectedOption--;
				}
			} else if (question.type === "confirm") {
				this.selectedOption = 0;
			}
			this.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			if (question.type === "select") {
				if (!this.isInCustomField) {
					if (this.selectedOption < optionCount - 1) {
						this.selectedOption++;
					} else {
						this.isInCustomField = true;
					}
				}
			} else if (question.type === "confirm") {
				this.selectedOption = 1;
			}
			this.requestRender();
			return;
		}

		// Tab to toggle custom field (select only)
		if (matchesKey(data, "tab") && question.type === "select") {
			this.isInCustomField = !this.isInCustomField;
			this.requestRender();
			return;
		}
	}

	private submitCurrentAnswer(): void {
		const question = this.getCurrentQuestion();
		let answer: Answer;

		if (question.type === "select") {
			if (this.isInCustomField && this.customText.trim()) {
				answer = {
					questionId: question.id,
					question: question.question,
					type: "select",
					value: this.customText.trim(),
					wasTimeout: false,
					wasCustom: true,
				};
			} else {
				const selectedOption = question.options?.[this.selectedOption];
				answer = {
					questionId: question.id,
					question: question.question,
					type: "select",
					value: selectedOption?.value ?? "",
					selectedOption,
					wasTimeout: false,
					wasCustom: false,
				};
			}
		} else if (question.type === "confirm") {
			answer = {
				questionId: question.id,
				question: question.question,
				type: "confirm",
				value: this.selectedOption === 0,
				wasTimeout: false,
				wasCustom: false,
			};
		} else {
			answer = {
				questionId: question.id,
				question: question.question,
				type: "text",
				value: this.customText.trim() || (question.default as string) || "",
				wasTimeout: false,
				wasCustom: true,
			};
		}

		this.answers.push(answer);

		// Move to next question or finish
		if (this.currentIndex < this.questions.length - 1) {
			this.currentIndex++;
			this.resetForNextQuestion();
			this.requestRender();
		} else {
			// All questions answered
			this.resolved = true;
			this.cleanup();
			this.done({
				answers: this.answers,
				skippedAll: false,
				timeoutCount: 0,
			});
		}
	}

	private resetForNextQuestion(): void {
		const question = this.getCurrentQuestion();
		this.customText = "";
		this.timeRemaining = this.timeout;
		
		if (question.type === "select") {
			this.selectedOption = typeof question.default === "number" ? question.default : 0;
			const optionCount = question.options?.length ?? 0;
			this.isInCustomField = optionCount === 0;
		} else if (question.type === "confirm") {
			// For confirm: 0 = Yes, 1 = No
			this.selectedOption = question.default === false ? 1 : 0;
			this.isInCustomField = false;
		} else {
			// Text type
			this.selectedOption = 0;
			this.isInCustomField = false;
		}
	}

	render(width: number): string[] {
		// Guard against empty questions (can happen before queueMicrotask fires done())
		if (this.questions.length === 0) {
			return ["(No questions)"];
		}

		// Ensure minimum usable width (40 chars minimum for readable UI)
		const w = Math.max(40, Math.min(70, width - 4));
		const lines: string[] = [];

		// ANSI styling helpers
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		const question = this.getCurrentQuestion();
		const optionCount = this.getOptionCount();

		// Box top with progress and timer
		const progress = `(${this.currentIndex + 1}/${this.questions.length})`;
		const title = ` Clarifying Questions ${progress} `;
		const timerStr = `[:${this.timeRemaining.toString().padStart(2, "0")}]`;
		const padLen = w - 4 - title.length - timerStr.length;
		lines.push(`╭─${title}${"─".repeat(Math.max(0, padLen))}${timerStr}─╮`);

		// Empty line
		lines.push(`│${" ".repeat(w - 2)}│`);

		// Question
		const qText = `  ${question.question}`;
		lines.push(`│${this.truncate(qText, w - 2).padEnd(w - 2)}│`);

		// Context (dimmed)
		if (question.context) {
			const truncatedContext = this.truncate(question.context, w - 8);
			const visualLength = 2 + truncatedContext.length;
			const padding = Math.max(0, w - 2 - visualLength);
			lines.push(`│  ${dim(truncatedContext)}${" ".repeat(padding)}│`);
		}

		lines.push(`│${" ".repeat(w - 2)}│`);

		// Render based on question type
		if (question.type === "select" && question.options) {
			// Options
			for (let i = 0; i < question.options.length; i++) {
				const opt = question.options[i];
				const isSelected = !this.isInCustomField && i === this.selectedOption;
				const prefix = isSelected ? "  › " : "    ";
				const optText = `${prefix}${isSelected ? bold(opt.label) : opt.label}`;
				lines.push(`│${this.truncate(optText, w - 2).padEnd(w - 2)}│`);
			}

			// Custom text field
			lines.push(`│${" ".repeat(w - 2)}│`);
			const customPrefix = this.isInCustomField ? "  › " : "    ";
			const customLabel = `${customPrefix}Other: `;
			const inputWidth = Math.max(1, w - 4 - customLabel.length - 2);
			const displayText = this.customText.slice(-inputWidth);
			const cursor = this.isInCustomField ? "▌" : "";
			const fieldContent = `${customLabel}${displayText}${cursor}`;
			lines.push(`│${fieldContent.padEnd(w - 2)}│`);

		} else if (question.type === "confirm") {
			const yesSelected = this.selectedOption === 0;
			const yesPrefix = yesSelected ? "› " : "  ";
			const noPrefix = !yesSelected ? "› " : "  ";
			const yesText = yesSelected ? bold("Yes") : "Yes";
			const noText = !yesSelected ? bold("No") : "No";
			// Visual: "│" (1) + "    " (4) + yesPrefix (2) + "Yes" (3) + 10 spaces + noPrefix (2) + "No" (2) + padding + "│" (1)
			// Content = 4 + 2 + 3 + 10 + 2 + 2 + padding = 23 + padding, needs to equal w - 2, so padding = w - 25
			lines.push(`│    ${yesPrefix}${yesText}${" ".repeat(10)}${noPrefix}${noText}${" ".repeat(Math.max(0, w - 25))}│`);

		} else {
			// Text type - just show input field
			// Content: "    " (4) + displayText + cursor (1) + padding = w - 2
			// So: 4 + displayText.length + 1 + padding = w - 2, padding = w - 7 - displayText.length
			const inputWidth = Math.max(1, w - 7);
			const displayText = this.customText.slice(-inputWidth);
			const cursor = "▌";
			lines.push(`│    ${displayText}${cursor}${" ".repeat(Math.max(0, inputWidth - displayText.length))}│`);
		}

		// Separator
		lines.push(`│${" ".repeat(w - 2)}│`);
		lines.push(`│${"─".repeat(w - 2)}│`);

		// Previous answers (show last 3)
		const recentAnswers = this.answers.slice(-3);
		if (recentAnswers.length > 0) {
			for (const ans of recentAnswers) {
				const checkmark = ans.wasTimeout ? "○" : "✓";
				const valueStr = this.formatAnswerValue(ans);
				const ansLine = `  ${checkmark} ${this.truncate(ans.question, 25)}: ${this.truncate(valueStr, w - 35)}`;
				lines.push(`│${ansLine.padEnd(w - 2)}│`);
			}
		}

		// Box bottom with controls
		lines.push(`│${" ".repeat(w - 2)}│`);
		const controls = " [↑↓] select  [Enter] confirm  [Esc] skip all ";
		const bottomPad = w - 2 - controls.length;
		lines.push(`╰${"─".repeat(Math.max(0, bottomPad))}${controls}╯`);

		return lines;
	}

	private createDefaultAnswer(question: ClarifyingQuestion, wasTimeout: boolean): Answer {
		if (question.type === "select") {
			const defaultIdx = typeof question.default === "number" ? question.default : 0;
			const selectedOption = question.options?.[defaultIdx];
			return {
				questionId: question.id,
				question: question.question,
				type: "select",
				value: selectedOption?.value ?? "",
				selectedOption,
				wasTimeout,
				wasCustom: false,
			};
		} else if (question.type === "confirm") {
			return {
				questionId: question.id,
				question: question.question,
				type: "confirm",
				value: question.default !== false,
				wasTimeout,
				wasCustom: false,
			};
		} else {
			return {
				questionId: question.id,
				question: question.question,
				type: "text",
				value: (question.default as string) || "",
				wasTimeout,
				wasCustom: false,
			};
		}
	}

	private formatAnswerValue(answer: Answer): string {
		if (answer.type === "confirm") {
			return answer.value ? "Yes" : "No";
		}
		if (answer.type === "select" && answer.selectedOption) {
			return answer.selectedOption.label;
		}
		return String(answer.value);
	}

	private sanitize(text: string): string {
		return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
	}

	private truncate(text: string, maxLen: number): string {
		const clean = this.sanitize(text);
		if (clean.length <= maxLen) return clean;
		if (maxLen <= 3) return clean.slice(0, maxLen);
		return clean.slice(0, maxLen - 3) + "...";
	}

	private cleanup(): void {
		if (this.timerId) {
			clearInterval(this.timerId);
			this.timerId = null;
		}
	}

	invalidate(): void {
		// No cached state to clear
	}

	dispose(): void {
		this.cleanup();
	}
}

/**
 * Legacy function wrapper - will be replaced with ctx.ui.custom() in TASK-04
 * For now, kept for backward compatibility during migration
 */
export async function runInlineQuestionsTUI(
	options: InlineQuestionsTUIOptions,
): Promise<InlineQuestionsTUIResult> {
	const { questions, timeout = DEFAULT_TIMEOUT, signal } = options;

	if (questions.length === 0) {
		return { answers: [], skippedAll: false, timeoutCount: 0 };
	}

	// Check if already aborted
	if (signal?.aborted) {
		const answers = questions.map((q) => createDefaultAnswerLegacy(q, true));
		return {
			answers,
			skippedAll: true,
			timeoutCount: questions.length,
		};
	}

	// This is a temporary stub that will be replaced when TASK-04 integrates ctx.ui.custom()
	// For now, return default answers in non-TTY environments
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		const answers = questions.map((q) => createDefaultAnswerLegacy(q, false));
		return {
			answers,
			skippedAll: false,
			timeoutCount: 0,
		};
	}

	// This will be replaced by ctx.ui.custom() call in interview.ts
	throw new Error("runInlineQuestionsTUI: Must be called through ctx.ui.custom() - see TASK-04");
}

function createDefaultAnswerLegacy(question: ClarifyingQuestion, wasTimeout: boolean): Answer {
	if (question.type === "select") {
		const defaultIdx = typeof question.default === "number" ? question.default : 0;
		const selectedOption = question.options?.[defaultIdx];
		return {
			questionId: question.id,
			question: question.question,
			type: "select",
			value: selectedOption?.value ?? "",
			selectedOption,
			wasTimeout,
			wasCustom: false,
		};
	} else if (question.type === "confirm") {
		return {
			questionId: question.id,
			question: question.question,
			type: "confirm",
			value: question.default !== false,
			wasTimeout,
			wasCustom: false,
		};
	} else {
		return {
			questionId: question.id,
			question: question.question,
			type: "text",
			value: (question.default as string) || "",
			wasTimeout,
			wasCustom: false,
		};
	}
}

// Export the component class for use in interview.ts
export { InlineQuestionsComponent };
