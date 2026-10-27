import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotifyResult } from "@workspace/db";
import { isVmProtectedFromGuard, noticeVmStopped, VM_STOPPED_CHAT_TEXT, VM_STOPPED_PUSH_TEXT, type VmGuardDeps } from "./sandbox-guard-notice.js";

const vm = { userId: "user-a", conversationId: "conv-a" };
const sent: NotifyResult = { status: "sent", sent: 1, deleted: 0, failed: 0 };
const skipped: NotifyResult = { status: "skipped", reason: "viewing" };

function deps(over: Partial<VmGuardDeps> = {}) {
	const appended: Array<[string, string]> = [];
	const pushed: string[] = [];
	const d: VmGuardDeps = {
		push: async (_u, _c, text) => {
			pushed.push(text);
			return sent;
		},
		ownsConversation: async (user, conversation) => user === "user-a" && conversation === "conv-a",
		holdsVm: async () => false,
		appendMessage: async (conversation, text) => void appended.push([conversation, text]),
		...over,
	};
	return { appended, pushed, deps: d };
}

test("depois do stop: mensagem no passado na conversa e push de bônus", async () => {
	const { deps: d, appended, pushed } = deps();
	await noticeVmStopped(vm, d);
	assert.deepEqual(appended, [["conv-a", VM_STOPPED_CHAT_TEXT]]);
	assert.deepEqual(pushed, [VM_STOPPED_PUSH_TEXT]);
	assert.match(VM_STOPPED_CHAT_TEXT, /^Desliguei o computador para liberar memória/);
});

test("push ausente, ignorado ou que falha não impede o aviso na conversa", async () => {
	for (const push of [null, async () => skipped, async (): Promise<NotifyResult> => { throw new Error("vapid"); }]) {
		const { deps: d, appended } = deps({ push });
		await noticeVmStopped(vm, d);
		assert.equal(appended.length, 1);
	}
});

test("mensagem não gravada lança (quem chama só registra: a VM já parou)", async () => {
	const { deps: d } = deps({ appendMessage: async () => { throw new Error("db fora"); } });
	await assert.rejects(noticeVmStopped(vm, d), /db fora/);
});

test("sem usuário ou conversa não há onde avisar", async () => {
	const { deps: d, appended } = deps();
	await noticeVmStopped({ userId: "user-a" }, d);
	assert.deepEqual(appended, []);
});

test("VM protegida: dono não verificável (conversa de outro, sem conversa) nunca é desligada", async () => {
	const { deps: d } = deps();
	assert.equal(await isVmProtectedFromGuard({ userId: "user-b", conversationId: "conv-a" }, d), true);
	assert.equal(await isVmProtectedFromGuard({ userId: "user-a" }, d), true);
	assert.equal(await isVmProtectedFromGuard({ userId: "", conversationId: "conv-a" }, d), true);
});

test("VM protegida: run usando ou esperando o usuário segura; dono verificado e sem run libera", async () => {
	assert.equal(await isVmProtectedFromGuard(vm, deps({ holdsVm: async () => true }).deps), true);
	assert.equal(await isVmProtectedFromGuard(vm, deps().deps), false);
});
