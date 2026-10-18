import { validateAgentRunOwnership, ResourceOwnershipError } from "@workspace/db";
import { createSandboxManager, loadSandboxConfig } from "@workspace/sandbox";
import type { CreateAgentRunRequest } from "@workspace/shared";

/** Valida referências antes de confirms/tools, sem iniciar ou recriar sandbox. */
export async function validateRunReferences(
	request: Partial<Record<"botId" | "conversationId" | "sandboxSessionId", string | null>>,
	userId: string,
	dependencies: {
		validateOwnership?: typeof validateAgentRunOwnership;
		sessionMetadata?: (sessionId: string, userId: string) => Promise<{ conversationId?: string } | null>;
	} = {},
) {
	const references: Pick<CreateAgentRunRequest, "botId" | "conversationId"> = {
		botId: request.botId ?? undefined,
		conversationId: request.conversationId ?? undefined,
	};
	const owned = await (dependencies.validateOwnership ?? validateAgentRunOwnership)(references, userId);
	if (request.sandboxSessionId) {
		const metadata = dependencies.sessionMetadata ?? ((id: string, owner: string) =>
			createSandboxManager(loadSandboxConfig(), owner).getOwnedSessionMetadata(id));
		const session = await metadata(request.sandboxSessionId, userId);
		if (!session || session.conversationId !== (owned.conversationId ?? undefined)) {
			throw new ResourceOwnershipError();
		}
	}
	return owned;
}
