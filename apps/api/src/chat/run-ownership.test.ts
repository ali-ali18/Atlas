import assert from "node:assert/strict";
import { test } from "node:test";
import { ResourceOwnershipError } from "@workspace/db";
import { validateRunReferences } from "./run-ownership.js";

test("sandbox deve pertencer ao dono e à conversa resolvida pelo bot", async () => {
	const dependencies = {
		validateOwnership: async () => ({ botId: "bot-a", conversationId: "conv-a" }),
		sessionMetadata: async (id: string, userId: string) => id === "sandbox-a" && userId === "owner-a" ? { conversationId: "conv-a" } : null,
	};
	assert.deepEqual(await validateRunReferences({ botId: "bot-a", sandboxSessionId: "sandbox-a" }, "owner-a", dependencies), { botId: "bot-a", conversationId: "conv-a" });
	await assert.rejects(validateRunReferences({ botId: "bot-a", sandboxSessionId: "sandbox-a" }, "owner-b", dependencies), ResourceOwnershipError);
	await assert.rejects(validateRunReferences({ botId: "bot-a", sandboxSessionId: "sandbox-a" }, "owner-a", { ...dependencies, sessionMetadata: async () => ({ conversationId: "conv-b" }) }), ResourceOwnershipError);
});

test("referência estrangeira falha antes de consultar sandbox", async () => {
	let metadataReads = 0;
	await assert.rejects(validateRunReferences({ botId: "foreign", sandboxSessionId: "s" }, "owner-a", {
		validateOwnership: async () => { throw new ResourceOwnershipError(); },
		sessionMetadata: async () => { metadataReads++; return null; },
	}), ResourceOwnershipError);
	assert.equal(metadataReads, 0);
});
