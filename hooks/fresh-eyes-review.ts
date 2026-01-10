/**
 * Fresh Eyes Review Hook for Reviewer Agent
 *
 * After the reviewer outputs its initial assessment, this hook triggers
 * a self-review pass asking the reviewer to re-check with "fresh eyes."
 * 
 * The loop continues until:
 * - Reviewer says "No additional issues found" (or similar)
 * - Max review cycles reached
 *
 * Configuration via environment variables:
 *   PI_FRESH_EYES_ENABLED=true|false (default: true)
 *   PI_FRESH_EYES_MAX_CYCLES=N (default: 2)
 *
 * Usage in agent frontmatter:
 * ```yaml
 * ---
 * name: coordination/reviewer
 * extensions: ../hooks/fresh-eyes-review.ts
 * ---
 * ```
 *
 * @module
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_CYCLES = (() => {
	const val = parseInt(process.env.PI_FRESH_EYES_MAX_CYCLES || "2", 10);
	return Number.isNaN(val) ? 2 : val;
})();

const ENABLED = process.env.PI_FRESH_EYES_ENABLED !== "false";

const FRESH_EYES_PROMPT = `## Fresh Eyes Review

Now review your assessment with fresh eyes. You may have missed something.

1. **Re-read the modified files** using the read tool (not just the diff)
2. **Check for issues you might have missed:**
   - Integration issues between components
   - Edge cases or error conditions
   - Missing validation or error handling
   - Inconsistencies with existing patterns
   - Subtle logic errors

3. **If you find additional issues**: Add them to your issues list and output updated JSON
4. **If no additional issues**: Output JSON with the same issues (or fewer if some were false positives)
   and include in your summary: "No additional issues found on fresh eyes review."

Be thorough - this is your last chance to catch bugs before they go to fix workers.`;

/**
 * Patterns that indicate the reviewer found no additional issues
 */
const NO_ISSUES_PATTERNS = [
	/no additional issues/i,
	/fresh eyes review.{0,30}complete/i,
	/nothing.{0,20}missed/i,
	/review.{0,20}confirms?/i,
	/same issues/i,
];

function containsNoAdditionalIssues(text: string): boolean {
	return NO_ISSUES_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Extract text content from agent messages.
 */
function extractTextFromMessages(messages: unknown[]): string {
	const textParts: string[] = [];

	for (const msg of messages) {
		const m = msg as { role?: string; content?: unknown };
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content) {
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && b.text) {
					textParts.push(b.text);
				}
			}
		}
	}

	return textParts.join("\n");
}

export default function freshEyesReview(pi: ExtensionAPI): void {
	if (!ENABLED) return;

	let cycleCount = 0;
	let hasTriggeredFreshEyes = false;

	pi.on("agent_end", async (event) => {
		// Only run for reviewer agent
		const agentIdentity = process.env.PI_AGENT_IDENTITY;
		if (agentIdentity && !agentIdentity.includes("reviewer")) {
			return; // Not a reviewer agent, skip
		}

		// Only trigger once per session, after the initial review
		if (cycleCount >= MAX_CYCLES) {
			return;
		}

		const text = extractTextFromMessages(event.messages);

		// Check if this is a fresh eyes response indicating no more issues
		if (hasTriggeredFreshEyes && containsNoAdditionalIssues(text)) {
			// Review complete, allow normal exit
			return;
		}

		// Trigger fresh eyes review
		cycleCount++;
		hasTriggeredFreshEyes = true;

		pi.sendMessage(
			{
				customType: "fresh-eyes-review",
				content: FRESH_EYES_PROMPT,
				display: false,
			},
			{ triggerTurn: true }
		);
	});

	// Reset at the start of each agent run
	pi.on("agent_start", () => {
		cycleCount = 0;
		hasTriggeredFreshEyes = false;
	});
}
