import type { ChatTool } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";

export const SANDBOX_RELEASE_TOOL_NAME = "sandbox_release";

export const SANDBOX_RELEASE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: SANDBOX_RELEASE_TOOL_NAME,
		description:
			"Turn the VM (computer) off gracefully once the task no longer needs it, so it stops using memory. The browser login and files are kept; the next browser call turns it on again. Use when the work in the browser is finished. Do NOT use in the middle of a task, while waiting for the user to log in, or if more browser steps are likely soon.",
		parameters: { type: "object", properties: {} },
	},
};

export type SandboxReleaseContext = {
	manager: Pick<SandboxManager, "stopConversationSession"> & Partial<Pick<SandboxManager, "getConversationActivity">>;
	conversationId?: string;
};

/** Desliga a VM da conversa (graciosa, 15 s). Não liga nada: sem VM ligada, só avisa. */
export async function executeSandboxRelease(ctx: SandboxReleaseContext): Promise<{ summary: string }> {
	if (!ctx.conversationId) {
		throw new Error("There is no conversation VM to turn off in this run.");
	}
	const activity = await ctx.manager.getConversationActivity?.(ctx.conversationId).catch(() => null) ?? null;
	if (activity?.busy) {
		throw new Error("The VM was NOT turned off: someone is using the screen or a command is still running on it. Leave it on; it is turned off later if memory is needed.");
	}
	let stopped: boolean;
	try {
		stopped = await ctx.manager.stopConversationSession(ctx.conversationId);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not turn the VM off (${detail}). It may still be on; the user can turn it off in the Computer tab.`);
	}
	return {
		summary: stopped
			? "VM turned off. Login and files are kept; the next browser call turns it on again."
			: "The VM was already off; nothing to do.",
	};
}
