import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { UiLocale } from "@/lib/i18n/locales";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { createTranslator } from "@/lib/i18n/translator";
import { addDropdownRows } from "./chat-add-dropdown";
import { AddMenuPanel, type AddMenuPanelProps } from "./chat-add-menu";
import { ComposerFileAttachments } from "./composer-file-attachments";
import { MentionPopup } from "./mention-popup";
import { permissionOptionLabel } from "./permission-copy";
import { SecretPasteNotice } from "./secret-paste-notice";

Object.assign(globalThis, { React });

const panel: AddMenuPanelProps = {
	step: "root",
	onStep: () => undefined,
	onClose: () => undefined,
	onPickPhotos: () => undefined,
	showTestPr: true,
	onTestPr: () => undefined,
	onPickSkill: () => undefined,
	skills: [{ id: "s1", name: "Summarize", slug: "summarize", description: "", factory: false }],
	skillsLoading: false,
	permission: { mode: "auto", onChange: () => undefined },
	showClose: true,
};

async function render(locale: UiLocale, node: React.ReactNode): Promise<string> {
	return renderToStaticMarkup(
		<I18nProvider locale={locale} messages={await loadMessages(locale)}>
			{node}
		</I18nProvider>,
	);
}

test("menu + em en-US: cabeçalho, tiles, linhas e passos de habilidades e permissão", async () => {
	const root = await render("en-US", <AddMenuPanel {...panel} onTakePhoto={() => undefined} />);
	for (const text of [">Add<", ">Camera<", ">Photos<", ">Test a PR<", ">Skill<", ">Permission<", ">Automatic<"]) assert.ok(root.includes(text), text);
	assert.match(root, /aria-label="Close"/);
	const skills = await render("en-US", <AddMenuPanel {...panel} step="skills" />);
	assert.match(skills, /My skills/);
	assert.match(skills, /aria-label="Back"/);
	const permission = await render("en-US", <AddMenuPanel {...panel} step="permission" />);
	assert.match(permission, /Automatic \(recommended\)/);
	assert.match(permission, /Always ask/);
	assert.doesNotMatch(permission, /recomendado|Perguntar sempre/);
});

test("menu + em es-ES e linhas do dropdown por idioma", async () => {
	const root = await render("es-ES", <AddMenuPanel {...panel} onTakePhoto={() => undefined} />);
	for (const text of [">Añadir<", ">Cámara<", ">Fotos<", ">Probar una PR<", ">Habilidad<", ">Permiso<"]) assert.ok(root.includes(text), text);
	const { t } = createTranslator("en-US", await loadMessages("en-US"));
	assert.deepEqual(addDropdownRows({ onPickFile: () => undefined, showTestPr: true, permission: { mode: "allowlist", onChange: () => undefined } }, t), [
		"Photos",
		"File",
		"Test a PR",
		"Skill",
		"Permission: Allowed list",
	]);
	assert.equal(permissionOptionLabel(t, "auto"), "Automatic (recommended)");
});

test("menções, anexos e aviso de segredo no idioma da tela", async () => {
	const mention = await render("en-US", <MentionPopup activeIndex={0} candidates={[]} onPick={() => undefined} trigger="/" />);
	assert.match(mention, /aria-label="Choose a skill"/);
	assert.match(mention, /No skills/);
	const apps = await render(
		"es-ES",
		<MentionPopup
			activeIndex={0}
			candidates={[{ id: "a", name: "Gmail", kind: "app", connected: false }, { id: "b", name: "Ana", kind: "bot", isPrimary: true }]}
			onPick={() => undefined}
		/>,
	);
	assert.match(apps, /Conectar/);
	assert.match(apps, /principal/);
	const secret = await render("en-US", <SecretPasteNotice count={2} onSave={() => undefined} onSendAnyway={() => undefined} />);
	assert.match(secret, /This looks like it contains passwords\/keys\./);
	assert.match(secret, /Store in vault/);
	assert.match(secret, /Send anyway/);
	const file = new File(["x"], "report.pdf", { type: "application/pdf" });
	const files = await render(
		"en-US",
		<ComposerFileAttachments items={[{ localId: "1", file, status: "error", error: undefined } as never]} onRemove={() => undefined} />,
	);
	assert.match(files, /aria-label="Attached files"/);
	assert.match(files, /Upload failed/);
	assert.match(files, /aria-label="Remove report\.pdf"/);
});
