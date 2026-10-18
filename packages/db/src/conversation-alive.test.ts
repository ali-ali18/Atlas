/**
 * F4 — conversa apagada no meio do run: finalize/steer terminam sem gravar.
 * Runner: `pnpm exec tsx --test src/conversation-alive.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./client.js";
import { conversationAlive } from "./runs.js";

test("conversationAlive: existe → true; apagada → false; erro → false", async () => {
	const original = prisma.conversation.findUnique;
	let mode: "exists" | "gone" | "boom" = "exists";
	(prisma.conversation as unknown as Record<string, unknown>).findUnique =
		(async () => {
			if (mode === "boom") throw new Error("db caiu");
			return mode === "exists" ? { id: "conv-1" } : null;
		}) as unknown as typeof original;
	try {
		assert.equal(await conversationAlive("conv-1"), true);
		mode = "gone";
		assert.equal(await conversationAlive("conv-1"), false);
		mode = "boom";
		assert.equal(await conversationAlive("conv-1"), false);
	} finally {
		prisma.conversation.findUnique = original;
	}
});
