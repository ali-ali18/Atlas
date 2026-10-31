import assert from "node:assert/strict";
import test from "node:test";
import {
	beginBotRun,
	botActivityStateSize,
	botAvatarSignal,
	endBotRun,
	isBotWorking,
	refreshBotAvatar,
	setBotActivity,
	setBotWorking,
	setServerWorking,
	subscribeBotPulses,
	type BotPulseKind,
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
	assert.deepEqual(botAvatarSignal("p3"), { state: "searching", progress: 3 / 8 });
	// o anel só chega se o mesmo passo durar além do limiar
	refreshBotAvatar("p3", t0 + GOVERNOR_TUNING.progressAfterMs);
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
	beginBotRun("p6", t0 + 1600);
	setBotWorking("p6", true);
	setBotActivity("p6", { phase: "thinking" }, {}, t0 + 1600);
	assert.equal(botAvatarSignal("p6").state, "thinking");
	setBotWorking("p6", false);
});

test("pulsos: ferramenta nova começa, termina bem ou falha; repetir o mesmo estado não pulsa de novo", () => {
	const t0 = Date.now();
	const got: BotPulseKind[] = [];
	const off = subscribeBotPulses("p7", (kind) => got.push(kind));
	setBotWorking("p7", true);
	setBotActivity("p7", { phase: "thinking" }, {}, t0);
	assert.deepEqual(got, []);
	const read = { phase: "tool", tool: "read_file", step: 0, maxSteps: 4 } as const;
	setBotActivity("p7", read, {}, t0 + 10);
	setBotActivity("p7", read, { status: "running" }, t0 + 20); // só o contexto mudou
	assert.deepEqual(got, ["toolStart"]);
	setBotActivity("p7", { phase: "thinking" }, {}, t0 + 30);
	setBotActivity("p7", { phase: "thinking" }, { status: "running" }, t0 + 40);
	assert.deepEqual(got, ["toolStart", "toolOk"]);
	setBotActivity("p7", { phase: "tool", tool: "shell", step: 1, maxSteps: 4 }, {}, t0 + 50);
	setBotActivity("p7", { phase: "thinking", toolFailed: true }, {}, t0 + 60);
	assert.deepEqual(got, ["toolStart", "toolOk", "toolStart", "toolFail"]);
	off();
	setBotActivity("p7", { phase: "tool", tool: "navigate" }, {}, t0 + 70);
	assert.equal(got.length, 4, "sem ouvinte não entrega");
	setBotWorking("p7", false);
});

test("pulsos são por bot", () => {
	const t0 = Date.now();
	const a: BotPulseKind[] = [];
	const b: BotPulseKind[] = [];
	const offA = subscribeBotPulses("pa", (k) => a.push(k));
	const offB = subscribeBotPulses("pb", (k) => b.push(k));
	setBotWorking("pa", true);
	setBotActivity("pa", { phase: "tool", tool: "navigate" }, {}, t0);
	assert.deepEqual(a, ["toolStart"]);
	assert.deepEqual(b, []);
	offA();
	offB();
	setBotWorking("pa", false);
});

test("avatar: poll do servidor que ainda lista o bot depois do fim local não vira trabalho genérico nem cobre o run novo", () => {
	const t0 = Date.now();
	setServerWorking(["o1"]);
	beginBotRun("o1", t0);
	setBotWorking("o1", true);
	setBotActivity("o1", { phase: "writing" }, {}, t0);
	assert.equal(botAvatarSignal("o1").state, "streaming");
	setBotWorking("o1", false);
	endBotRun("o1", "ok", t0 + 3000);
	assert.equal(isBotWorking("o1"), false, "o fim local vale sobre o servidor");
	assert.equal(botAvatarSignal("o1").state, "finished");
	// run novo logo em seguida: não espera a comemoração e o servidor não atrapalha
	beginBotRun("o1", t0 + 3500);
	setBotWorking("o1", true);
	setBotActivity("o1", { phase: "thinking" }, {}, t0 + 3500);
	assert.equal(botAvatarSignal("o1").state, "thinking");
	setBotWorking("o1", false);
	endBotRun("o1", "cancel", t0 + 9000);
	// o poll seguinte já não lista o bot: a supressão acaba; se ele voltar, é run novo (de outro aparelho)
	setServerWorking([]);
	setServerWorking(["o1"]);
	assert.equal(isBotWorking("o1"), true);
	setServerWorking([]);
});

test("avatar: falha de ferramenta é um evento só; mudar o contexto com o mesmo objeto não repete", () => {
	const t0 = Date.now();
	setBotWorking("f1", true);
	setBotActivity("f1", { phase: "tool", tool: "shell" }, {}, t0);
	const failed = { phase: "thinking", toolFailed: true } as const;
	setBotActivity("f1", failed, {}, t0 + 100);
	assert.equal(botAvatarSignal("f1").state, "failed");
	const later = t0 + 100 + GOVERNOR_TUNING.failedMs + 10;
	refreshBotAvatar("f1", later);
	assert.equal(botAvatarSignal("f1").state, "thinking");
	// o contexto mudou (aprovação pendente some, status muda) com o mesmo objeto de atividade
	setBotActivity("f1", failed, { status: "running" }, later + 100);
	setBotActivity("f1", failed, { status: "running", paused: false }, later + 200);
	assert.notEqual(botAvatarSignal("f1").state, "failed");
	// uma segunda falha de verdade (objeto novo) reage de novo
	setBotActivity("f1", { phase: "tool", tool: "shell" }, {}, later + 300);
	setBotActivity("f1", { phase: "thinking", toolFailed: true }, {}, later + 400);
	assert.equal(botAvatarSignal("f1").state, "failed");
	setBotWorking("f1", false);
});

test("avatar: parar o run (cancel) não comemora nem faz cara de erro", () => {
	const t0 = Date.now();
	setBotWorking("c1", true);
	setBotActivity("c1", { phase: "tool", tool: "read_file" }, {}, t0);
	setBotWorking("c1", false);
	endBotRun("c1", "cancel", t0 + 2000);
	const seen = new Set<string>([botAvatarSignal("c1").state]);
	for (const dt of [2100, 3000, 6000]) {
		refreshBotAvatar("c1", t0 + dt);
		seen.add(botAvatarSignal("c1").state);
	}
	assert.ok(!seen.has("finished") && !seen.has("failed"), [...seen].join(","));
	assert.equal(botAvatarSignal("c1").state, "idle");
});

test("avatar: poll que já estava em voo quando o run acabou não traz o 'trabalhando' genérico de volta", () => {
	const t0 = Date.now();
	setBotWorking("q1", true);
	setBotActivity("q1", { phase: "writing" }, {}, t0);
	setBotWorking("q1", false);
	// o servidor ainda não listava o bot no instante do fim; um poll em voo o lista logo depois
	endBotRun("q1", "ok", t0 + 1000);
	setServerWorking(["q1"]);
	assert.equal(isBotWorking("q1", t0 + 1100), false);
	assert.equal(botAvatarSignal("q1").state, "finished");
	// passada a tolerância, um servidor que ainda lista o bot vale de novo (outro run, outro aparelho)
	assert.equal(isBotWorking("q1", t0 + 1000 + 21_000), true);
	setServerWorking([]);
});

test("avatar: bots em repouso não deixam estado guardado", () => {
	const t0 = Date.now();
	const before = botActivityStateSize();
	for (let i = 0; i < 20; i++) {
		const id = `prune-${i}`;
		setBotWorking(id, true);
		setBotActivity(id, { phase: "thinking" }, {}, t0);
		setBotWorking(id, false);
		endBotRun(id, "cancel", t0 + 5000);
		refreshBotAvatar(id, t0 + 20_000);
	}
	const size = botActivityStateSize();
	assert.ok(size.governors - before.governors < 3 && size.signals - before.signals < 3 && size.details - before.details < 3, `${JSON.stringify(before)} → ${JSON.stringify(size)}`);
});
