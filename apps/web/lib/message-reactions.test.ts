import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageReaction } from "@workspace/shared";

const { createReactionStore, isPersistedMessageId, REACTION_FAILURE_MESSAGE, userEmoji } = await import("./message-reactions.js");

const user = (emoji: string): MessageReaction => ({ actor: "user", emoji });
const bot = (emoji: string): MessageReaction => ({ actor: "bot", emoji });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(opts: { fail?: boolean; bot?: MessageReaction[] } = {}) {
	const calls: string[] = [];
	const gates: Array<() => void> = [];
	const toasts: string[] = [];
	let hold = false;
	const settle = async (emoji: string | null) => {
		if (hold) await new Promise<void>((resolve) => gates.push(resolve));
		if (opts.fail) throw new Error("rede");
		return emoji ? [...(opts.bot ?? []), user(emoji)] : [...(opts.bot ?? [])];
	};
	const store = createReactionStore(
		{
			set: async (id, emoji) => (calls.push(`PUT ${id} ${emoji}`), settle(emoji)),
			clear: async (id) => (calls.push(`DELETE ${id}`), settle(null)),
			get: async (id) => (calls.push(`GET ${id}`), [bot("❤️"), user("👍")]),
		},
		(message) => toasts.push(message),
	);
	return { store, calls, toasts, hold: (value: boolean) => (hold = value), release: () => gates.splice(0).forEach((open) => open()) };
}

test("só ids gravados no servidor aceitam reação", () => {
	assert.equal(isPersistedMessageId("cmgx3k2j00001abcd1234efgh"), true);
	for (const id of ["msg-1730000000-ab12", "cu-3", "", "live-abc"]) assert.equal(isPersistedMessageId(id), false);
});

test("otimista: aparece antes da resposta e a resposta do servidor confirma", async () => {
	const { store, calls, hold, release } = setup({ bot: [bot("❤️")] });
	hold(true);
	const done = store.toggle("m", "👍");
	assert.deepEqual(store.get("m"), [user("👍")]);
	release();
	await done;
	assert.deepEqual(store.get("m"), [bot("❤️"), user("👍")]);
	assert.deepEqual(calls, ["PUT m 👍"]);
});

test("falha: volta ao último estado confirmado e avisa com toast", async () => {
	const { store, toasts } = setup({ fail: true });
	store.seed("m", [bot("❤️")]);
	await store.toggle("m", "👎");
	assert.deepEqual(store.get("m"), [bot("❤️")]);
	assert.deepEqual(toasts, [REACTION_FAILURE_MESSAGE]);
});

test("repetir o emoji tira a reação (DELETE) e a do bot continua", async () => {
	const { store, calls } = setup({ bot: [bot("❤️")] });
	store.seed("m", [bot("❤️"), user("👍")]);
	await store.toggle("m", "👍");
	assert.deepEqual(store.get("m"), [bot("❤️")]);
	assert.deepEqual(calls, ["DELETE m"]);
	assert.equal(userEmoji(store.get("m")), null);
});

test("trocar de emoji substitui a do usuário", async () => {
	const { store } = setup();
	store.seed("m", [user("👍")]);
	await store.toggle("m", "😂");
	assert.deepEqual(store.get("m"), [user("😂")]);
});

test("cliques durante o envio viram um último desejo, aplicado depois, em ordem", async () => {
	const { store, calls, hold, release } = setup();
	hold(true);
	const first = store.toggle("m", "👍");
	void store.toggle("m", "😂");
	assert.deepEqual(store.get("m"), [user("😂")]);
	release();
	await tick();
	release();
	await first;
	assert.deepEqual(calls, ["PUT m 👍", "PUT m 😂"]);
	assert.deepEqual(store.get("m"), [user("😂")]);
});

test("aviso do hub atualiza (outra aba) mas não atropela uma chamada em andamento", async () => {
	const { store, calls, hold, release } = setup();
	await store.refresh("m");
	assert.deepEqual(store.get("m"), [bot("❤️"), user("👍")]);
	hold(true);
	const pending = store.toggle("m", "🙏");
	await store.refresh("m");
	assert.deepEqual(calls.filter((c) => c.startsWith("GET")), ["GET m"]);
	assert.deepEqual(store.get("m"), [bot("❤️"), user("🙏")]);
	release();
	await pending;
});

test("semear pela lista: sem reações no servidor limpa o que sobrou, sem criar entrada à toa", () => {
	const { store } = setup();
	store.seed("a", undefined);
	assert.equal(store.get("a"), undefined);
	store.seed("a", [bot("👍")]);
	assert.deepEqual(store.get("a"), [bot("👍")]);
	store.seed("a", undefined);
	assert.deepEqual(store.get("a"), []);
});
