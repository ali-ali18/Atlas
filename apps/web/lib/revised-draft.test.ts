import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage } from "@workspace/shared";
import { buildSessionMessage } from "@/hooks/use-atlas-chat";
import { SimClient, SimServer } from "./chat-sim.testkit";

/**
 * "A mensagem some: ele escreve de novo e some." O run refez uma resposta que o usuário já via sendo escrita.
 * A fala refeita não pode sumir: fica recolhida como rascunho revisado, e a versão nova vem depois, inclusive
 * depois da busca do fim do run (que antes descartava todo balão ao vivo não gravado).
 */

const ASKED = "Pedi pro Bobinho montar o PDF da Semana 2 do AVA. Te aviso quando ele entregar.";
const FINAL = "Ali, ainda não há arquivo. O PDF da Semana 2 é trabalho do Bobinho.";

const revisedOf = (client: SimClient) =>
	client.screen.flatMap((m) => (m.kind === "assistant" && m.revised ? [[m.text, m.revised]] : []));

test("rascunho refeito fica visível e recolhido durante o run e depois do fim", () => {
	const server = new SimServer();
	const client = new SimClient();
	client.send("me manda o PDF da Semana 2");
	server.user("me manda o PDF da Semana 2");
	client.delta("t1-step-1", ASKED);
	client.discard("t1-step-1", "missing_file");
	assert.deepEqual(revisedOf(client), [[ASKED, "missing_file"]]);
	client.delta("t1-step-2", FINAL);
	server.assistant(FINAL);
	client.fetch(server.head, { runLive: false, resultText: FINAL });
	assert.deepEqual(revisedOf(client), [[ASKED, "missing_file"]]);
	const texts = client.screen.flatMap((m) => (m.kind === "assistant" ? [m.text] : []));
	assert.deepEqual(texts, [ASKED, FINAL]);
});

test("fala repetida (duplicate) continua saindo da tela", () => {
	const client = new SimClient();
	client.delta("t1-step-3", "Vou abrir o AVA agora.");
	client.discard("t1-step-3", "duplicate");
	assert.deepEqual(revisedOf(client), []);
	assert.equal(client.screen.some((m) => m.kind === "assistant" && m.text.trim()), false);
});

test("rascunho revisado gravado (card) volta igual ao recarregar e não duplica com o do live", () => {
	const row = buildSessionMessage({
		id: "row-9",
		conversationId: "c1",
		role: "revised-draft" as SessionMessage["role"],
		content: JSON.stringify({ v: 1, kind: "revised-draft", text: ASKED, reason: "items_open" }),
		createdAt: "2026-10-23T00:00:00.000Z",
	});
	assert.deepEqual(row, { id: "row-9", kind: "assistant", text: ASKED, revised: "items_open" });

	const server = new SimServer();
	const client = new SimClient();
	client.send("me manda o PDF da Semana 2");
	server.user("me manda o PDF da Semana 2");
	client.delta("t1-step-1", ASKED);
	client.discard("t1-step-1", "items_open");
	server.card(row!);
	client.delta("t1-step-2", FINAL);
	server.assistant(FINAL);
	client.fetch(server.head, { runLive: false, resultText: FINAL });
	assert.deepEqual(revisedOf(client), [[ASKED, "items_open"]]);
	// recarregar: só o banco, mesma tela
	const reloaded = new SimClient(server.head);
	assert.deepEqual(revisedOf(reloaded), [[ASKED, "items_open"]]);
	assert.deepEqual(reloaded.screen.flatMap((m) => (m.kind === "assistant" ? [m.text] : [])), [ASKED, FINAL]);
});
