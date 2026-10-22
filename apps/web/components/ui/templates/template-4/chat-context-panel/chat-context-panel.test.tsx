import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Routine } from "../data";
import { ChatContextPanel, SleepingComputer } from "./chat-context-panel";
import { MenuIcon, RoutineCard } from "./routine-card";
import { botAccentStyle } from "./bot-accent";
import { buildRoutineMenu } from "./routine-actions";
import { HistoryList } from "./routine-dialogs";
import { WebhookSection } from "./webhook-fields";

Object.assign(globalThis, { React });

const agent: Agent = {
	color: "#6366f1",
	id: "bot-1",
	name: "Zeca Teste",
	snippet: "",
	time: "",
};

const hookRoutine: Routine = {
	id: "r-1",
	name: "Rotina webhook",
	instruction: "Faça algo",
	model: "m",
	active: true,
	triggerKind: "event",
	triggers: [{ id: "webhook", text: "Webhook" }],
	hook: { hookKey: "k", url: "https://x.test/v1/hooks/k" },
};

function panel(props: Partial<React.ComponentProps<typeof ChatContextPanel>> = {}) {
	return renderToStaticMarkup(
		<ChatContextPanel agent={agent} onUpdate={() => {}} {...props} />,
	);
}

test("topo só tem botão de fechar quando não há como abrir configurações", () => {
	const html = panel();
	assert.match(html, /info-pane__top/);
	assert.match(html, /aria-label="Fechar painel"/);
	assert.doesNotMatch(html, /aria-label="Voltar"/);
	assert.doesNotMatch(html, /aria-label="Configurações do bot"/);
	assert.match(html, /aria-label="Redimensionar painel"/);
	assert.match(html, /--info-pane-width/);
});

test("engrenagem no topo da visão geral abre as configurações do bot, antes do X", () => {
	const html = panel({ onOpenSettings: () => {} });
	assert.match(html, /aria-label="Configurações do bot"/);
	assert.match(html, /data-info-row="settings"/);
	assert.ok(html.indexOf('aria-label="Configurações do bot"') < html.indexOf('aria-label="Fechar painel"'));
	assert.doesNotMatch(html, /aria-label="Voltar"/);
});

test("grupo de bots não tem engrenagem (o painel é de membros e detalhes do grupo)", () => {
	const html = panel({
		onOpenSettings: () => {},
		group: { members: [], candidates: [], onRename: () => {}, onOpenMember: () => {}, onAddMember: () => {}, onRemoveMember: () => {}, onDelete: () => {} } as never,
	});
	assert.doesNotMatch(html, /aria-label="Configurações do bot"/);
});

test("cabeçalho do bot: avatar, nome em negrito e rótulo editáveis ali mesmo (sem abrir configurações)", () => {
	const html = panel({ onOpenSettings: () => {} });
	assert.doesNotMatch(html, /aria-label="Abrir configurações do bot"/);
	assert.match(html, /font-bold[^>]*>Zeca Teste</);
	assert.match(html, /title="Clique para editar o nome"/);
	assert.match(html, />Adicionar um rótulo</);
	const labelled = panel({ agent: { ...agent, snippet: "Dev backend" } });
	assert.match(labelled, />Dev backend</);
	assert.doesNotMatch(labelled, /Adicionar um rótulo/);
});

test("Sobre saiu da visão geral: a descrição se edita nas configurações (engrenagem)", () => {
	const html = panel({ agent: { ...agent, description: "Cuida do financeiro" }, onOpenSettings: () => {} });
	assert.doesNotMatch(html, /data-about/);
	assert.doesNotMatch(html, />Sobre</);
	assert.doesNotMatch(html, /Cuida do financeiro/);
	assert.match(html, /aria-label="Configurações do bot"/);
});

test("abas Detalhes | Biblioteca | Computador, Detalhes por padrão", () => {
	const html = panel();
	assert.match(html, />Detalhes</);
	assert.match(html, />Biblioteca</);
	assert.match(html, />Computador</);
	assert.match(html, /Rotinas/);
	assert.match(html, /Criar rotina/);
	assert.doesNotMatch(html, /O computador está dormindo/);
});

test("aba Biblioteca mostra o estado vazio", () => {
	const html = panel({ initialTab: "library" });
	assert.match(html, /As páginas, os arquivos e os apps que este Bot cria aparecem aqui/);
	assert.doesNotMatch(html, /Criar rotina/);
});

test("aba Computador dormindo mostra Acordar e a legenda", () => {
	const html = panel({ initialTab: "computer", onStartSandbox: () => {} });
	assert.match(html, /O computador está dormindo/);
	assert.match(html, />Acordar</);
	assert.match(html, /z z/);
	assert.match(html, />Tela de Zeca Teste</);
});

test("aba Computador ligada mostra o viewer e não o estado dormindo", () => {
	const html = panel({ initialTab: "computer", sandboxViewerUrl: "https://v.test" });
	assert.match(html, /aria-label="Abrir tela do sandbox"/);
	assert.doesNotMatch(html, /O computador está dormindo/);
});

test("SleepingComputer desabilita Acordar sem handler e mostra Acordando… ocupado", () => {
	assert.match(renderToStaticMarkup(<SleepingComputer agent={agent} />), /disabled=""/);
	assert.match(renderToStaticMarkup(<SleepingComputer agent={agent} busy onWake={() => {}} />), /Acordando…/);
});

test("SleepingComputer mostra Reiniciando a VM… e, após falha, a mensagem com Tentar de novo", () => {
	assert.match(renderToStaticMarkup(<SleepingComputer agent={agent} busy restarting onWake={() => {}} />), /Reiniciando a VM…/);
	const failed = renderToStaticMarkup(<SleepingComputer agent={agent} error="A VM não quis ligar agora." onWake={() => {}} />);
	assert.match(failed, />Tentar de novo</);
	assert.match(failed, /A VM não quis ligar agora./);
	assert.doesNotMatch(failed, /Atlas/);
});

test("a cor do avatar vira --bot-accent no painel", () => {
	assert.match(panel(), /--bot-accent:#[0-9a-f]{6}/);
	assert.doesNotMatch(panel({ agent: { ...agent, color: "nao-e-cor" } }), /--bot-accent/);
});

test("configurações do bot abrem como subvisão com voltar, título Configurações e fechar", () => {
	const html = panel({ view: "settings", onOpenSettings: () => {} });
	assert.match(html, /aria-label="Voltar"/);
	assert.match(html, />Configurações</);
	assert.match(html, /aria-label="Fechar painel"/);
	assert.doesNotMatch(html, /aria-label="Configurações do bot"/, "sem engrenagem dentro da vista");
	assert.doesNotMatch(html, />Biblioteca</);
	assert.match(html, /data-about/, "a descrição do bot (Sobre) mora nas configurações");
});

test("cards de rotina: nome, resumo, toggle com aria-label e botão …", () => {
	const html = panel({
		routines: [hookRoutine],
		isRoutinePersisted: () => true,
		onToggleRoutine: async () => null,
	});
	assert.match(html, /data-routine-card="r-1"/);
	assert.match(html, />Rotina webhook</);
	assert.match(html, />Webhook</);
	assert.match(html, /aria-label="Pausar Rotina webhook, Webhook"/);
	assert.match(html, /aria-label="Mais ações de Rotina webhook"/);
	assert.match(html, /aria-label="Criar rotina"/);
});

test("card pausado oferece Retomar; rascunho mostra o selo e bloqueia o toggle", () => {
	const paused = renderToStaticMarkup(
		<RoutineCard persisted routine={{ ...hookRoutine, active: false }} />,
	);
	assert.match(paused, /aria-label="Retomar Rotina webhook, Webhook"/);
	const draft = renderToStaticMarkup(
		<RoutineCard persisted={false} routine={hookRoutine} />,
	);
	assert.match(draft, /Rascunho/);
	assert.match(draft, /data-disabled/);
});

test("webhook sem secret: campos com placeholder e Gerar nova chave", () => {
	const html = renderToStaticMarkup(
		<WebhookSection canRotate onRotate={() => {}} url="https://x.test/v1/hooks/k" />,
	);
	assert.match(html, /POST para/);
	assert.match(html, /segredo/);
	assert.match(html, /cabeçalho/);
	assert.match(html, /https:\/\/x\.test\/v1\/hooks\/k/);
	assert.match(html, /Segredo oculto/);
	assert.match(html, /Gerar novo segredo/);
	assert.doesNotMatch(html, /URL com chave/);
	assert.doesNotMatch(html, /secret=/);
	assert.doesNotMatch(html, /data-url-secret-warning/);
});

test("webhook sem URL ainda mostra Carregando…", () => {
	assert.match(renderToStaticMarkup(<WebhookSection canRotate={false} />), /Carregando…/);
});

test("webhook com secret: cabeçalho X-Atlas-Hook-Secret, URL SEM o segredo e aviso", () => {
	const html = renderToStaticMarkup(
		<WebhookSection canRotate secret="s3cr3t" url="https://x.test/v1/hooks/k" />,
	);
	assert.match(html, /X-Atlas-Hook-Secret: s3cr3t/);
	assert.doesNotMatch(html, /secret=s3cr3t/);
	assert.doesNotMatch(html, /URL com chave/);
	assert.match(html, /não aparece de novo/);
	assert.match(html, /A URL não leva o segredo/);
});

test("webhook que ainda usa ?secret= na URL mostra o aviso para preferir o cabeçalho", () => {
	const html = renderToStaticMarkup(
		<WebhookSection canRotate url="https://x.test/v1/hooks/k" urlSecretAt="2026-10-15T10:00:00Z" />,
	);
	assert.match(html, /data-url-secret-warning/);
	assert.match(html, /Prefira o cabeçalho/);
});

test("histórico lista status e motivo", () => {
	const html = renderToStaticMarkup(
		<HistoryList
			runs={[
				{ id: "1", status: "skipped", triggeredBy: "event", error: "ocupado", createdAt: null },
			] as never}
		/>,
	);
	assert.match(html, /pulada · ocupado/);
	assert.match(renderToStaticMarkup(<HistoryList runs={[]} />), /Nenhuma execução ainda/);
});

test("menu da rotina: todos os itens têm ícone", () => {
	const items = buildRoutineMenu({ active: true, persisted: true, kind: "github", running: false });
	const withWebhook = buildRoutineMenu({ active: false, persisted: true, kind: "webhook", running: false });
	for (const list of [items, withWebhook]) {
		for (const item of list) {
			const html = renderToStaticMarkup(<MenuIcon id={item.id} resume={item.label === "Retomar"} />);
			assert.match(html, /<svg/, `item ${item.id} sem ícone`);
		}
	}
	assert.match(renderToStaticMarkup(<MenuIcon id="toggle" resume={false} />), /lucide-pause/);
	assert.match(renderToStaticMarkup(<MenuIcon id="toggle" resume />), /lucide-play/);
	assert.match(renderToStaticMarkup(<MenuIcon id="history" resume={false} />), /lucide-history/);
	assert.match(renderToStaticMarkup(<MenuIcon id="webhook" resume={false} />), /lucide-webhook/);
});

test("campos do webhook cabem no diálogo: colunas minmax(0,1fr) e textos quebram", () => {
	const html = renderToStaticMarkup(<WebhookSection canRotate url="https://x.test/v1/hooks/k" secret="abc" onRotate={() => {}} />);
	assert.match(html, /grid-cols-\[minmax\(0,1fr\)_3rem\]/);
	assert.match(html, /w-full min-w-0/);
	assert.doesNotMatch(html, /<p[^>]*whitespace-nowrap/);
	assert.match(html, /break-words/);
});

test("accent do bot vira variáveis CSS (e some sem cor válida)", () => {
	const style = botAccentStyle("#6366f1");
	assert.equal(style["--bot-accent"], "#6366f1");
	assert.equal(style["--bot-accent-foreground"], "#ffffff");
	assert.deepEqual(botAccentStyle(undefined), {});
});

test("painel no celular: gaveta lateral com fundo escurecido e desfocado que fecha ao tocar", () => {
	const out = panel({ onClosePanel: () => {} });
	assert.match(out, /data-slot="info-pane-backdrop"/);
	assert.match(out, /bg-black\/40/);
	assert.match(out, /backdrop-blur-sm/);
	assert.match(out, /lg:hidden/);
	assert.match(out, /max-lg:w-\[88%\]!/);
});

test("painel fechado ou em subtela cheia (configurações): sem fundo, a tela é cheia", () => {
	assert.doesNotMatch(panel({ open: false }), /info-pane-backdrop/);
	const settings = panel({ view: "settings" });
	assert.doesNotMatch(settings, /info-pane-backdrop/);
	assert.match(settings, /max-lg:inset-0/);
});
