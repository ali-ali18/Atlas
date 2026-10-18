import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountSettingsView, PhotoActionsList, PhotoAvatarButton, avatarPressAction } from "./account";
import { GeneralSettingsView, languageOptions } from "./general";

Object.assign(globalThis, { React });

const noop = () => {};

function general(props: Partial<React.ComponentProps<typeof GeneralSettingsView>> = {}) {
	return renderToStaticMarkup(
		<GeneralSettingsView
			language={{ value: "pt-BR", source: "env" }}
			onLanguageChange={noop}
			onThemeChange={noop}
			status="idle"
			theme="system"
			{...props}
		/>,
	);
}

test("Geral: tema e idioma, um dropdown cada, com rótulos acessíveis", () => {
	const html = general();
	assert.match(html, /for="settings-theme"[^>]*>Tema</);
	assert.match(html, /id="settings-theme"/);
	assert.match(html, />Sistema</, "tema atual no gatilho");
	assert.match(html, /for="settings-default-language"[^>]*>Idioma dos bots novos</);
	assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 2);
});

test("Geral: idioma herdado mostra a origem do valor (padrão do servidor)", () => {
	assert.match(general(), /Herdar \(pt-BR\)/);
	assert.match(
		general({ language: { value: "pt-BR", source: "default" } }),
		/Herdar \(pt-BR\)/,
	);
});

test("Geral: idioma definido pelo usuário mostra o idioma, não 'Herdar'", () => {
	const html = general({ language: { value: "en-US", source: "user" } });
	assert.match(html, /English \(US\)/);
	assert.doesNotMatch(html, /Herdar: padrão/);
});

test("Geral: opções = Herdar + idiomas dos bots (mesma lista do seletor do bot)", () => {
	const options = languageOptions({ value: "pt-BR", source: "env" });
	assert.deepEqual(
		options.map((option) => option.value),
		["inherit", "pt-BR", "en-US", "es-ES"],
	);
	assert.equal(options[0]!.label, "Herdar (pt-BR)");
});

test("Geral: carregando desabilita o idioma; falha de carga e de salvar aparecem como alerta", () => {
	assert.match(general({ language: null }), /disabled=""[^>]*aria-haspopup|aria-haspopup[^>]*disabled=""/);
	assert.match(general({ language: null, loadError: "Não foi possível carregar as configurações." }), /role="alert"[^>]*>Não foi possível carregar/);
	assert.match(general({ status: "error", saveError: "Não foi possível salvar. Tente novamente." }), /role="alert"[^>]*>Não foi possível salvar/);
});

test("Geral: 'Salvo' discreto depois de salvar e nada quando ocioso", () => {
	assert.match(general({ status: "saved" }), />Salvo</);
	assert.doesNotMatch(general({ status: "idle" }), />Salvo</);
});

test("Geral: a busca esconde o item que não casou", () => {
	const html = general({ isVisible: (id) => id === "geral.tema" });
	assert.match(html, /Tema/);
	assert.doesNotMatch(html, /Idioma dos bots novos/);
});

const editing = (image: string | null = null) => ({
	image,
	onSaveName: async () => {},
	onPickPhoto: async () => {},
	onRemovePhoto: async () => {},
});

test("Conta: nome editável, foto, e-mail somente leitura e botão Sair", () => {
	const html = renderToStaticMarkup(
		<AccountSettingsView editing={editing()} email="ana@example.com" name="Ana" onSignOut={noop} />,
	);
	assert.match(html, /<h3[^>]*>Conta<\/h3>/, "título do grupo");
	assert.match(html, /for="settings-account-name"[^>]*>Nome</);
	assert.match(html, /<input[^>]*id="settings-account-name"[^>]*value="Ana"/, "nome é um campo");
	assert.match(html, /id="settings-account-email"[^>]*>ana@example\.com</);
	assert.match(html, /<input[^>]*accept="image\/\*"[^>]*type="file"/, "foto: galeria/câmera");
	assert.match(html, /aria-label="Adicionar foto de perfil"/, "o avatar é o controle");
	assert.match(html, /data-slot="photo-avatar-badge"/, "selo de câmera indica que é clicável");
	assert.doesNotMatch(html, />(Escolher|Trocar|Remover)</, "sem botões de texto na linha");
	assert.match(html, /data-gradient[\s\S]*?<span class="relative">A</, "sem foto: inicial do nome sobre o gradiente");
	assert.doesNotMatch(html, />Salvar</, "sem alteração, sem botão Salvar");
	assert.match(html, /<button[^>]*>.*Sair<\/button>/);
});

test("Conta: com foto mostra a imagem e o botão Remover", () => {
	const html = renderToStaticMarkup(
		<AccountSettingsView editing={editing("data:image/webp;base64,AAAA")} email="a@b.c" name="Ana" onSignOut={noop} />,
	);
	assert.match(html, /<img[^>]*src="data:image\/webp;base64,AAAA"/);
	assert.match(html, /aria-label="Alterar foto de perfil"/);
	assert.doesNotMatch(html, /Remover foto|Trocar foto/, "as ações só aparecem no drawer aberto");
});

test("Foto: sem foto o toque abre o seletor; com foto abre o drawer", () => {
	assert.equal(avatarPressAction(false), "pick");
	assert.equal(avatarPressAction(true), "menu");
});

test("Foto: o drawer tem Trocar, Remover (destrutivo) e Cancelar, e cada um chama seu callback", () => {
	const calls: string[] = [];
	const tree = PhotoActionsList({ onReplace: () => calls.push("replace"), onRemove: () => calls.push("remove"), onCancel: () => calls.push("cancel") });
	const buttons = (tree.props as { children: Array<{ props: { onClick: () => void; variant: string } }> }).children;
	assert.equal(buttons.length, 3);
	assert.deepEqual(buttons.map((b) => b.props.variant), ["outline", "destructive", "ghost"]);
	for (const b of buttons) b.props.onClick();
	assert.deepEqual(calls, ["replace", "remove", "cancel"]);
	const html = renderToStaticMarkup(<PhotoActionsList onCancel={noop} onRemove={noop} onReplace={noop} />);
	assert.match(html, /Trocar foto/);
	assert.match(html, /Remover foto/);
	assert.match(html, /Cancelar/);
});

test("Foto: durante o envio o avatar mostra loading e fica desabilitado", () => {
	const html = renderToStaticMarkup(<PhotoAvatarButton busy hasImage={false} onPress={noop}>x</PhotoAvatarButton>);
	assert.match(html, /data-slot="photo-avatar-loading"/);
	assert.match(html, /disabled=""/);
	assert.doesNotMatch(html, /photo-avatar-badge/);
});

test("Conta: erro ao sair aparece como alerta e o botão desabilita enquanto sai", () => {
	const html = renderToStaticMarkup(
		<AccountSettingsView
			editing={editing()}
			email="a@b.c"
			name="A"
			onSignOut={noop}
			signOutError="Não foi possível sair. Tente novamente."
			signingOut
		/>,
	);
	assert.match(html, /role="alert"[^>]*>Não foi possível sair/);
	assert.match(html, /<button[^>]*disabled=""/);
});

test("Geral: grupo Aparência no estilo cartão (título pequeno, cantos 12, com ícone nas linhas)", () => {
	const html = general({ theme: "dark" });
	assert.match(html, /<h3[^>]*data-slot="settings-group-title"[^>]*>Aparência<\/h3>/);
	assert.match(html, /rounded-\[12px\] border border-border\/60 py-2/);
	assert.doesNotMatch(html, /divide-y/, "sem divisórias entre as linhas");
	assert.equal((html.match(/data-slot="setting-row-icon"/g) ?? []).length, 2);
	assert.match(html, /lucide-moon/, "trigger do tema mostra a lua (opção atual)");
	assert.doesNotMatch(html, /lucide-sun/);
});

test("Conta: ícones nas linhas", () => {
	const html = renderToStaticMarkup(
		<AccountSettingsView editing={editing()} email="a@b.c" name="Ana" onSignOut={noop} />,
	);
	assert.equal((html.match(/data-slot="setting-row-icon"/g) ?? []).length, 4);
	assert.equal((html.match(/data-slot="setting-row"/g) ?? []).length, 4);
});
