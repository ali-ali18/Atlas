import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "@/components/ui/templates/template-4/data";
import { ApprovalBar } from "@/components/ui/templates/template-4/chat-thread/approval-bar";
import { ApprovalMarker } from "@/components/ui/templates/template-4/chat-thread/approval-marker";
import { hasActionableDevApproval } from "./card-decision";
import { approvalBarLabel, failedApprovalDetail, approvalMarkerFor, isHiddenProtocolBubble, selectDockEntries } from "./approval-dock";

Object.assign(globalThis, { React });

const cmd = (id: string, status: "pending" | "approved" | "rejected" | "failed", command = "pnpm test"): Message => ({
	id,
	kind: "confirm",
	title: "Executar este comando?",
	status,
	confirmId: id,
	devApproval: { kind: "command", command, cwd: "/workspace", reason: "Verificador: comando fora da lista." },
});
const user = (id: string, text: string): Message => ({ id, kind: "user", text });
const relayed = (id: string, status: "pending" | "resolved", cardId = id): Message => ({
	id,
	kind: "needs-user",
	botId: "dev",
	botName: "Dev",
	title: "Dev precisa de você",
	botMessageId: `bm-${id}`,
	status,
	need: {
		type: "confirm",
		label: "Aprovar",
		cardId,
		conversationId: "c2",
		item: { handle: cardId, kind: "command", title: "Executar este comando?", options: [], devApproval: { kind: "command", command: "git push origin main", cwd: "/w" } },
	},
});

test("dock: escolhe o pedido pendente mais recente e conta N", () => {
	const messages = [cmd("a", "pending"), { id: "t", kind: "assistant", text: "oi" } as Message, cmd("b", "pending", "ls -la"), relayed("r1", "pending")];
	const entries = selectDockEntries(messages);
	assert.deepEqual(
		entries.map((entry) => entry.id),
		["b", "r1"],
		"o confirm antigo ainda pendente não é acionável",
	);
	assert.equal(entries.at(-1)?.id, "r1");
});

test("dock: confirm decidido ou segredos não entram; relay duplicado conta uma vez", () => {
	assert.equal(selectDockEntries([cmd("a", "approved")]).length, 0);
	assert.equal(selectDockEntries([{ id: "s", kind: "confirm", title: "Chaves", status: "pending", secretsRequest: {} as never }]).length, 0);
	assert.equal(selectDockEntries([relayed("r1", "pending", "card"), relayed("r2", "pending", "card"), relayed("r3", "resolved", "other")]).length, 1);
	assert.equal(selectDockEntries([]).length, 0);
});

test("dock: concorda com hasActionableDevApproval para aprovações de código", () => {
	for (const list of [[cmd("a", "pending")], [cmd("a", "pending"), cmd("b", "approved")], [cmd("a", "approved"), cmd("b", "pending")], []]) {
		assert.equal(selectDockEntries(list).length > 0, hasActionableDevApproval(list));
	}
});

test("marcador: um texto por estado, e expirado para pendente que não é o ativo", () => {
	const messages = [cmd("a", "pending", "make a"), cmd("b", "pending", "make b"), cmd("c", "approved", "make c"), cmd("d", "rejected", "make d"), user("u1", "cancela isso"), cmd("e", "rejected", "make e"), user("u2", "recusado: outro jeito")];
	const active = new Set(["b"]);
	const text = (index: number) => approvalMarkerFor(messages[index]!, active, messages.slice(index + 1))?.label;
	assert.equal(text(0), "Expirado · make a");
	assert.equal(text(1), "Aguardando aprovação · make b");
	assert.equal(text(2), "Aprovado · make c");
	assert.equal(text(3), "Dispensado · make d");
	assert.equal(text(5), "Recusado · make e");
	assert.equal(approvalMarkerFor(relayed("r", "resolved"), active)?.label, "Respondido · git push origin main");
	assert.equal(approvalMarkerFor(user("x", "oi"), active), null);
	// Thread inteira + índice dá o mesmo que a fatia (sem copiar a lista por linha).
	for (let index = 0; index < messages.length; index += 1) {
		assert.deepEqual(approvalMarkerFor(messages[index]!, active, messages, index + 1), approvalMarkerFor(messages[index]!, active, messages.slice(index + 1)));
	}
	// O índice conta: a partir de depois da recusa "make d", a decisão seguinte é a do "make e".
	assert.equal(approvalMarkerFor(messages[3]!, active, messages, 6)?.label, "Recusado · make d");
});

test("marcador: comando longo é encurtado em uma linha", () => {
	const label = approvalMarkerFor(cmd("a", "approved", `echo ${"x".repeat(200)}\nsegunda linha`), new Set())!.short;
	assert.ok(label.length <= 60);
	assert.ok(label.endsWith("…"));
	assert.ok(!label.includes("\n"));
});

test("balões de protocolo do cartão ficam escondidos; fala normal não", () => {
	for (const text of ["confirmado: Executar este comando?", "confirmado sempre: x", "recusado: faça diferente", "recusado", "cancela isso"]) {
		assert.equal(isHiddenProtocolBubble(user("u", text)), true, text);
	}
	assert.equal(isHiddenProtocolBubble(user("u", "pode confirmar isso para mim?")), false);
	assert.equal(isHiddenProtocolBubble({ id: "a", kind: "assistant", text: "confirmado: x" } as Message), false);
});

const noop = () => undefined;
const bar = (entries: ReturnType<typeof selectDockEntries>) => renderToStaticMarkup(<ApprovalBar entries={entries} onApprove={noop} onLocate={noop} onSkip={noop} />);
const write = (id: string): Message => ({ id, kind: "confirm", title: "Aplicar esta alteração?", status: "pending", confirmId: id, devApproval: { kind: "write", path: "src/x.ts", preview: "+a", added: 1, removed: 0 } });

test("barra: sem pedidos fora da tela não desenha nada", () => {
	assert.equal(bar([]), "");
});

test("barra: uma linha com alerta, rótulo curto, ✓ Executar e ✗ Agora não; sem 1 de N", () => {
	const html = bar(selectDockEntries([cmd("a", "pending", "pnpm -r build")]));
	assert.match(html, /data-approval-bar/);
	assert.match(html, /Executar · pnpm -r build/);
	assert.match(html, /aria-label="Executar"/);
	assert.match(html, /aria-label="Agora não"/);
	assert.match(html, /rounded-t-3xl/);
	assert.doesNotMatch(html, /de 2|Aprovação anterior/);
	assert.doesNotMatch(html, /Atlas/);
});

test("barra: rótulos de escrita, de cartão genérico e de outro bot", () => {
	assert.equal(approvalBarLabel(selectDockEntries([write("w")])[0]!), "Editar · src/x.ts");
	assert.equal(approvalBarLabel(selectDockEntries([relayed("r", "pending")])[0]!), "Dev: Executar · git push origin main");
	const generic: Message = { id: "g", kind: "confirm", title: "Enviar e-mail?", status: "pending" };
	assert.equal(approvalBarLabel(selectDockEntries([generic])[0]!), "Enviar e-mail?");
});

test("barra: com 2 ou mais vira pilha (frente + camadas espiando + contador), lista fechada", () => {
	const entries = selectDockEntries([relayed("r1", "pending"), relayed("r2", "pending"), relayed("r3", "pending"), relayed("r4", "pending"), relayed("r5", "pending")]);
	const html = bar(entries);
	assert.ok(html.includes("data-stacked"));
	assert.ok(html.includes("data-approval-stack-count"));
	assert.ok(html.includes(">+4<"), "contador");
	assert.equal(html.split("data-approval-stack-layer=").length - 1, 2, "no máximo 2 camadas espiando");
	assert.ok(!html.includes("data-expanded"));
	assert.ok(html.includes("grid-template-rows:0fr"), "lista recolhida");
});

test("barra: um pedido não vira pilha e não mostra contador", () => {
	const html = bar(selectDockEntries([relayed("r1", "pending")]));
	assert.ok(!html.includes("data-approval-stack-count"));
	assert.ok(!html.includes("data-approval-stack-layer"));
	assert.equal(html.split("data-approval-bar-row").length - 1, 1);
});

test("barra: a pilha de 2 tem 1 camada e a lista guarda o outro, ambos com ✓/✗", () => {
	const html = bar(selectDockEntries([cmd("a", "pending", "make a"), relayed("r1", "pending")]));
	assert.equal(html.split("data-approval-stack-layer=").length - 1, 1);
	assert.equal(html.split("data-approval-bar-row").length - 1, 2, "frente + 1 na lista");
	assert.equal(html.split('aria-label="Executar"').length - 1, 2);
});

test("barra: com a lista aberta o contador +N some", () => {
	const entries = selectDockEntries([relayed("r1", "pending"), relayed("r2", "pending"), relayed("r3", "pending")]);
	const html = renderToStaticMarkup(<ApprovalBar defaultExpanded entries={entries} onApprove={noop} onLocate={noop} onSkip={noop} />);
	assert.ok(html.includes("data-expanded"));
	assert.ok(!html.includes("data-approval-stack-count"));
	assert.equal(html.split("data-approval-bar-row").length - 1, 3);
});

test("render do marcador: recolhido por padrão (sem o comando completo), sem a palavra Atlas", () => {
	const marker = approvalMarkerFor(cmd("a", "approved", "make deploy"), new Set())!;
	const html = renderToStaticMarkup(<ApprovalMarker detail="make deploy --all" marker={marker} />);
	assert.match(html, /Aprovado · make deploy/);
	assert.doesNotMatch(html, /Atlas/i);
	assert.doesNotMatch(html, /--all/, "o comando só aparece ao expandir");
});

test("cartão substituído por um pedido mais novo aparece como Expirado, não Recusado/Dispensado", () => {
	const superseded = { ...cmd("old", "rejected", "make old"), superseded: true } as Message;
	assert.equal(approvalMarkerFor(superseded, new Set(), [])?.label, "Expirado · make old");
});

test("barra: com prefixos e onAlways a linha ganha o menu ⋮ (Permitir uma vez, Sempre neste repositório, Agora não); sem eles não", async () => {
	const { dockEntryPrefixes } = await import("./approval-dock");
	const withPrefixes = { ...cmd("p", "pending", "docker compose up"), devApproval: { kind: "command", command: "docker compose up", cwd: "/workspace", prefixes: ["docker compose"] } } as Message;
	const entries = selectDockEntries([withPrefixes]);
	assert.deepEqual(dockEntryPrefixes(entries[0]!), ["docker compose"]);
	const withMenu = renderToStaticMarkup(<ApprovalBar entries={entries} onAlways={noop} onApprove={noop} onLocate={noop} onSkip={noop} />);
	assert.match(withMenu, /data-approval-bar-more/);
	assert.match(withMenu, /aria-label="Mais opções"/);
	assert.doesNotMatch(bar(entries), /data-approval-bar-more/, "sem onAlways não há menu");
	const plain = selectDockEntries([cmd("q", "pending", "pnpm test")]);
	assert.deepEqual(dockEntryPrefixes(plain[0]!), []);
	assert.doesNotMatch(renderToStaticMarkup(<ApprovalBar entries={plain} onAlways={noop} onApprove={noop} onLocate={noop} onSkip={noop} />), /data-approval-bar-more/);
});

test("aprovado que falhou ao executar aparece como Falhou (não Recusado), com o erro no detalhe", () => {
	const failed = { ...cmd("f", "failed", "make deploy"), failureDetail: "campo obrigatório ausente: cliente" } as Message;
	const marker = approvalMarkerFor(failed, new Set(), [user("u", "cancela isso")])!;
	assert.equal(marker.status, "failed");
	assert.equal(marker.label, "Falhou · make deploy");
	const html = renderToStaticMarkup(<ApprovalMarker detail={failedApprovalDetail("Criar proposta", "campo obrigatório ausente: cliente")} marker={marker} />);
	assert.match(html, /data-approval-marker="failed"/);
	assert.equal(failedApprovalDetail("Criar proposta", "campo obrigatório ausente: cliente"), "Criar proposta\n\nFalhou: campo obrigatório ausente: cliente");
	assert.equal(failedApprovalDetail(undefined, undefined), "Falhou ao executar.");
	assert.equal(approvalMarkerFor(cmd("r", "rejected", "make x"), new Set(), [])?.label, "Recusado · make x");
});

test("dock: o cartão do plano fica na conversa (não entra no dock nem vira marcador)", () => {
	const plan: Message = {
		id: "plan-1",
		kind: "confirm",
		title: "Criar propostas",
		status: "pending",
		confirmId: "confirm-plan-r1",
		plan: { title: "Criar propostas", steps: [{ text: "Listar pedidos", kind: "read" }] },
	};
	assert.deepEqual(selectDockEntries([plan]), []);
	assert.equal(approvalMarkerFor(plan, new Set(["plan-1"])), null);
	assert.deepEqual(selectDockEntries([cmd("a", "pending"), plan]).map((entry) => entry.id), ["a"]);
});

test("aprovação por tarefa: o marcador de aprovado mostra quantas vezes a ferramenta já rodou", () => {
	const base: Extract<Message, { kind: "confirm" }> = { id: "g", kind: "confirm", title: "Google Agenda: executar create_event?", status: "approved", confirmId: "g" };
	assert.equal(approvalMarkerFor(base, new Set(), [])?.label, "Aprovado · Google Agenda: executar create_event?");
	assert.equal(approvalMarkerFor({ ...base, grantUses: 1 }, new Set(), [])?.label, "Aprovado · executado 1 vez nesta tarefa · Google Agenda: executar create_event?");
	assert.equal(approvalMarkerFor({ ...base, grantUses: 3 }, new Set(), [])?.label, "Aprovado · executado 3 vezes nesta tarefa · Google Agenda: executar create_event?");
	assert.equal(approvalMarkerFor({ ...cmd("r", "rejected", "x"), grantUses: 3 } as Message, new Set(), [])?.label, "Recusado · x");
});
