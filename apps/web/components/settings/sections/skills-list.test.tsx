import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillDocView } from "@/lib/atlas-api";
import { SkillsListView, type SkillsListViewProps } from "./skills/skills-list-view";
import { SkillRow } from "./skills/skill-row";

Object.assign(globalThis, { React });

const noop = () => {};

function skill(over: Partial<SkillDocView> = {}): SkillDocView {
	return {
		id: "s1",
		botId: null,
		name: "relatorio-semanal",
		description: "Monta o relatório da semana",
		tools: [],
		enabled: true,
		createdBy: "user",
		status: "active",
		revision: 1,
		createdAt: "2026-10-01T12:00:00.000Z",
		updatedAt: "2026-10-06T12:00:00.000Z",
		...over,
	};
}

function renderList(props: Partial<SkillsListViewProps> = {}) {
	return renderToStaticMarkup(
		<SkillsListView
			bots={[{ id: "b1", name: "Ana" }]}
			draftsOpen={false}
			error={null}
			loading={false}
			onCreate={noop}
			onDelete={noop}
			onDeleteDrafts={noop}
			onDraftsOpenChange={noop}
			onEdit={noop}
			onExport={noop}
			onImportFile={noop}
			onQueryChange={noop}
			onRetry={noop}
			onScopeChange={noop}
			onToggle={noop}
			query=""
			scope="all"
			skills={[]}
			{...props}
		/>,
	);
}

test("lista vazia: texto orientando, busca e botões de criar/importar", () => {
	const html = renderList();
	assert.match(html, /Nenhuma habilidade ainda/);
	assert.match(html, /aria-label="Buscar habilidades"/);
	assert.match(html, /aria-label="Filtrar por escopo"/);
	assert.match(html, />Nova habilidade</);
	assert.match(html, />Importar \.md</);
});

test("lista com itens: nome, descrição, escopo, status, origem, data e switch", () => {
	const html = renderList({
		skills: [skill(), skill({ id: "s2", name: "deploy", botId: "b1", createdBy: "agent", enabled: false })],
	});
	assert.match(html, />relatorio-semanal</);
	assert.match(html, />Monta o relatório da semana</);
	assert.match(html, />Conta</);
	assert.match(html, />Ana</);
	assert.match(html, />Ativa</);
	assert.match(html, />Desativada</);
	assert.match(html, /Criada pelo agente/);
	assert.match(html, /Criada por você/);
	assert.match(html, /Atualizada em/);
	assert.match(html, /role="switch"/);
	assert.match(html, /aria-label="Desativar relatorio-semanal"/);
	assert.match(html, /aria-label="Ativar deploy"/);
	for (const label of ["Editar", "Exportar", "Apagar"]) {
		assert.match(html, new RegExp(`aria-label="${label} relatorio-semanal`));
	}
	assert.doesNotMatch(html, /Nenhuma habilidade/);
});

test("rascunhos ficam recolhidos com a contagem", () => {
	const html = renderList({
		skills: [
			skill(),
			skill({ id: "d1", name: "rep-um", status: "draft", enabled: false }),
			skill({ id: "d2", name: "rep-dois", status: "draft", enabled: false }),
		],
	});
	assert.match(html, /Rascunhos \(2\)/);
	assert.match(html, /aria-expanded="false"/);
	assert.doesNotMatch(html, /rep-um/);
	assert.match(html, />relatorio-semanal</);
});

test("rascunhos abertos (ou busca ativa) mostram as linhas", () => {
	const drafts = [skill({ id: "d1", name: "rep-um", status: "draft", enabled: false })];
	assert.match(renderList({ skills: drafts, draftsOpen: true }), />rep-um</);
	assert.match(renderList({ skills: drafts, query: "rep" }), />rep-um</);
	assert.match(renderList({ skills: drafts, draftsOpen: true }), />Rascunho</);
});

test("busca e escopo filtram; sem resultado mostra o aviso do filtro", () => {
	const skills = [skill(), skill({ id: "s2", name: "deploy", botId: "b1" })];
	const byQuery = renderList({ skills, query: "deploy" });
	assert.match(byQuery, />deploy</);
	assert.doesNotMatch(byQuery, />relatorio-semanal</);
	assert.doesNotMatch(renderList({ skills, scope: "account" }), />deploy</);
	assert.match(renderList({ skills, query: "zzz" }), /Nenhuma habilidade encontrada/);
});

test("aviso de importação: externa, rascunho, pede revisão antes de ativar", () => {
	const html = renderList({
		skills: [skill({ id: "i", name: "externa", status: "draft", enabled: false })],
		notice: skill({ id: "i", name: "externa", status: "draft", enabled: false }),
		draftsOpen: true,
	});
	assert.match(html, /data-slot="skills-import-notice"/);
	assert.match(html, /&quot;externa&quot; aguarda sua revisão/);
	assert.match(html, /arquivo externo/);
	assert.match(html, /revise o conteúdo antes de ativar/);
	assert.match(html, />Revisar</);
	assert.doesNotMatch(renderList(), /aguarda sua revisão/);
});

test("carregando e erro com nova tentativa", () => {
	assert.match(renderList({ loading: true }), /Carregando habilidades/);
	const failed = renderList({ error: "Não foi possível carregar as habilidades." });
	assert.match(failed, /role="alert"/);
	assert.match(failed, />Tentar de novo</);
});

test("cabeçalho dos rascunhos tem Apagar rascunhos (some com busca ativa) e o switch explica que publica", () => {
	const skills = [skill({ id: "d", name: "rasc", status: "draft", enabled: false })];
	const html = renderList({ skills, draftsOpen: true });
	assert.match(html, /Rascunhos \(1\)/);
	assert.match(html, />Apagar rascunhos</);
	assert.match(html, /Ativar publica este rascunho/);
	assert.match(html, /ligar o switch publica o rascunho/);
	assert.doesNotMatch(renderList({ skills, query: "rasc" }), />Apagar rascunhos</);
	assert.doesNotMatch(renderList({ skills: [skill()] }), /Apagar rascunhos/);
});

test("linha: skill do marketplace mostra origem, versão e se foi editada; publicar só em ativa", () => {
	const html = (over: Partial<SkillDocView>, onPublish?: () => void) =>
		renderToStaticMarkup(
			<SkillRow bots={[]} onDelete={noop} onEdit={noop} onExport={noop} onPublish={onPublish} onToggle={noop} skill={skill(over)} />,
		);
	const installed = html({ source: { kind: "catalog", slug: "roblox", version: "1.0.0", edited: false } }, noop);
	assert.match(installed, /Do marketplace · v1\.0\.0/);
	assert.doesNotMatch(installed, /\(editada\)/);
	assert.match(installed, /aria-label="Publicar relatorio-semanal no marketplace"/);
	assert.match(html({ source: { kind: "catalog", slug: "roblox", version: "1.0.0", edited: true } }), /v1\.0\.0 \(editada\)/);
	assert.match(html({}), /Criada por você/);
	assert.doesNotMatch(html({}), /no marketplace/);
	assert.doesNotMatch(html({ status: "draft" }, noop), /Publicar relatorio-semanal/);
});
