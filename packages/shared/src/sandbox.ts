export type SandboxSessionStatus = "starting" | "running" | "stopped" | "error";

export type SandboxSessionResponse = {
	sessionId: string;
	conversationId?: string;
	status: SandboxSessionStatus;
	viewerUrl: string;
	createdAt: string;
};

export type CreateSandboxSessionBody = {
	conversationId?: string;
};

export type SandboxNavigateBody = {
	url: string;
};

export type SandboxToolName =
	| "navigate"
	| "screenshot"
	| "click"
	| "type"
	| "key"
	| "scroll";

export type SandboxClickBody = {
	x: number;
	y: number;
};

export type SandboxTypeBody = {
	text: string;
};

/** Atalho de teclado no formato do xdotool (ex.: "ctrl+l", "Return"). */
export type SandboxKeyBody = {
	combo: string;
};

export type SandboxScrollBody = {
	deltaX?: number;
	deltaY?: number;
};

export type SandboxScreenResponse = {
	width: number;
	height: number;
};
