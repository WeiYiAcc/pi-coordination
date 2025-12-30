export interface CoordinationEnv {
	PI_COORDINATION_DIR: string;
	PI_AGENT_IDENTITY: string;
	PI_WORKER_ID: string;
}

export interface CoordinationAgent {
	role: string;
	name: string;
	identity: string;
	model: string;
	tools: string[];
	systemPrompt: string;
	pid?: number;
}

export type MessageType = "handover" | "clarification" | "response" | "status" | "conflict";

export interface CoordinationMessage {
	id: string;
	from: string;
	to: string | "all" | "coordinator";
	type: MessageType;
	content: string;
	timestamp: number;
	inReplyTo?: string;
}

export interface TUIMessage {
	from: string;
	content: string;
	timestamp: number;
	type?: "info" | "warning" | "error";
}

export interface EscalationRequest {
	id: string;
	from: string;
	question: string;
	options: string[];
	timeout: number;
	defaultOption?: number;
	createdAt: number;
}

export interface EscalationResponse {
	id: string;
	choice: string;
	wasTimeout: boolean;
	respondedAt: number;
}

export interface FileReservation {
	id: string;
	agent: string;
	patterns: string[];
	exclusive: boolean;
	reason: string;
	createdAt: number;
	expiresAt: number;
	releasedAt?: number;
}

export type ContractType = "type" | "function" | "file";
export type ContractStatus = "pending" | "in-progress" | "ready" | "modified";

export interface Contract {
	id: string;
	item: string;
	type: ContractType;
	provider: string;
	status: ContractStatus;
	waiters: string[];
	expectedSignature?: string;
	actualSignature?: string;
	file?: string;
	completedAt?: number;
}

export type WorkerStatus = "working" | "waiting" | "blocked" | "complete" | "failed";

export interface WorkerState {
	id: string;
	identity: string;
	agent: string;
	pid: number;
	status: WorkerStatus;
	assignedSteps: number[];
	completedSteps: number[];
	currentStep: number | null;
	blockers: string[];
	handshakeSpec: string;
}

export type CoordinationStatus = "analyzing" | "executing" | "reviewing" | "complete" | "failed";

export interface Deviation {
	type: string;
	description: string;
	timestamp: number;
}

export interface CoordinationState {
	sessionId: string;
	planPath: string;
	planHash: string;
	status: CoordinationStatus;
	workers: Record<string, WorkerState>;
	contracts: Record<string, Contract>;
	deviations: Deviation[];
	startedAt: number;
	completedAt?: number;
}

export interface CoordinationResult {
	summary: string;
	filesModified?: string[];
	deviations?: string[];
}
