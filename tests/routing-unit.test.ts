#!/usr/bin/env npx jiti
/**
 * Smart Routing Unit Tests
 * 
 * Run with: npx jiti tests/routing-unit.test.ts
 * 
 * Fast tests for pure functions - no LLM calls, no coordination sessions.
 */

import {
	TestRunner,
	assert,
	assertEqual,
	assertDeepEqual,
	assertContains,
} from "./test-utils.js";

import { detectInputType, getInputTypeDescription } from "../extensions/coordination/coordinate/detection.js";
import { augmentPRD, extractClarifications } from "../extensions/coordination/coordinate/augment-prd.js";
import type { Answer } from "../extensions/coordination/coordinate/inline-questions-tui.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();
	
	// ─────────────────────────────────────────────────────────────────────────
	// Detection - Spec
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Detection - Spec");
	
	await runner.test("TASK-XX with files → spec", () => {
		const result = detectInputType(`TASK-01: Test
files: [src/test.ts]`);
		assertEqual(result.type, "spec");
	});
	
	await runner.test("TASK-XX with dependsOn → spec", () => {
		const result = detectInputType(`TASK-01: Test
dependsOn: [TASK-02]`);
		assertEqual(result.type, "spec");
	});
	
	await runner.test("TASK-XX with acceptance → spec", () => {
		const result = detectInputType(`TASK-01: Test
**Acceptance:** Tests pass`);
		assertEqual(result.type, "spec");
	});
	
	await runner.test("JSON tasks array → spec", () => {
		const result = detectInputType(`{"tasks": [{"id": "1", "files": []}]}`);
		assertEqual(result.type, "spec");
	});
	
	await runner.test("multiple spec signals → high confidence", () => {
		const result = detectInputType(`TASK-01: Test
files: [src/test.ts]
dependsOn: []
**Acceptance:** Works`);
		assertEqual(result.type, "spec");
		assertEqual(result.confidence, "high");
	});
	
	await runner.test("TASK-XX alone without structure → plan (not spec)", () => {
		// Has TASK-XX but no files/deps/acceptance
		const result = detectInputType(`TASK-01: Just a label with code keywords like function`);
		assertEqual(result.type, "plan"); // Falls to plan because of code keywords
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Detection - Plan
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Detection - Plan");
	
	await runner.test("code block → plan", () => {
		const result = detectInputType("```ts\nconst x = 1;\n```");
		assertEqual(result.type, "plan");
		assertContains(result.signals, "code blocks");
	});
	
	await runner.test("file path .ts → plan", () => {
		const result = detectInputType("Update src/components/Button.tsx");
		assertEqual(result.type, "plan");
		assertContains(result.signals, "file paths");
	});
	
	await runner.test("file path .py → plan", () => {
		const result = detectInputType("Modify app/models.py");
		assertEqual(result.type, "plan");
	});
	
	await runner.test("line reference → plan", () => {
		const result = detectInputType("Fix bug at line 42");
		assertEqual(result.type, "plan");
		assertContains(result.signals, "line references");
	});
	
	await runner.test("L42 reference → plan", () => {
		const result = detectInputType("See L42-L50 for context");
		assertEqual(result.type, "plan");
	});
	
	await runner.test(":42-50 reference → plan", () => {
		const result = detectInputType("Check file.ts:42-50");
		assertEqual(result.type, "plan");
	});
	
	await runner.test("Phase N header → plan", () => {
		const result = detectInputType("## Phase 1: Setup\n\nDo something");
		assertEqual(result.type, "plan");
		assertContains(result.signals, "phase/step structure");
	});
	
	await runner.test("(create) annotation → plan", () => {
		const result = detectInputType("Add new file (create)");
		assertEqual(result.type, "plan");
		assertContains(result.signals, "create/modify annotations");
	});
	
	await runner.test("code keywords → plan", () => {
		const result = detectInputType("Add a function that exports an interface");
		assertEqual(result.type, "plan");
		assertContains(result.signals, "code keywords");
	});
	
	await runner.test("**Files:** annotation → plan", () => {
		const result = detectInputType("**Files:** src/index.ts");
		assertEqual(result.type, "plan");
	});
	
	await runner.test("multiple plan signals → high confidence", () => {
		const result = detectInputType(`## Phase 1
\`\`\`ts
const x = 1;
\`\`\`
Modify src/index.ts (modify)`);
		assertEqual(result.type, "plan");
		assertEqual(result.confidence, "high");
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Detection - Request
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Detection - Request");
	
	await runner.test("simple prose → request", () => {
		const result = detectInputType("Add user authentication to the app");
		assertEqual(result.type, "request");
		assertContains(result.signals, "prose only");
	});
	
	await runner.test("feature description → request", () => {
		const result = detectInputType("I want to add a dashboard with charts and graphs");
		assertEqual(result.type, "request");
	});
	
	await runner.test("requirements list → request", () => {
		const result = detectInputType(`Build a login system:
- Email and password
- Remember me checkbox
- Forgot password link`);
		assertEqual(result.type, "request");
	});
	
	await runner.test("empty string → request", () => {
		const result = detectInputType("");
		assertEqual(result.type, "request");
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Detection - Signal isolation
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Detection - Signal isolation");
	
	await runner.test("spec signals don't leak to plan result", () => {
		// Has TASK-XX but not enough for spec, should fall to plan
		const result = detectInputType(`TASK-01 mentioned here
\`\`\`ts
code block
\`\`\``);
		assertEqual(result.type, "plan");
		// Should NOT include "TASK-XX identifiers" in plan signals
		assert(!result.signals.includes("TASK-XX identifiers"), 
			"Spec signals should not appear in plan result");
		assertContains(result.signals, "code blocks");
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Input type descriptions
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Input type descriptions");
	
	await runner.test("spec description", () => {
		const desc = getInputTypeDescription("spec");
		assertEqual(desc.label, "Spec");
		assert(desc.description.includes("ready to execute"), "Should mention ready to execute");
	});
	
	await runner.test("plan description", () => {
		const desc = getInputTypeDescription("plan");
		assertEqual(desc.label, "Plan");
		assert(desc.description.includes("task extraction"), "Should mention task extraction");
	});
	
	await runner.test("request description", () => {
		const desc = getInputTypeDescription("request");
		assertEqual(desc.label, "Request");
		assert(desc.description.includes("scoping"), "Should mention scoping");
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// PRD Augmentation
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("PRD Augmentation");
	
	await runner.test("empty answers returns original", () => {
		const original = "# My PRD\n\nContent here";
		const result = augmentPRD(original, []);
		assertEqual(result, original);
	});
	
	await runner.test("adds Clarifications section", () => {
		const original = "# My PRD";
		const answers: Answer[] = [{
			questionId: "q1",
			question: "Test question?",
			type: "text",
			value: "Test answer",
			wasTimeout: false,
			wasCustom: false,
		}];
		const result = augmentPRD(original, answers);
		assert(result.includes("## Clarifications"), "Should have Clarifications header");
		assert(result.includes("---"), "Should have separator");
	});
	
	await runner.test("formats select answer with label", () => {
		const answers: Answer[] = [{
			questionId: "q1",
			question: "Which option?",
			type: "select",
			value: "opt1",
			selectedOption: { label: "Option One", value: "opt1" },
			wasTimeout: false,
			wasCustom: false,
		}];
		const result = augmentPRD("# PRD", answers);
		assert(result.includes("Option One"), "Should use option label");
	});
	
	await runner.test("formats confirm answer as Yes/No", () => {
		const answers: Answer[] = [
			{
				questionId: "q1",
				question: "Enable feature?",
				type: "confirm",
				value: true,
				wasTimeout: false,
				wasCustom: false,
			},
			{
				questionId: "q2",
				question: "Skip tests?",
				type: "confirm",
				value: false,
				wasTimeout: false,
				wasCustom: false,
			},
		];
		const result = augmentPRD("# PRD", answers);
		assert(result.includes("**Enable feature?**: Yes"), "Should format true as Yes");
		assert(result.includes("**Skip tests?**: No"), "Should format false as No");
	});
	
	await runner.test("marks timeout answers", () => {
		const answers: Answer[] = [{
			questionId: "q1",
			question: "Timed out?",
			type: "text",
			value: "default",
			wasTimeout: true,
			wasCustom: false,
		}];
		const result = augmentPRD("# PRD", answers);
		assert(result.includes("*(default - no response)*"), "Should mark timeout");
	});
	
	await runner.test("marks custom answers", () => {
		const answers: Answer[] = [{
			questionId: "q1",
			question: "Custom input?",
			type: "select",
			value: "my custom value",
			wasTimeout: false,
			wasCustom: true,
		}];
		const result = augmentPRD("# PRD", answers);
		assert(result.includes("*(custom)*"), "Should mark custom");
	});
	
	await runner.test("handles empty value as (no answer)", () => {
		const answers: Answer[] = [{
			questionId: "q1",
			question: "Empty?",
			type: "text",
			value: "",
			wasTimeout: false,
			wasCustom: false,
		}];
		const result = augmentPRD("# PRD", answers);
		assert(result.includes("(no answer)"), "Should show (no answer) for empty");
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Extract Clarifications
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Extract Clarifications");
	
	await runner.test("extracts clarifications section", () => {
		const augmented = `# PRD

Some content

---

## Clarifications

- **Q1**: A1
- **Q2**: A2
`;
		const extracted = extractClarifications(augmented);
		assert(extracted !== null, "Should extract");
		assert(extracted!.includes("**Q1**: A1"), "Should include Q1");
		assert(extracted!.includes("**Q2**: A2"), "Should include Q2");
	});
	
	await runner.test("returns null if no clarifications", () => {
		const result = extractClarifications("# PRD\n\nJust content");
		assertEqual(result, null);
	});
	
	await runner.test("stops at next section", () => {
		const augmented = `## Clarifications

- **Q1**: A1

## Next Section

Other content`;
		const extracted = extractClarifications(augmented);
		assert(extracted !== null, "Should extract");
		assert(!extracted!.includes("Other content"), "Should not include next section");
	});
	
	// Print summary
	const { passed, failed } = runner.summary();
	process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
	console.error("Test suite failed:", err);
	process.exit(1);
});
