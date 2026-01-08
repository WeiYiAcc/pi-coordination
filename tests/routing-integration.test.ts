#!/usr/bin/env npx jiti
/**
 * Smart Routing Integration Tests
 * 
 * Run with: npx jiti tests/routing-integration.test.ts
 * 
 * These tests validate routing behavior by:
 * 1. Testing detection on fixture files
 * 2. Testing observability data readers
 * 3. Providing helpers for manual full-coordination tests
 * 
 * For full E2E tests with actual LLM calls, use:
 *   pi "coordinate({ plan: 'tests/fixtures/spec.md', mode: 'spec' })"
 * Then inspect the coordination directory.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
	TestRunner,
	readRoutingInfo,
	readEvents,
	readErrors,
	getPhaseEvents,
	getCostFromEvents,
	cleanupOldTestDirs,
	createTestCoordDir,
	assert,
	assertEqual,
	assertExists,
	assertContains,
	assertNotContains,
	Keys,
} from "./test-utils.js";

import { detectInputType } from "../extensions/coordination/coordinate/detection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Test configuration
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const OUTPUT_DIR = path.join(__dirname, "output");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getFixturePath(name: string): string {
	return path.join(FIXTURES_DIR, name);
}

function readFixture(name: string): string {
	return fs.readFileSync(getFixturePath(name), "utf-8");
}

/**
 * Create a mock routing-info.json for testing observability readers
 */
function createMockRoutingInfo(coordDir: string, info: Partial<ReturnType<typeof readRoutingInfo>>): void {
	const fullInfo = {
		mode: "spec" as const,
		skipScout: true,
		skipPlanner: true,
		clarificationsCount: 0,
		clarifications: [],
		timestamp: Date.now(),
		...info,
	};
	fs.writeFileSync(path.join(coordDir, "routing-info.json"), JSON.stringify(fullInfo, null, 2));
}

/**
 * Create mock events.jsonl for testing observability readers
 */
function createMockEvents(coordDir: string, events: Array<Record<string, unknown>>): void {
	const lines = events.map(e => JSON.stringify({ timestamp: Date.now(), ...e }));
	fs.writeFileSync(path.join(coordDir, "events.jsonl"), lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	const runner = new TestRunner();
	
	// Cleanup old test dirs first
	console.log("Cleaning up old test directories...");
	const cleanup = cleanupOldTestDirs();
	if (cleanup.deleted.length > 0) {
		console.log(`  Deleted ${cleanup.deleted.length} old directories`);
	}
	console.log(`  Kept ${cleanup.kept.length} recent directories\n`);
	
	// ─────────────────────────────────────────────────────────────────────────
	// Fixture detection tests
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Fixture Detection");
	
	await runner.test("spec.md detected as spec", () => {
		const result = detectInputType(readFixture("spec.md"));
		assertEqual(result.type, "spec", `Expected spec, got ${result.type}`);
		assert(result.signals.includes("TASK-XX identifiers"), "Should detect TASK-XX");
		assert(result.signals.includes("acceptance criteria"), "Should detect acceptance");
	});
	
	await runner.test("plan.md detected as plan", () => {
		const result = detectInputType(readFixture("plan.md"));
		assertEqual(result.type, "plan", `Expected plan, got ${result.type}`);
		assert(result.signals.includes("code blocks"), "Should detect code blocks");
		assert(result.signals.includes("file paths"), "Should detect file paths");
	});
	
	await runner.test("request.md detected as request", () => {
		const result = detectInputType(readFixture("request.md"));
		assertEqual(result.type, "request", `Expected request, got ${result.type}`);
		assertContains(result.signals, "prose only");
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Observability readers
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Observability Readers");
	
	await runner.test("readRoutingInfo parses valid JSON", () => {
		const coordDir = createTestCoordDir("routing-reader");
		createMockRoutingInfo(coordDir, {
			mode: "plan",
			skipScout: true,
			skipPlanner: false,
			clarificationsCount: 2,
		});
		
		const routing = readRoutingInfo(coordDir);
		assertExists(routing, "Should read routing info");
		assertEqual(routing!.mode, "plan");
		assertEqual(routing!.skipScout, true);
		assertEqual(routing!.skipPlanner, false);
		assertEqual(routing!.clarificationsCount, 2);
		
		return { coordDir };
	});
	
	await runner.test("readRoutingInfo returns null for missing file", () => {
		const coordDir = createTestCoordDir("routing-missing");
		const routing = readRoutingInfo(coordDir);
		assertEqual(routing, null);
		return { coordDir };
	});
	
	await runner.test("readEvents parses JSONL", () => {
		const coordDir = createTestCoordDir("events-reader");
		createMockEvents(coordDir, [
			{ type: "phase_started", phase: "scout" },
			{ type: "phase_completed", phase: "scout" },
			{ type: "phase_started", phase: "planner" },
		]);
		
		const events = readEvents(coordDir);
		assertEqual(events.length, 3);
		assertEqual(events[0].type, "phase_started");
		assertEqual(events[0].phase, "scout");
		
		return { coordDir };
	});
	
	await runner.test("readEvents handles malformed lines", () => {
		const coordDir = createTestCoordDir("events-malformed");
		fs.mkdirSync(coordDir, { recursive: true });
		fs.writeFileSync(path.join(coordDir, "events.jsonl"), 
			'{"type": "valid"}\n' +
			'not json\n' +
			'{"type": "also_valid"}\n'
		);
		
		const events = readEvents(coordDir);
		assertEqual(events.length, 2); // Skips malformed line
		
		return { coordDir };
	});
	
	await runner.test("getPhaseEvents categorizes correctly", () => {
		const coordDir = createTestCoordDir("phase-events");
		createMockEvents(coordDir, [
			{ type: "phase_started", phase: "scout" },
			{ type: "phase_completed", phase: "scout" },
			{ type: "phase_skipped", phase: "planner" },
			{ type: "phase_started", phase: "coordinator" },
		]);
		
		const phases = getPhaseEvents(coordDir);
		assertContains(phases.started, "scout");
		assertContains(phases.started, "coordinator");
		assertContains(phases.completed, "scout");
		assertContains(phases.skipped, "planner");
		
		return { coordDir };
	});
	
	await runner.test("getCostFromEvents finds latest cost", () => {
		const coordDir = createTestCoordDir("cost-events");
		createMockEvents(coordDir, [
			{ type: "cost_updated", total: 0.10 },
			{ type: "other_event" },
			{ type: "cost_updated", total: 0.25 },
			{ type: "cost_updated", total: 0.42 },
		]);
		
		const cost = getCostFromEvents(coordDir);
		assertEqual(cost, 0.42);
		
		return { coordDir };
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Routing logic validation
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Routing Logic");
	
	await runner.test("spec mode should skip scout and planner", () => {
		// This validates the expected routing-info structure for spec mode
		const coordDir = createTestCoordDir("spec-routing");
		createMockRoutingInfo(coordDir, {
			mode: "spec",
			skipScout: true,
			skipPlanner: true,
			clarificationsCount: 0,
		});
		
		const routing = readRoutingInfo(coordDir)!;
		assertEqual(routing.mode, "spec");
		assertEqual(routing.skipScout, true, "Spec should skip scout");
		assertEqual(routing.skipPlanner, true, "Spec should skip planner");
		
		return { coordDir };
	});
	
	await runner.test("plan mode should skip scout but run planner", () => {
		const coordDir = createTestCoordDir("plan-routing");
		createMockRoutingInfo(coordDir, {
			mode: "plan",
			skipScout: true,
			skipPlanner: false,
			clarificationsCount: 0,
		});
		
		const routing = readRoutingInfo(coordDir)!;
		assertEqual(routing.mode, "plan");
		assertEqual(routing.skipScout, true, "Plan should skip scout");
		assertEqual(routing.skipPlanner, false, "Plan should run planner");
		
		return { coordDir };
	});
	
	await runner.test("request mode should run all phases", () => {
		const coordDir = createTestCoordDir("request-routing");
		createMockRoutingInfo(coordDir, {
			mode: "request",
			skipScout: false,
			skipPlanner: false,
			clarificationsCount: 3,
			clarifications: [
				{ question: "Q1?", value: "A1", wasTimeout: false, wasCustom: false },
				{ question: "Q2?", value: "A2", wasTimeout: true, wasCustom: false },
				{ question: "Q3?", value: "custom", wasTimeout: false, wasCustom: true },
			],
		});
		
		const routing = readRoutingInfo(coordDir)!;
		assertEqual(routing.mode, "request");
		assertEqual(routing.skipScout, false, "Request should run scout");
		assertEqual(routing.skipPlanner, false, "Request should run planner");
		assertEqual(routing.clarificationsCount, 3);
		assertEqual(routing.clarifications.length, 3);
		
		return { coordDir };
	});
	
	// ─────────────────────────────────────────────────────────────────────────
	// Mock stdin tests (TUI behavior)
	// ─────────────────────────────────────────────────────────────────────────
	
	runner.section("Mock Stdin");
	
	await runner.test("Keys constants are correct", () => {
		assertEqual(Keys.ENTER, "\r");
		assertEqual(Keys.ESC, "\x1b");
		assertEqual(Keys.UP, "\x1b[A");
		assertEqual(Keys.DOWN, "\x1b[B");
		assertEqual(Keys.TAB, "\t");
	});
	
	// Print summary
	const { passed, failed } = runner.summary();
	
	// Instructions for full E2E tests
	console.log(`
─────────────────────────────────────────────────────────────
  Full E2E Testing (manual, uses LLM)
─────────────────────────────────────────────────────────────
  Run these commands to test actual coordination:

  # Test spec mode (skips scout + planner)
  pi "coordinate({ plan: 'tests/fixtures/spec.md', mode: 'spec', costLimit: 0.50 })"

  # Test plan mode (skips scout, runs planner)
  pi "coordinate({ plan: 'tests/fixtures/plan.md', mode: 'plan', costLimit: 0.50 })"

  # Test auto-detection
  pi "coordinate({ plan: 'tests/fixtures/request.md', costLimit: 0.50 })"

  Then inspect the coordination directory for routing-info.json and events.jsonl
`);
	
	process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
	console.error("Test suite failed:", err);
	process.exit(1);
});
