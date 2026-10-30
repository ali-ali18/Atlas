import assert from "node:assert/strict";
import test from "node:test";

import { avatarStateForActivity } from "./avatar-activity";
import { GOVERNOR_TUNING, createAvatarGovernor } from "./avatar-governor";
import type { AgentActivity } from "./working-status";

const T = GOVERNOR_TUNING;
const desired = (activity: AgentActivity) => avatarStateForActivity(activity);
const tool = (name: string, step?: number, maxSteps?: number): AgentActivity => ({ phase: "tool", tool: name, step, maxSteps });

test("começa em idle e o primeiro estado de trabalho entra na hora", () => {
	const g = createAvatarGovernor();
	assert.equal(g.signal(0).state, "idle");
	g.push(desired({ phase: "thinking" }), 100);
	assert.equal(g.signal(100).state, "thinking");
});

test("repouso e trabalho genérico não seguram ninguém: o primeiro estado de atividade entra na hora", () => {
	const g = createAvatarGovernor();
	g.push({ state: "working", step: null, progress: null }, 0);
	assert.equal(g.signal(0).state, "working");
	g.push(desired({ phase: "thinking" }), 50);
	assert.equal(g.signal(50).state, "thinking");
	g.push({ state: "idle", step: null, progress: null }, 10_000);
	g.signal(10_000);
	g.push(desired({ phase: "writing" }), 10_100);
	assert.equal(g.signal(10_100).state, "streaming");
});

test("begin() esquece a comemoração do run anterior", () => {
	const g = createAvatarGovernor();
	g.push(desired({ phase: "writing" }), 0);
	g.signal(0);
	g.push({ state: "idle", step: null, progress: null }, 3000);
	g.event("finished", 3000);
	assert.equal(g.signal(3000).state, "finished");
	g.begin();
	g.push(desired({ phase: "thinking" }), 3100);
	assert.equal(g.signal(3100).state, "thinking");
});

test("troca rápida de ferramenta: só a última vale e só depois da permanência mínima", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate")), 0);
	assert.equal(g.signal(0).state, "searching");
	// 3 trocas em 300 ms: nada muda ainda
	g.push(desired(tool("read_file")), 100);
	assert.equal(g.signal(100).state, "searching");
	g.push(desired(tool("edit_file")), 200);
	g.push(desired(tool("shell")), 300);
	assert.equal(g.signal(300).state, "searching");
	assert.equal(g.nextChangeMs(300), T.minDwellMs - 300);
	// vence a permanência: vai direto para a última (reading/coding nunca apareceram)
	assert.equal(g.signal(T.minDwellMs - 1).state, "searching");
	assert.equal(g.signal(T.minDwellMs).state, "running");
});

test("trocar e voltar dentro da permanência não muda nada (sem pisca-pisca)", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate")), 0);
	g.signal(0);
	g.push(desired(tool("read_file")), 400);
	g.signal(400);
	g.push(desired(tool("navigate")), 800);
	assert.equal(g.signal(800).state, "searching");
	assert.equal(g.signal(5000).state, "searching");
	assert.equal(g.nextChangeMs(5000), null);
});

test("depois da permanência a troca é imediata", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate")), 0);
	g.signal(0);
	g.push(desired(tool("edit_file")), 5000);
	assert.equal(g.signal(5000).state, "coding");
});

test("passo novo acende o anel de progresso com a fração e depois volta à ferramenta", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 0, 8)), 0);
	assert.equal(g.signal(0).state, "progress", "primeiro passo mostra o anel");
	assert.equal(g.signal(0).progress, 1 / 8);
	assert.equal(g.signal(T.progressFlashMs - 1).state, "progress");
	assert.equal(g.signal(T.progressFlashMs).state, "reading");
	// mesmo passo de novo (outro render): sem novo brilho
	g.push(desired(tool("read_file", 0, 8)), 4000);
	assert.equal(g.signal(4000).state, "reading");
	// passo 3 de 8 (depois do intervalo entre anéis)
	g.push(desired(tool("edit_file", 2, 8)), 6000);
	const s = g.signal(6000);
	assert.equal(s.state, "progress");
	assert.equal(s.progress, 3 / 8);
	assert.equal(g.signal(6000 + T.progressFlashMs).state, "coding");
});

test("passos rápidos não viram só anel: no máximo um anel por intervalo, com a fração do passo mais recente", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate", 0, 8)), 0);
	assert.equal(g.signal(0).state, "progress");
	assert.equal(g.signal(T.progressFlashMs).state, "searching");
	g.push(desired(tool("read_file", 1, 8)), 1500);
	g.push(desired(tool("edit_file", 2, 8)), 3000);
	assert.equal(g.signal(3000).state, "coding", "dentro do intervalo não acende o anel");
	// passou o intervalo entre anéis e a permanência do estado atual
	const later = T.progressCooldownMs + 200;
	g.push(desired(tool("shell", 3, 8)), later);
	const s = g.signal(later);
	assert.equal(s.state, "progress");
	assert.equal(s.progress, 4 / 8);
});

test("sem total de passos não há anel", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 2)), 0);
	assert.equal(g.signal(0).state, "reading");
	assert.equal(g.signal(0).progress, null);
});

test("falha de ferramenta: cara de erro na hora, ignora a permanência, e volta ao que fazia", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("shell")), 0);
	g.signal(0);
	g.event("failed", 200);
	assert.equal(g.signal(200).state, "failed");
	g.push(desired({ phase: "thinking" }), 300);
	assert.equal(g.signal(300).state, "failed");
	assert.equal(g.nextChangeMs(300), 200 + T.failedMs - 300);
	assert.equal(g.signal(200 + T.failedMs).state, "thinking");
});

test("fim do run: comemora e só depois volta ao repouso", () => {
	const g = createAvatarGovernor();
	g.push(desired({ phase: "writing" }), 0);
	g.signal(0);
	g.push({ state: "idle", step: null, progress: null }, 3000);
	g.event("finished", 3000);
	assert.equal(g.signal(3000).state, "finished");
	assert.equal(g.signal(3000 + T.finishedMs - 1).state, "finished");
	assert.equal(g.signal(3000 + T.finishedMs).state, "idle");
});

test("novo run depois do fim reinicia o passo (o anel acende de novo no passo 0)", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 0, 4)), 0);
	g.signal(0);
	g.push({ state: "idle", step: null, progress: null }, 10_000);
	g.signal(10_000);
	g.push(desired(tool("read_file", 0, 4)), 20_000);
	assert.equal(g.signal(20_000).state, "progress");
});

test("determinístico: mesma sequência, mesmo resultado", () => {
	const run = () => {
		const g = createAvatarGovernor();
		const out: string[] = [];
		const steps: [number, AgentActivity][] = [
			[0, { phase: "thinking" }],
			[500, tool("navigate", 0, 5)],
			[900, tool("read_file", 1, 5)],
			[3000, { phase: "writing" }],
		];
		for (const [t, a] of steps) {
			g.push(desired(a), t);
			out.push(g.signal(t).state);
		}
		for (let t = 3000; t < 8000; t += 250) out.push(g.signal(t).state);
		return out;
	};
	assert.deepEqual(run(), run());
});

test("anel que chega dentro da permanência de outro estado espera a vez em vez de ser perdido", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 0, 8)), 0);
	assert.equal(g.signal(0).state, "progress");
	g.signal(T.progressFlashMs); // volta para a ferramenta
	g.push(desired({ phase: "thinking" }), 3900);
	assert.equal(g.signal(3900).state, "thinking");
	// passo novo logo depois, ainda dentro da permanência de `thinking`
	g.push(desired(tool("edit_file", 1, 8)), 4100);
	assert.equal(g.signal(4100).state, "thinking");
	// quando a permanência acaba o anel aparece (antes era consumido sem nunca aparecer)
	const s = g.signal(3900 + T.minDwellMs);
	assert.equal(s.state, "progress");
	assert.equal(s.progress, 2 / 8);
	// o intervalo conta do anel que apareceu, não do que foi pedido
	g.signal(3900 + T.minDwellMs + T.progressFlashMs);
	g.push(desired(tool("shell", 2, 8)), 3900 + T.minDwellMs + 1000);
	assert.equal(g.signal(3900 + T.minDwellMs + 1000).state, "coding");
});

test("anel pedido que perde o sentido (a ferramenta acabou) não aparece depois", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 0, 8)), 0);
	g.signal(T.progressFlashMs);
	g.push(desired({ phase: "thinking" }), 3900);
	g.signal(3900);
	g.push(desired(tool("edit_file", 1, 8)), 4100);
	g.push(desired({ phase: "thinking" }), 4300); // sem passo: o pedido expira
	assert.equal(g.signal(3900 + T.minDwellMs + 50).state, "thinking");
});

test("pedir o usuário (waiting) entra na hora, mesmo dentro da permanência do estado anterior", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file")), 0);
	g.signal(0);
	g.push({ state: "waiting", step: null, progress: null }, 200);
	assert.equal(g.signal(200).state, "waiting");
});
