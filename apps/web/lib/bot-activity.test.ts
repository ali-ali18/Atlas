import assert from "node:assert/strict";
import test from "node:test";
import {
	botAvatarSignal,
	endBotRun,
	isBotWorking,
	refreshBotAvatar,
	setBotActivity,
	setBotWorking,
	setServerWorking,
} from "./bot-activity";
import { GOVERNOR_TUNING } from "./avatar-governor";

test("marca e desmarca o bot como trabalhando, por bot", () => {
	setBotWorking("a", true);
	assert.equal(isBotWorking("a"), true);
	assert.equal(isBotWorking("b"), false);
	setBotWorking("a", false);
	assert.equal(isBotWorking("a"), false);
});

test("ignora id vazio e repetição sem mudança", () => {
	setBotWorking("", true);
	assert.equal(isBotWorking(""), false);
	setBotWorking("c", false);
	assert.equal(isBotWorking("c"), false);
});

test("fonte do servidor e sinal local se somam; um não apaga o outro", () => {
	setServerWorking(["s1", "s2"]);
	setBotWorking("l1", true);
	assert.equal(isBotWorking("s1"), true);
	assert.equal(isBotWorking("l1"), true);
	setServerWorking(["s2"]);
	assert.equal(isBotWorking("s1"), false);
	assert.equal(isBotWorking("l1"), true, "o sinal local continua");
	setBotWorking("l1", false);
	setBotWorking("s2", true);
	setServerWorking([]);
	assert.equal(isBotWorking("s2"), true, "local segue valendo sem o servidor");
	setBotWorking("s2", false);
	assert.equal(isBotWorking("s2"), false);
});

test("avatar: run só do servidor (rotina) mostra gestos genéricos de trabalho e volta ao repouso", () => {
	assert.equal(botAvatarSignal("rotina").state, "idle");
	setServerWorking(["rotina"]);
	assert.equal(botAvatarSignal("rotina").state, "working");
	setServerWorking([]);
	refreshBotAvatar("rotina", Date.now() + GOVERNOR_TUNING.minDwellMs + 1);
	assert.equal(botAvatarSignal("rotina").state, "idle");
});

test("avatar: a atividade publicada vira o estado do avatar, por bot", () => {
	const t0 = Date.now();
	setBotWorking("p1", true);
	setBotWorking("p2", true);
	setBotActivity("p1", { phase: "tool", tool: "read_file" }, {}, t0);
	setBotActivity("p2", { phase: "writing" }, {}, t0);
	assert.equal(botAvatarSignal("p1").state, "reading");
	assert.equal(botAvatarSignal("p2").state, "streaming");
	// troca dentro da permanência mínima não aparece
	setBotActivity("p1", { phase: "tool", tool: "edit_file" }, {}, t0 + 200);
	assert.equal(botAvatarSignal("p1").state, "reading");
	refreshBotAvatar("p1", t0 + GOVERNOR_TUNING.minDwellMs);
	assert.equal(botAvatarSignal("p1").state, "coding");
	setBotWorking("p1", false);
	setBotWorking("p2", false);
});

test("avatar: passo e total de passos chegam ao avatar como fração", () => {
	const t0 = Date.now();
	setBotWorking("p3", true);
	setBotActivity("p3", { phase: "tool", tool: "navigate", step: 2, maxSteps: 8 }, {}, t0);
	assert.deepEqual(botAvatarSignal("p3"), { state: "progress", progress: 3 / 8 });
	setBotWorking("p3", false);
});

test("avatar: ferramenta com falha faz cara de erro; run que acaba bem comemora", () => {
	const t0 = Date.now();
	setBotWorking("p4", true);
	setBotActivity("p4", { phase: "tool", tool: "shell" }, {}, t0);
	setBotActivity("p4", { phase: "thinking", toolFailed: true }, {}, t0 + 100);
	assert.equal(botAvatarSignal("p4").state, "failed");
	refreshBotAvatar("p4", t0 + 100 + GOVERNOR_TUNING.failedMs);
	assert.equal(botAvatarSignal("p4").state, "thinking");
	setBotWorking("p4", false);
	endBotRun("p4", "ok", t0 + 10_000);
	assert.equal(botAvatarSignal("p4").state, "finished");
	refreshBotAvatar("p4", t0 + 10_000 + GOVERNOR_TUNING.finishedMs);
	assert.equal(botAvatarSignal("p4").state, "idle");
});

test("avatar: aprovação pendente e erro no fim do run", () => {
	const t0 = Date.now();
	setBotWorking("p5", true);
	setBotActivity("p5", { phase: "tool", tool: "shell" }, { pendingApproval: true }, t0);
	assert.equal(botAvatarSignal("p5").state, "waiting");
	setBotWorking("p5", false);
	endBotRun("p5", "error", t0 + 5000);
	assert.equal(botAvatarSignal("p5").state, "failed");
});

test("avatar: run novo logo depois do fim não espera a comemoração do anterior", () => {
	const t0 = Date.now();
	setBotWorking("p6", true);
	setBotActivity("p6", { phase: "writing" }, {}, t0);
	setBotWorking("p6", false);
	endBotRun("p6", "ok", t0 + 1500);
	assert.equal(botAvatarSignal("p6").state, "finished");
	setBotWorking("p6", true);
	setBotActivity("p6", { phase: "thinking" }, {}, t0 + 1600);
	assert.equal(botAvatarSignal("p6").state, "thinking");
	setBotWorking("p6", false);
});
