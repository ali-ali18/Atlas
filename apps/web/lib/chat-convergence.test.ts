import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { rng, shuffle, SimClient, SimServer, type PersistSplit } from "./chat-sim.testkit";
import { persistedAssistantCovers } from "./thread-live";
import { createSseReplayGuard } from "./sse-replay";

/**
 * Testes embaralhados: para um estado final fixo do servidor, qualquer intercalação de envios do usuário,
 * deltas do stream (com repetição de reconexão), gravações no servidor e buscas (inclusive de réplica
 * atrasada) tem que terminar na MESMA lista ordenada, sem duplicados, e nunca violar as invariantes no meio.
 */

type World = {
	users: string[];
	/** Textos dos passos (um balão ao vivo por passo); o último é a resposta final. */
	steps: string[];
	split: PersistSplit;
	tools: boolean[];
	card: boolean;
};

const WORDS = ["alfa", "beta", "gama", "delta", "épsilon", "zeta", "eta", "teta"];

function makeWorld(random: () => number): World {
	const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
	const userCount = 1 + Math.floor(random() * 3);
	const stepCount = 1 + Math.floor(random() * 3);
	const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
	return {
		users: Array.from({ length: userCount }, (_, i) => `pergunta ${i + 1}`),
		steps: Array.from({ length: stepCount }, (_, i) => {
			const paragraphs = 1 + Math.floor(random() * 3);
			return Array.from({ length: paragraphs }, (_, p) => `Passo ${i + 1}.${p + 1}: ${words(2 + Math.floor(random() * 3))}.`).join(random() < 0.5 ? "\n\n" : "\n");
		}),
		split: pick(["none", "paragraph", "line"] as const),
		tools: Array.from({ length: stepCount }, () => random() < 0.6),
		card: random() < 0.3,
	};
}

const confirmLive: Message = { id: "cf-1", kind: "confirm", title: "Executar create_event?", status: "pending", confirmId: "cf-1" };
const confirmDb: Message = { id: "db-card", kind: "confirm", title: "Executar create_event?", status: "pending", confirmId: "cf-1" };

function chunks(text: string, random: () => number): string[] {
	const out: string[] = [];
	let at = 0;
	while (at < text.length) {
		const size = 1 + Math.floor(random() * 12);
		out.push(text.slice(at, at + size));
		at += size;
	}
	return out;
}

type ServerOp = { t: "user"; i: number } | { t: "seg"; step: number } | { t: "tool"; step: number } | { t: "final" } | { t: "card" };
type StreamOp = { id: number; delta?: { step: number; chunk: string }; card?: true };

function checkInvariants(world: World, client: SimClient, server: SimServer, sent: number, label: string) {
	const ids = client.ids;
	assert.equal(new Set(ids).size, ids.length, `${label}: ids repetidos ${ids.join(",")}`);
	// a ordem das linhas do servidor na tela é a ordem do servidor
	const serverOrder = new Map(server.rows.map((row, index) => [row.id, index]));
	const seen = client.screen.map((m) => serverOrder.get(m.id)).filter((n): n is number => n !== undefined);
	assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `${label}: linhas do servidor fora de ordem ${client.summary.join(" | ")}`);
	// cada fala do usuário aparece uma vez, na ordem de envio
	const userTexts = client.screen.filter((m) => m.kind === "user").map((m) => (m.kind === "user" ? m.text : ""));
	assert.deepEqual(userTexts, world.users.slice(0, sent).filter((text) => userTexts.includes(text)), `${label}: usuário ${userTexts.join(",")} tela=${client.summary.join(" / ")} servidor=${server.rows.map((r) => r.id + ":" + ("text" in r ? r.text : r.kind)).join(" / ")}`);
	assert.equal(userTexts.length, new Set(userTexts).size, `${label}: fala do usuário duplicada`);
	// balão ao vivo cuja fala completa já está nas linhas gravadas da tela não pode sobrar
	const persistedRows = client.screen.filter((m) => !(m.kind === "assistant" && m.id.startsWith("cu-")));
	for (const bubble of client.screen) {
		if (bubble.kind === "assistant" && bubble.id.startsWith("cu-") && bubble.text.trim()) {
			assert.equal(persistedAssistantCovers(persistedRows, bubble.text), false, `${label}: balão ao vivo duplicado "${bubble.text}" em ${client.summary.join(" | ")}`);
		}
	}
}

function runWorld(seed: number) {
	const random = rng(seed);
	const world = makeWorld(random);
	const server = new SimServer();
	const client = new SimClient();
	const finalText = world.steps[world.steps.length - 1]!;

	// fila do servidor: usuário 1 primeiro; os demais entram no meio dos passos, em ordem
	const ops: ServerOp[] = [{ t: "user", i: 0 }];
	const body: ServerOp[] = [];
	world.steps.forEach((_, step) => {
		if (step === world.steps.length - 1) return;
		body.push({ t: "seg", step });
		if (world.tools[step]) body.push({ t: "tool", step });
	});
	if (world.card) body.push({ t: "card" });
	for (let i = 1; i < world.users.length; i += 1) body.splice(Math.floor(random() * (body.length + 1)), 0, { t: "user", i });
	// os usuários extras continuam em ordem relativa
	const userSlots = body.map((op, idx) => (op.t === "user" ? idx : -1)).filter((idx) => idx >= 0);
	userSlots.forEach((slot, n) => (body[slot] = { t: "user", i: n + 1 }));
	ops.push(...body, { t: "final" });

	// stream: deltas por passo (+ cartão ao vivo), numerados; reconexão repete um trecho já entregue
	const stream: StreamOp[] = [];
	let nextId = 0;
	world.steps.forEach((text, step) => {
		for (const chunk of chunks(text, random)) stream.push({ id: ++nextId, delta: { step, chunk } });
		if (world.card && step === 0) stream.push({ id: ++nextId, card: true });
	});
	const delivered: StreamOp[] = [];
	for (let at = 0; at < stream.length; at += 1) {
		delivered.push(stream[at]!);
		if (random() < 0.15) delivered.push(...stream.slice(Math.max(0, at - Math.floor(random() * 4)), at + 1));
	}

	const guard = createSseReplayGuard(0);
	let sent = 0;
	let serverDone = 0;
	let userWritten = 0;
	let streamAt = 0;
	const trace: string[] = [];
	const label = (action: string) => {
		trace.push(action);
		return `seed=${seed} ${trace.join(" > ")}`;
	};

	const stepsLeft = () => sent < world.users.length || serverDone < ops.length || streamAt < delivered.length;
	let guardCount = 0;
	while (stepsLeft() && guardCount++ < 500) {
		const choices: Array<() => void> = [];
		if (sent < world.users.length) {
			choices.push(() => {
				client.send(world.users[sent]!);
				sent += 1;
				checkInvariants(world, client, server, sent, label("send"));
			});
		}
		const next = ops[serverDone];
		if (next && (next.t !== "user" || next.i < sent)) {
			choices.push(() => {
				if (next.t === "user") {
					server.user(world.users[next.i]!);
					userWritten += 1;
				} else if (next.t === "seg") server.assistant(world.steps[next.step]!, world.split);
				else if (next.t === "tool") server.tool("web_search", `resultado ${next.step}`);
				else if (next.t === "card") server.card(confirmDb);
				else server.assistant(finalText, world.split);
				serverDone += 1;
			});
		}
		if (streamAt < delivered.length && userWritten > 0 && sent > 0) {
			choices.push(() => {
				const op = delivered[streamAt++]!;
				if (!guard.accept(op.id)) return;
				if (op.delta) client.delta(`s${op.delta.step}`, op.delta.chunk);
				else if (op.card) client.liveCard(confirmLive);
				checkInvariants(world, client, server, sent, label(`stream#${op.id}`));
			});
		}
		// busca do fim da conversa em qualquer momento; réplica atrasada às vezes
		if (random() < 0.45) {
			choices.push(() => {
				const behind = random() < 0.3 ? Math.floor(random() * 3) : 0;
				const index = server.snapshots.length - 1 - behind;
				const runLive = serverDone < ops.length ? random() < 0.8 : random() < 0.3;
				client.fetch(server.stale(index), { runLive, resultText: !runLive && random() < 0.5 ? finalText : null });
				checkInvariants(world, client, server, sent, label(`fetch(live=${runLive},behind=${behind})`));
			});
		}
		shuffle(choices, random)[0]!();
	}
	assert.ok(guardCount < 500, `seed=${seed}: não terminou`);
	// fim: o cliente faz uma última busca com o servidor atual e sem run vivo
	client.fetch(server.head, { runLive: false, resultText: finalText });
	assert.deepEqual(client.ids, server.head.map((m) => m.id), `seed=${seed} convergência: ${client.summary.join(" | ")}`);
	// idempotente: repetir a busca (ou o hub avisando de novo) não muda nada
	const before = client.ids;
	client.fetch(server.head, { runLive: false });
	client.fetch(server.head, { runLive: false, resultText: finalText });
	assert.deepEqual(client.ids, before, `seed=${seed} idempotência`);
}

test("embaralhado: 2000 intercalações de envio, stream (com replay), gravação e busca convergem para a lista do servidor", () => {
	for (let seed = 1; seed <= 2000; seed += 1) runWorld(seed);
});
