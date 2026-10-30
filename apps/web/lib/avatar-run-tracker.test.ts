import assert from "node:assert/strict";
import test from "node:test";

import { createAvatarRunTracker, type AvatarRunBus, type AvatarRunInput } from "./avatar-run-tracker";

function setup() {
	const calls: string[] = [];
	const bus: AvatarRunBus = {
		begin: (id) => calls.push(`begin:${id}`),
		activity: (id, activity) => calls.push(`activity:${id}:${activity.phase}`),
		end: (id, outcome) => calls.push(`end:${id}:${outcome}`),
	};
	const tracker = createAvatarRunTracker(bus);
	const base: AvatarRunInput = {
		botIds: ["a"],
		activity: { phase: "idle" },
		running: false,
		status: null,
		paused: false,
		pendingApproval: false,
		error: null,
		cancelSeq: 0,
		cancelledMessage: "cancelado",
	};
	return { calls, tracker, base };
}

test("nada acontece enquanto não há run", () => {
	const { calls, tracker, base } = setup();
	tracker.sync(base);
	tracker.sync({ ...base, activity: { phase: "thinking" } });
	assert.deepEqual(calls, []);
});

test("ordem: começa o run (begin) antes de publicar a atividade; depois só atividade", () => {
	const { calls, tracker, base } = setup();
	tracker.sync({ ...base, running: true, activity: { phase: "thinking" } });
	tracker.sync({ ...base, running: true, activity: { phase: "tool", tool: "shell" } });
	assert.deepEqual(calls, ["begin:a", "activity:a:thinking", "activity:a:tool"]);
});

test("fim sem erro comemora; com erro faz cara de erro", () => {
	const ok = setup();
	ok.tracker.sync({ ...ok.base, running: true });
	ok.tracker.sync({ ...ok.base, running: false });
	assert.equal(ok.calls.at(-1), "end:a:ok");
	const bad = setup();
	bad.tracker.sync({ ...bad.base, running: true });
	bad.tracker.sync({ ...bad.base, running: false, error: "falhou" });
	assert.equal(bad.calls.at(-1), "end:a:error");
});

test("parar pelo usuário (cancelSeq sobe) é neutro, mesmo com a mensagem de erro de cancelado", () => {
	const { calls, tracker, base } = setup();
	tracker.sync({ ...base, running: true });
	tracker.sync({ ...base, running: true, cancelSeq: 1 });
	tracker.sync({ ...base, running: false, cancelSeq: 1, error: "cancelado" });
	assert.equal(calls.at(-1), "end:a:cancel");
});

test("run cancelado em outro aparelho (só a mensagem de erro) também é neutro", () => {
	const { calls, tracker, base } = setup();
	tracker.sync({ ...base, running: true });
	tracker.sync({ ...base, running: false, error: "cancelado" });
	assert.equal(calls.at(-1), "end:a:cancel");
});

test("cancelar um run antigo não contamina o seguinte", () => {
	const { calls, tracker, base } = setup();
	tracker.sync({ ...base, running: true });
	tracker.sync({ ...base, running: false, cancelSeq: 1 });
	tracker.sync({ ...base, running: true, cancelSeq: 1 });
	tracker.sync({ ...base, running: false, cancelSeq: 1 });
	assert.equal(calls.at(-1), "end:a:ok");
});

test("grupo: o membro que responde aparece no meio do run e some no fim, e ainda recebe o fim", () => {
	const { calls, tracker, base } = setup();
	tracker.sync({ ...base, botIds: ["g", undefined], running: true });
	tracker.sync({ ...base, botIds: ["g", "m1"], running: true, activity: { phase: "writing" } });
	// no fim o membro já não está mais em `liveMember`
	tracker.sync({ ...base, botIds: ["g", undefined], running: false });
	assert.deepEqual(calls.filter((c) => c.startsWith("begin") || c.startsWith("end")), ["begin:g", "begin:m1", "end:g:ok", "end:m1:ok"]);
});

test("mudar o contexto (status, aprovação) republica a atividade sem recomeçar nem terminar", () => {
	const { calls, tracker, base } = setup();
	tracker.sync({ ...base, running: true });
	tracker.sync({ ...base, running: true, pendingApproval: true });
	tracker.sync({ ...base, running: true, status: "waiting_user" });
	assert.equal(calls.filter((c) => c.startsWith("begin")).length, 1);
	assert.equal(calls.filter((c) => c.startsWith("end")).length, 0);
});

// REGRESSÃO (achada na prévia no app real): o hook ficava depois do `return` de "sem agente" do
// ChatThread e a ordem dos hooks mudava entre renders ("React has detected a change in the order of Hooks").
test("ChatThread chama useAvatarActivity antes do return de 'sem agente'", async () => {
	const { readFile } = await import("node:fs/promises");
	const src = await readFile(new URL("../components/ui/templates/template-4/chat-thread/chat-thread.tsx", import.meta.url), "utf8");
	const hook = src.indexOf("useAvatarActivity({");
	const early = src.indexOf("if (!agent) {");
	assert.ok(hook > 0 && early > 0);
	assert.ok(hook < early, "o hook precisa vir antes do return antecipado");
});
