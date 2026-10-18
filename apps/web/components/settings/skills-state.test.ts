import assert from "node:assert/strict";
import test from "node:test";
import type { SkillDocView } from "@/lib/atlas-api";
import { setPendingSkillDraft, takePendingSkillDraft } from "@/lib/skill-draft-handoff";
import {
	DISCARD_CONFIRM,
	DRAFT_SWITCH_HINT,
	EMPTY_SKILL_FORM,
	deleteDraftsConfirmText,
	draftScopeParams,
	draftsInScope,
	isSkillFormDirty,
	IMPORT_NOTICE,
	bodyCounterLabel,
	deleteConfirmText,
	emptyListText,
	filterSkills,
	formFromSkill,
	formatSkillDate,
	originLabel,
	parseToolsText,
	partitionSkills,
	patchSkillInList,
	scopeFilterOptions,
	scopeLabel,
	skillErrorMessage,
	statusLabel,
	togglePatch,
	validateSkillForm,
} from "./skills-state";

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

const bots = [{ id: "b1", name: "Ana" }];

test("filtro: busca sem acento/caixa em nome e descrição", () => {
	const list = [skill(), skill({ id: "s2", name: "deploy", description: "Publicação em produção" })];
	assert.deepEqual(filterSkills(list, { query: "PUBLICACAO", scope: "all" }).map((s) => s.id), ["s2"]);
	assert.deepEqual(filterSkills(list, { query: "relat", scope: "all" }).map((s) => s.id), ["s1"]);
	assert.equal(filterSkills(list, { query: "  ", scope: "all" }).length, 2);
});

test("filtro: escopo conta, bot e todos", () => {
	const list = [skill(), skill({ id: "s2", botId: "b1" }), skill({ id: "s3", botId: "b2" })];
	assert.deepEqual(filterSkills(list, { query: "", scope: "account" }).map((s) => s.id), ["s1"]);
	assert.deepEqual(filterSkills(list, { query: "", scope: "bot:b1" }).map((s) => s.id), ["s2"]);
	assert.equal(filterSkills(list, { query: "", scope: "all" }).length, 3);
});

test("rascunhos ficam separados das ativas", () => {
	const { active, drafts } = partitionSkills([skill(), skill({ id: "d", status: "draft", enabled: false })]);
	assert.deepEqual(active.map((s) => s.id), ["s1"]);
	assert.deepEqual(drafts.map((s) => s.id), ["d"]);
});

test("rótulos de escopo, status e origem", () => {
	assert.equal(scopeLabel(skill(), bots), "Conta");
	assert.equal(scopeLabel(skill({ botId: "b1" }), bots), "Ana");
	assert.equal(scopeLabel(skill({ botId: "x" }), bots), "Bot removido");
	assert.equal(statusLabel(skill()), "Ativa");
	assert.equal(statusLabel(skill({ enabled: false })), "Desativada");
	assert.equal(statusLabel(skill({ status: "draft", enabled: false })), "Rascunho");
	assert.equal(originLabel("agent"), "Criada pelo agente");
	assert.equal(originLabel("user"), "Criada por você");
	assert.deepEqual(scopeFilterOptions(bots).map((o) => o.value), ["all", "account", "bot:b1"]);
});

test("data em pt-BR e data inválida vazia", () => {
	assert.equal(formatSkillDate("2026-10-06T12:00:00.000Z", "UTC"), "06/10/2026");
	assert.equal(formatSkillDate("nope"), "");
});

test("switch: patch otimista e ativar rascunho promove a ativa", () => {
	assert.deepEqual(togglePatch({ status: "active" }, false), { enabled: false });
	assert.deepEqual(togglePatch({ status: "draft" }, true), { enabled: true, status: "active" });
	const list = [skill(), skill({ id: "s2" })];
	const next = patchSkillInList(list, "s2", { enabled: false });
	assert.equal(next[1]?.enabled, false);
	assert.equal(next[0]?.enabled, true);
	assert.equal(list[1]?.enabled, true, "não muda a lista original (rollback possível)");
});

test("validação do formulário: mensagens em pt-BR por campo", () => {
	const empty = validateSkillForm(EMPTY_SKILL_FORM);
	assert.ok(!empty.ok);
	if (!empty.ok) {
		assert.match(empty.errors.name ?? "", /obrigatório/);
		assert.match(empty.errors.description ?? "", /obrigatória/);
		assert.match(empty.errors.body ?? "", /vazio/);
	}
	const badSlug = validateSkillForm({ ...EMPTY_SKILL_FORM, name: "Relatório Semanal", description: "d", body: "b" });
	assert.ok(!badSlug.ok);
	if (!badSlug.ok) assert.match(badSlug.errors.name ?? "", /slug/);
	const long = validateSkillForm({ name: "ok", description: "x".repeat(301), body: "b", toolsText: "", botId: null });
	assert.ok(!long.ok);
	if (!long.ok) assert.match(long.errors.description ?? "", /300/);
});

test("validação ok monta o payload da API (tools em lista, bot preservado)", () => {
	const result = validateSkillForm({
		name: "deploy",
		description: "Publica",
		body: "# Passos",
		toolsText: "github, calendar, ,github",
		botId: "b1",
	});
	assert.ok(result.ok);
	if (result.ok) {
		assert.deepEqual(result.input, {
			name: "deploy",
			description: "Publica",
			body: "# Passos",
			tools: ["github", "calendar"],
			botId: "b1",
		});
	}
	assert.deepEqual(parseToolsText(" a ,b,, "), ["a", "b"]);
});

test("contador do corpo em KB e formulário a partir da skill", () => {
	assert.equal(bodyCounterLabel(""), "0,0 de 16 KB");
	assert.equal(bodyCounterLabel("a".repeat(2048)), "2,0 de 16 KB");
	const form = formFromSkill(skill({ tools: ["github", "calendar"], body: "# oi" }));
	assert.equal(form.toolsText, "github, calendar");
	assert.equal(form.body, "# oi");
});

test("erros da API viram mensagens em pt-BR", () => {
	assert.match(skillErrorMessage(Object.assign(new Error("Já existe uma skill chamada \"x\" neste escopo."), { status: 409 })), /Já existe/);
	assert.match(skillErrorMessage(Object.assign(new Error("x"), { status: 413 })), /16 KB/);
	assert.match(skillErrorMessage(Object.assign(new Error("x"), { status: 404 })), /não encontrada/);
	assert.match(skillErrorMessage(new Error("boom")), /Não foi possível/);
});

test("textos de apagar, importar e lista vazia", () => {
	assert.match(deleteConfirmText(skill()).title, /relatorio-semanal/);
	assert.match(IMPORT_NOTICE, /revise o conteúdo antes de ativar/);
	assert.match(emptyListText(0, false), /Nenhuma habilidade ainda/);
	assert.match(emptyListText(3, true), /filtro/);
	assert.equal(emptyListText(3, false), "");
});

test("handoff do card para o editor é de uso único", () => {
	assert.equal(takePendingSkillDraft(), null);
	setPendingSkillDraft({ form: { ...EMPTY_SKILL_FORM, name: "a" } });
	assert.equal(takePendingSkillDraft()?.form.name, "a");
	assert.equal(takePendingSkillDraft(), null);
});

test("guarda do editor: só há alterações a perder quando o formulário mudou", () => {
	const initial = { ...EMPTY_SKILL_FORM, name: "a", toolsText: "github, calendar" };
	assert.equal(isSkillFormDirty(initial, { ...initial }), false);
	assert.equal(isSkillFormDirty(initial, { ...initial, toolsText: "github,calendar" }), false, "espaços nas tools não contam");
	assert.equal(isSkillFormDirty(initial, { ...initial, body: "x" }), true);
	assert.equal(isSkillFormDirty(initial, { ...initial, description: "d" }), true);
	assert.equal(isSkillFormDirty(initial, { ...initial, botId: "b1" }), true);
	assert.equal(DISCARD_CONFIRM.title, "Descartar alterações?");
});

test("apagar rascunhos: conta o escopo, ignora ativas e mapeia para a rota", () => {
	const mk = (id: string, status: "draft" | "active", botId: string | null) => skill({ id, name: id, status, botId });
	const all = [mk("a", "draft", null), mk("b", "draft", "b1"), mk("c", "active", null), mk("d", "draft", "b2")];
	assert.equal(draftsInScope(all, "all").length, 3);
	assert.deepEqual(draftsInScope(all, "account").map((s) => s.id), ["a"]);
	assert.deepEqual(draftsInScope(all, "bot:b1").map((s) => s.id), ["b"]);
	assert.deepEqual(draftScopeParams("all"), {});
	assert.deepEqual(draftScopeParams("account"), { account: true });
	assert.deepEqual(draftScopeParams("bot:b1"), { botId: "b1" });
	assert.equal(deleteDraftsConfirmText(1).title, "Apagar 1 rascunho?");
	assert.equal(deleteDraftsConfirmText(3).title, "Apagar 3 rascunhos?");
	assert.equal(DRAFT_SWITCH_HINT, "Ativar publica este rascunho");
});

import { builtinsVisibleForScope, duplicateErrorMessage, filterBuiltins } from "./skills-state";

const BUILTINS = [
	{ slug: "arquivos", name: "Trabalhar com arquivos", description: "Create files.", groups: ["files"], version: 1, body: "x" },
	{ slug: "pesquisar", name: "Pesquisar na web", description: "Research.", groups: ["web"], version: 1, body: "y" },
];

test("skills de fábrica: busca por nome sem acento e some no filtro de bot", () => {
	assert.equal(filterBuiltins(BUILTINS, "").length, 2);
	assert.deepEqual(filterBuiltins(BUILTINS, "pesquisar").map((skill) => skill.slug), ["pesquisar"]);
	assert.deepEqual(filterBuiltins(BUILTINS, "ARQUIVOS").map((skill) => skill.slug), ["arquivos"]);
	assert.equal(builtinsVisibleForScope("all"), true);
	assert.equal(builtinsVisibleForScope("account"), true);
	assert.equal(builtinsVisibleForScope("bot:b1"), false);
});

test("duplicar com nome já usado explica o conflito", () => {
	assert.match(duplicateErrorMessage({ status: 409 }), /já tem uma habilidade/);
});
