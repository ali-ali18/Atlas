import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotifyResult } from "@workspace/db";
import { noticeVmStop, VM_STOPPED_CHAT_TEXT } from "./sandbox-guard-notice.js";

const vm = { userId: "user-a", conversationId: "conv-a" };
const sent: NotifyResult = { status: "sent", sent: 1, deleted: 0, failed: 0 };
const skipped: NotifyResult = { status: "skipped", reason: "viewing" };

function deps(over: Partial<Parameters<typeof noticeVmStop>[1]> = {}) {
	const appended: Array<[string, string]> = [];
	return {
		appended,
		deps: {
			push: async () => sent,
			ownsConversation: async (user: string, conversation: string) => user === "user-a" && conversation === "conv-a",
			appendMessage: async (conversation: string, text: string) => void appended.push([conversation, text]),
			...over,
		},
	};
}

test("grava a mensagem em pt-BR na conversa mesmo quando o push sai", async () => {
	const { deps: d, appended } = deps();
	await noticeVmStop(vm, d);
	assert.deepEqual(appended, [["conv-a", VM_STOPPED_CHAT_TEXT]]);
	assert.match(VM_STOPPED_CHAT_TEXT, /Desliguei o computador para liberar memória/);
});

test("push ignorado (sem VAPID, aviso desligado, conversa aberta) ainda deixa o aviso na conversa", async () => {
	for (const push of [null, async () => skipped]) {
		const { deps: d, appended } = deps({ push });
		await noticeVmStop(vm, d);
		assert.equal(appended.length, 1);
	}
});

test("push ignorado E mensagem não gravada: lança (a parada fica para a próxima rodada)", async () => {
	const { deps: d } = deps({ push: async () => skipped, appendMessage: async () => { throw new Error("db fora"); } });
	await assert.rejects(noticeVmStop(vm, d), /could not warn the owner/);
	const { deps: noPush } = deps({ push: null, appendMessage: async () => { throw new Error("db fora"); } });
	await assert.rejects(noticeVmStop(vm, noPush));
});

test("push enviado e mensagem falhou: o dono foi avisado, segue", async () => {
	const { deps: d } = deps({ appendMessage: async () => { throw new Error("db fora"); } });
	await noticeVmStop(vm, d);
});

test("conversa de outro dono não recebe mensagem", async () => {
	const { deps: d, appended } = deps();
	await noticeVmStop({ userId: "user-b", conversationId: "conv-a" }, d);
	assert.deepEqual(appended, []);
});
