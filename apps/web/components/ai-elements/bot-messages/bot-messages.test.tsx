import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrimaryBotBadge } from "@/components/ui/templates/template-4/primary-bot-badge";
import type { BotMessage } from "@/lib/bot-thread";
import { flattenBotExchange } from "@/lib/bot-exchange";
import { BotExchangeView } from "./bot-exchange-view";
import { BotLinkMarker } from "./bot-link-marker";
import { BotThreadGroup } from "./bot-thread-group";

test("marcador: linha inteira é um botão 'Ver conversa com X', sem chevron nem texto cru", () => {
	const html = renderToStaticMarkup(
		<BotLinkMarker bot={{ id: "b1", name: "Bia", color: "#FF6700" }} direction="sent" onOpen={() => undefined} />,
	);
	assert.match(html, /Enviou mensagem para/);
	assert.match(html, /<button[^>]*aria-label="Ver conversa com Bia"/);
	assert.match(html, /cursor-pointer/);
	assert.match(html, /data-testid="bot-link-marker"/);
	assert.doesNotMatch(html, /aria-expanded|Ver mensagem/);
	// O chip dentro do botão não é outro botão.
	assert.equal((html.match(/<button/g) ?? []).length, 1);
	assert.match(html, /<svg/);
});

test("marcador de recebimento sem bot conhecido não vira botão", () => {
	const html = renderToStaticMarkup(<BotLinkMarker bot={{ name: "Caio" }} direction="received" />);
	assert.match(html, /Mensagem de/);
	assert.doesNotMatch(html, /<button/);
});

test("grupo: contagem + parceiros numa linha-botão; texto cru nunca aparece", () => {
	const messages: BotMessage[] = [
		{ id: "1", kind: "user", text: "segredo do pedido", bot: { kind: "request", fromBotId: "a", fromBotName: "Ana" } },
		{ id: "2", kind: "assistant", text: "segredo da fala", bot: { kind: "answer" } },
	];
	const html = renderToStaticMarkup(
		<BotThreadGroup
			messages={messages}
			onOpen={() => undefined}
			partners={[{ id: "a", name: "Ana" }]}
			resolveBot={(partner) => ({ id: partner.id, name: partner.name })}
		/>,
	);
	assert.match(html, /2 mensagens com/);
	assert.match(html, /aria-label="Ver conversa com Ana"/);
	assert.doesNotMatch(html, /segredo|aria-expanded/);
});

const exchangeItems = [
	{ id: "m1", rootId: "m1", fromBotId: "ana", toBotId: "bia", title: "Saldo", content: "Qual o **saldo**?", replyContent: "R$ 10", status: "replied", createdAt: "2026-01-01T10:00:00.000Z", repliedAt: "2026-01-01T10:01:00.000Z" },
];

test("conversa entre bots: título, balões nos dois lados, markdown, foco e rodapé somente leitura", () => {
	const html = renderToStaticMarkup(
		<BotExchangeView
			entries={flattenBotExchange(exchangeItems, "ana")}
			focusKey="m1:reply"
			onBack={() => undefined}
			onOpenPeer={() => undefined}
			peer={{ id: "bia", name: "Bia", color: "#FF6700" }}
			self={{ id: "ana", name: "Ana" }}
			status="ready"
		/>,
	);
	assert.match(html, /Conversa entre Ana e Bia/);
	assert.match(html, /aria-label="Voltar para a conversa"/);
	assert.match(html, /Abrir chat de Bia/);
	assert.match(html, /<strong[^>]*>saldo<\/strong>/);
	assert.match(html, /data-entry-key="m1:req"[^>]*data-side="right"/);
	assert.match(html, /data-entry-key="m1:reply"[^>]*data-focused="true"[^>]*data-side="left"/);
	assert.match(html, />Saldo</);
	assert.match(html, /Somente leitura — conversa entre os bots/);
	assert.doesNotMatch(html, /<textarea|<form/);
	assert.match(html, /--bot-accent:#[0-9a-f]{6}/i);
});

test("conversa entre bots: estados de carregando, erro e vazio", () => {
	const base = { onBack: () => undefined, peer: { name: "Bia" }, self: { name: "Ana" }, entries: [] };
	assert.match(renderToStaticMarkup(<BotExchangeView {...base} status="loading" />), /Carregando a conversa/);
	assert.match(renderToStaticMarkup(<BotExchangeView {...base} error="falhou" status="error" />), /falhou/);
	assert.match(renderToStaticMarkup(<BotExchangeView {...base} status="ready" />), /ainda não trocaram mensagens/);
	assert.doesNotMatch(renderToStaticMarkup(<BotExchangeView {...base} status="ready" />), /Abrir chat de/);
});

test("estrela só no bot principal", () => {
	const on = renderToStaticMarkup(
		<PrimaryBotBadge show size={52}>
			<span>avatar</span>
		</PrimaryBotBadge>,
	);
	assert.match(on, /aria-label="Bot principal"/);
	const off = renderToStaticMarkup(
		<PrimaryBotBadge size={52}>
			<span>avatar</span>
		</PrimaryBotBadge>,
	);
	assert.doesNotMatch(off, /Bot principal/);
	assert.match(off, /avatar/);
});

test("precisa de você (login): avatar, motivo, mesmas ações do card original e atalho para a conversa", async () => {
	const { BotNeedsUserCardView } = await import("./bot-needs-user-card");
	const need = { type: "login" as const, label: "Fazer login em login.microsoftonline.com", cardId: "c1", conversationId: "conv-b", runId: "run-b" };
	const html = renderToStaticMarkup(
		<BotNeedsUserCardView
			bot={{ id: "b1", name: "Bobinho", color: "#FF6700" }}
			need={need}
			onDone={() => undefined}
			onOpenConversation={() => undefined}
			onOpenVm={() => undefined}
			status="pending"
		/>,
	);
	assert.match(html, /Bobinho precisa de você/);
	assert.match(html, /Fazer login em login\.microsoftonline\.com/);
	assert.match(html, />Abrir a VM</);
	assert.match(html, />Terminei</);
	assert.match(html, /Abrir conversa de Bobinho/);
	assert.doesNotMatch(html, />Aprovar</);
});

test("precisa de você (aprovação): Aprovar/Recusar com os rótulos do card; resolvido vira linha discreta", async () => {
	const { BotNeedsUserCardView } = await import("./bot-needs-user-card");
	const need = { type: "confirm" as const, label: "Aprovar: Enviar e-mail", cardId: "c2", conversationId: "conv-b", confirmTitle: "Enviar e-mail", confirmLabel: "Enviar" };
	const pending = renderToStaticMarkup(
		<BotNeedsUserCardView bot={{ name: "Bobinho" }} need={need} onApprove={() => undefined} onReject={() => undefined} status="pending" />,
	);
	assert.match(pending, />Enviar</);
	assert.match(pending, />Recusar</);
	assert.doesNotMatch(pending, /Abrir a VM|Terminei/);
	const resolved = renderToStaticMarkup(<BotNeedsUserCardView bot={{ name: "Bobinho" }} need={need} status="resolved" />);
	assert.match(resolved, /resolvido/);
	assert.doesNotMatch(resolved, /<button|precisa de você/);
});

// ---- Card relayado do bot de destino e nota de decisão automática ----

import { buildBotPendingItem } from "@workspace/shared";
import { BotAutoDecisionNote } from "./bot-auto-decision-note";
import { BotRelayedCard } from "./bot-relayed-card";

const pendingConfirm = (extra: Record<string, unknown>) =>
	JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Executar este comando?", status: "pending", confirmLabel: "Executar", cancelLabel: "Pular", ...extra });

test("card relayado de comando: mesmo card de aprovação, com o rótulo 'Do bot X' e os mesmos botões", () => {
	const item = buildBotPendingItem({ rowId: "card1", role: "confirm", content: pendingConfirm({ devApproval: { kind: "command", command: "pnpm test --filter api", cwd: "/workspace", reason: "não está na lista" } }) })!;
	const html = renderToStaticMarkup(<BotRelayedCard bot={{ id: "dev", name: "Dev", color: "#6366f1" }} item={item} onApprove={() => undefined} onReject={() => undefined} />);
	assert.match(html, /data-testid="bot-relayed-label"[^>]*>.*Do bot Dev/);
	assert.match(html, /data-dev-approval/);
	assert.match(html, /pnpm test --filter api/);
	assert.match(html, />Executar</);
	assert.match(html, /aria-label="Mais opções"/);
	assert.match(html, /não está na lista/);
});

test("card relayado de ação de conector usa o card de confirmação com a prévia", () => {
	const item = buildBotPendingItem({ rowId: "card1", role: "confirm", content: pendingConfirm({ title: "Notion: executar criar página?", description: "título: Plano", confirmLabel: "Executar", cancelLabel: "Cancelar" }), intent: { action: "mcp-call", actionClass: "write" } })!;
	const html = renderToStaticMarkup(<BotRelayedCard bot={{ id: "dev", name: "Dev" }} item={item} onApprove={() => undefined} onReject={() => undefined} />);
	assert.match(html, /Do bot Dev/);
	assert.match(html, /Notion: executar criar página\?/);
	assert.match(html, /título: Plano/);
	assert.match(html, />Executar</);
	assert.match(html, />Cancelar</);
	assert.doesNotMatch(html, /data-dev-approval/);
});

test("card relayado de questionário traz as mesmas opções", () => {
	const item = buildBotPendingItem({
		rowId: "q1",
		role: "questionnaire",
		content: JSON.stringify({ v: 1, kind: "questionnaire", questionnaireId: "qq", title: "Qual ambiente?", status: "pending", items: [{ name: "env", prompt: "Ambiente", required: true, choices: [{ value: "dev" }, { value: "prod" }] }] }),
	})!;
	const html = renderToStaticMarkup(<BotRelayedCard bot={{ id: "dev", name: "Dev" }} item={item} onAnswer={() => undefined} />);
	assert.match(html, /Do bot Dev/);
	assert.match(html, /Qual ambiente\?/);
	assert.match(html, /Ambiente/);
	assert.match(html, /value="dev"/);
	assert.match(html, /value="prod"/);
});

test("nota de decisão automática: uma linha recolhida e o comando/motivo no detalhe", () => {
	const html = renderToStaticMarkup(
		<BotAutoDecisionNote decision="approved" note="Aprovado por Principal + Jev: pnpm test — roda só os testes" reason="roda só os testes" subject="pnpm test" />,
	);
	assert.match(html, /data-testid="bot-auto-decision"/);
	assert.match(html, /Aprovado por Principal \+ Jev: pnpm test — roda só os testes/);
	assert.match(html, /aria-label="Ver detalhes da decisão"/);
	assert.doesNotMatch(html, /Atlas/);
});
