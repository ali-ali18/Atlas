import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LLM_TIMEOUT_PRESET_VALUES, type EffectiveAccountConfig } from "@workspace/shared";
import { contextEconomyPatch, contextMemoryOptions, contextMemoryPatch, reactionOnlyPatch } from "../jev-execution-state";
import { AccountAutonomyGroup, ExecutionSettingsView } from "./execution";

Object.assign(globalThis, { React });

function effective(execution: Record<string, unknown> = {}, sandboxAutoStart: unknown = { value: true, source: "default" }): EffectiveAccountConfig {
	return {
		execution: {
			discipline: { value: true, source: "default" },
			contextEconomy: { value: true, source: "default" },
			reactionOnly: { value: true, source: "default" },
			contextMemory: { value: "standard", source: "default" },
			llmTimeouts: { value: LLM_TIMEOUT_PRESET_VALUES.default, source: "default" },
			maxOutputTokens: { value: undefined, source: "default" },
			maxSteps: { value: undefined, source: "default" },
			maxWallMinutes: { value: undefined, source: "default" },
			toolResultMaxChars: { value: undefined, source: "default" },
			maxRunCostUsd: { value: undefined, source: "default" },
			...execution,
		},
		sandboxAutoStart,
	} as unknown as EffectiveAccountConfig;
}

function render(props: Partial<React.ComponentProps<typeof ExecutionSettingsView>> = {}) {
	return renderToStaticMarkup(
		<ExecutionSettingsView
			effective={effective()}
			onChange={() => {}}
			onSandboxChange={() => {}}
			status="idle"
			{...props}
		/>,
	);
}

test("Execução: um controle por configuração, cada um com rótulo acessível", () => {
	const html = render();
	for (const [id, label] of [
		["settings-exec-discipline", "Disciplina de execução"],
		["settings-exec-context-economy", "Economia de contexto"],
		["settings-exec-context-memory", "Memória da conversa"],
		["settings-exec-reaction-only", "Responder só com reação quando não precisa de resposta"],
		["settings-exec-timeout", "Paciência com o modelo"],
		["settings-exec-maxOutputTokens", "Tamanho máximo da resposta"],
		["settings-exec-toolResultMaxChars", "Tamanho máximo do resultado de ferramentas"],
		["settings-exec-maxSteps", "Limite de passos"],
		["settings-exec-maxWallMinutes", "Limite de tempo"],
		["settings-exec-sandbox", "Iniciar o navegador automaticamente"],
	]) {
		assert.match(html, new RegExp(`for="${id}"[^>]*>${label}<`));
		assert.match(html, new RegExp(`id="${id}"`));
	}
	// 7 dropdowns (memória, paciência, resposta, resultado, passos, tempo, custo); a autonomia ainda carrega.
	assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 7);
	assert.equal((html.match(/role="switch"/g) ?? []).length, 4);
});

test("Execução: herdando, cada dropdown mostra a origem e o valor", () => {
	const html = render();
	assert.match(html, /Herdar \(padrão\)/, "paciência");
	assert.match(html, /Herdar \(sem limite\)/, "tamanho da resposta");
	assert.match(html, /Herdar \(300 passos\)/);
	assert.match(html, /Herdar \(30 min\)/);
	const fromServer = render({
		effective: effective({ maxOutputTokens: { value: 8192, source: "env" }, llmTimeouts: { value: LLM_TIMEOUT_PRESET_VALUES.short, source: "env" } }),
	});
	assert.match(fromServer, /Herdar \(8k tokens\)/);
	assert.match(fromServer, /Herdar \(curto\)/);
});

test("Execução: valor do usuário aparece escolhido, sem 'Herdar (valor)'", () => {
	const html = render({
		effective: effective({
			maxSteps: { value: 25, source: "user" },
			llmTimeouts: { value: LLM_TIMEOUT_PRESET_VALUES.extended, source: "user" },
		}),
	});
	assert.match(html, />25 passos</);
	assert.match(html, />Estendido</);
	assert.doesNotMatch(html, /Herdar \(300 passos\)/);
});

test("Execução: switches mostram o padrão herdado; do usuário trazem 'Voltar ao padrão' (só a disciplina)", () => {
	const inherited = render({ effective: effective({ discipline: { value: false, source: "env" } }) });
	assert.match(inherited, /Padrão do servidor: desligado/);
	assert.match(inherited, /Padrão da conta: ligado/, "navegador");
	assert.doesNotMatch(inherited, /Voltar ao padrão/);
	const own = render({
		effective: effective({ discipline: { value: false, source: "user" } }, { value: false, source: "user" }),
	});
	assert.equal((own.match(/Voltar ao padrão/g) ?? []).length, 1, "o navegador (coluna) não limpa");
});

test("Execução: economia de contexto é um switch que salva e volta ao padrão", () => {
	const inherited = render({ effective: effective({ contextEconomy: { value: false, source: "env" } }) });
	assert.match(inherited, /Padrão do servidor: desligado/);
	const own = render({ effective: effective({ contextEconomy: { value: false, source: "user" } }) });
	assert.equal((own.match(/Voltar ao padrão/g) ?? []).length, 1);
	assert.deepEqual(contextEconomyPatch(false), { execution: { contextEconomy: false } });
});

test("Execução: memória da conversa começa em Padrão, explica a escolha e salva economy", () => {
	const html = render();
	assert.match(html, />Padrão</);
	assert.match(html, /Resume perto do limite do modelo/);
	assert.match(contextMemoryOptions()[0]!.description!, /Melhor qualidade; conversas longas custam mais./);
	assert.doesNotMatch(html, /custo parecido/);
	const economy = render({ effective: effective({ contextMemory: { value: "economy", source: "user" } }) });
	assert.match(economy, />Econômico</);
	assert.match(economy, /Enxuga cedo para gastar menos/);
	assert.match(contextMemoryOptions()[1]!.description!, /Pode esquecer detalhes de conversas longas./);
	// Config antiga sem o campo na resposta: Padrão.
	const legacy = render({ effective: effective({ contextMemory: undefined }) });
	assert.match(legacy, />Padrão</);
	assert.deepEqual(contextMemoryOptions().map((option) => option.value), ["standard", "economy"]);
	assert.deepEqual(contextMemoryPatch("economy"), { execution: { contextMemory: "economy" } });
	assert.doesNotMatch(html, /atlas/i);
});

test("Execução: a autonomia saiu da tela (vai para Geral) e o grupo se chama Execução", () => {
	const html = render();
	assert.doesNotMatch(html, /Carregando autonomia/);
	assert.match(html, /<h3[^>]*>Execução<\/h3>/);
	assert.match(render({ title: "Navegador" }), /<h3[^>]*>Navegador<\/h3>/);
});

test("Autonomia padrão: linha no grupo Autonomia, com a conta carregando", () => {
	const html = renderToStaticMarkup(<AccountAutonomyGroup />);
	assert.match(html, /<h3[^>]*>Autonomia<\/h3>/);
	assert.match(html, /Carregando autonomia…/);
	assert.equal(renderToStaticMarkup(<AccountAutonomyGroup isVisible={() => false} />), "");
});

test("Execução: carregando desabilita; erro de carga e de salvar são alertas", () => {
	const loading = render({ effective: null });
	assert.match(loading, /Carregando…/);
	assert.match(render({ effective: null, loadError: "Não foi possível carregar as configurações." }), /role="alert"[^>]*>Não foi possível carregar/);
	assert.match(render({ status: "error", saveError: "Use um inteiro de 1 a 100." }), /role="alert"[^>]*>Use um inteiro/);
});

test("Execução: a busca esconde o que não casou", () => {
	const html = render({ isVisible: (id) => id === "execucao.passos" });
	assert.match(html, /Limite de passos/);
	assert.doesNotMatch(html, /Disciplina de execução|Paciência|Autonomia|navegador/);
});

test("Execução: custo máximo por execução renderiza com label e descrição", () => {
	const html = render();
	assert.match(html, /Custo máximo por execução/);
	assert.match(html, /Sem limite por padrão/);
	assert.match(html, /id="settings-exec-maxRunCostUsd"/);
});

test("Responder só com reação: ligado por padrão, desligar manda o patch e voltar ao padrão limpa a chave", () => {
	const on = render();
	assert.match(on, /id="settings-exec-reaction-only"[^>]*checked=""/);
	const off = render({ effective: effective({ reactionOnly: { value: false, source: "user" } }) });
	assert.match(off, /Voltar ao padrão/);
	assert.deepEqual(reactionOnlyPatch(false), { execution: { reactionOnly: false } });
});
