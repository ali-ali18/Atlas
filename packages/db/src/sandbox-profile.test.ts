/** Perfil do navegador da VM por bot: só o bot do próprio dono, nunca o de grupo. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { getProfileBotId } from "./sandbox-profile.js";

let installed: { restore: () => void };

beforeEach(() => {
	installed = installFakes({
		bot: new FakeTable([
			{ id: "bot-a", ownerId: "user-a", conversationId: "conv-a", memberIds: [] },
			{ id: "group-a", ownerId: "user-a", conversationId: "conv-group", memberIds: ["bot-a", "bot-a2"] },
			{ id: "bot-b", ownerId: "user-b", conversationId: "conv-b", memberIds: [] },
		]),
	});
});
afterEach(() => installed.restore());

test("devolve o bot da conversa do próprio dono", async () => {
	assert.equal(await getProfileBotId("user-a", "conv-a"), "bot-a");
});

test("usuário B não resolve o bot (nem o perfil) do usuário A", async () => {
	assert.equal(await getProfileBotId("user-b", "conv-a"), null);
	assert.equal(await getProfileBotId("user-a", "conv-b"), null);
});

test("conversa de grupo e conversa sem bot caem no perfil por conversa", async () => {
	assert.equal(await getProfileBotId("user-a", "conv-group"), null);
	assert.equal(await getProfileBotId("user-a", "conv-inexistente"), null);
});
