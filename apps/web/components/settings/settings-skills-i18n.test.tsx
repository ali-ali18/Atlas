import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { BuiltinSkillView, SkillDocView } from "@/lib/atlas-api";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { renderIn } from "./settings-i18n-render";
import { EMPTY_SKILL_FORM, bodyCounterLabel, deleteDraftsConfirmText, skillErrorMessage, validateSkillForm } from "./skills-state";
import { BuiltinSkillDetail } from "./sections/skills/builtin-skill-view";
import { SkillEditorView } from "./sections/skills/skill-editor-view";
import { SkillsListView } from "./sections/skills/skills-list-view";

Object.assign(globalThis, { React });

const noop = () => {};
const skill = (over: Partial<SkillDocView> = {}): SkillDocView => ({
	id: "s1", botId: null, name: "weekly-report", description: "Builds the weekly report", tools: [], enabled: true, createdBy: "agent", status: "active",
	revision: 1, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-06T12:00:00.000Z", ...over,
});
const tr = async (locale: "en-US" | "es-ES") => createTranslator(locale, await loadMessages(locale));
const listProps = {
	bots: [], draftsOpen: false, error: null, loading: false, onCreate: noop, onDelete: noop, onDeleteDrafts: noop, onDraftsOpenChange: noop, onEdit: noop,
	onExport: noop, onImportFile: noop, onQueryChange: noop, onRetry: noop, onScopeChange: noop, onToggle: noop, query: "", scope: "all",
};

test("Habilidades em inglês: lista, linha e aviso de importação", async () => {
	const html = await renderIn("en-US", <SkillsListView {...listProps} notice={skill({ status: "draft", enabled: false })} skills={[skill(), skill({ id: "s2", name: "draft-one", status: "draft", enabled: false })]} />);
	assert.match(html, /aria-label="Search skills"/);
	assert.match(html, /New skill/);
	assert.match(html, /Import \.md/);
	assert.match(html, /Created by the agent/);
	assert.match(html, /Updated on 10\/06\/2026/);
	assert.match(html, /Drafts \(1\)/);
	assert.match(html, /is waiting for your review/);
	assert.match(html, /aria-label="Edit weekly-report"/);
	assert.doesNotMatch(html, /Nova habilidade|Rascunhos|Atualizada/);
	assert.match(await renderIn("en-US", <SkillsListView {...listProps} skills={[]} />), /No skills yet/);
});

test("Editor e detalhe de fábrica em espanhol", async () => {
	const html = await renderIn("es-ES", <SkillEditorView bots={[]} errors={{ name: "x" }} form={EMPTY_SKILL_FORM} mode="create" onCancel={noop} onChange={noop} onSave={noop} onTabChange={noop} tab="edit" />);
	assert.match(html, /Nueva habilidad/);
	assert.match(html, /Herramientas sugeridas \(opcional\)/);
	assert.match(html, /placeholder="informe-semanal"/);
	assert.match(html, />Vista previa</);
	assert.match(html, /0,0 de 16 KB/);
	const builtin = await renderIn("es-ES", <BuiltinSkillDetail onBack={noop} onDuplicate={noop} skill={{ slug: "x", name: "X", description: "", body: "# hi" } as BuiltinSkillView} />);
	assert.match(builtin, /Duplicar para editar/);
	assert.match(builtin, />De fábrica</);
});

test("estado das habilidades: erros do shared e da API por idioma", async () => {
	const en = await tr("en-US");
	const checked = validateSkillForm({ ...EMPTY_SKILL_FORM, name: "Bad Name", description: "ok", body: "" }, en);
	assert.equal(checked.ok, false);
	if (!checked.ok) {
		assert.match(checked.errors.name ?? "", /must be a slug/);
		assert.equal(checked.errors.body, "The skill body can't be empty.");
	}
	assert.equal(skillErrorMessage({ status: 404 }, en), "Skill not found. It may have been deleted.");
	assert.equal(deleteDraftsConfirmText(3, en).title, "Delete 3 drafts?");
	assert.equal(bodyCounterLabel("a".repeat(2048), en), "2.0 of 16 KB");
});
