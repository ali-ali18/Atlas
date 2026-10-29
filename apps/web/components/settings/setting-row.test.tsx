import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingRow, SettingsGroup, SettingsStack } from "./setting-row";

Object.assign(globalThis, { React });

/** Parte do HTML dentro de um bloco `data-slot` (o primeiro, até o seu fechamento simples). */
function slot(html: string, name: string): string {
	const start = html.indexOf(`data-slot="${name}"`);
	assert.ok(start >= 0, `slot ${name} ausente`);
	return html.slice(html.lastIndexOf("<div", start));
}

test("linha padrão: rótulo e legenda à esquerda; a descrição vira dica e não aparece sob o rótulo; controle à direita", () => {
	const html = renderToStaticMarkup(
		<SettingsGroup>
			<SettingRow
				caption={<p>Herdado do padrão do servidor (ligado)</p>}
				control="inline"
				description="Descrição"
				htmlFor="x"
				label="Titulo"
			>
				<button id="x" type="button">
					controle
				</button>
			</SettingRow>
		</SettingsGroup>,
	);
	const text = slot(html, "setting-row-text");
	const control = slot(html, "setting-row-control");
	assert.match(text, /title="Descrição"/, "descrição só como dica");
	assert.doesNotMatch(text.replace(/title="[^"]*"/, ""), /Descrição/, "nunca visível sob o rótulo");
	assert.ok(text.indexOf("Titulo") < text.indexOf("Herdado do padrão do servidor (ligado)"));
	assert.ok(
		text.indexOf("Herdado do padrão") < text.indexOf('data-slot="setting-row-control"'),
		"legenda fica antes do controle, no bloco de texto",
	);
	assert.doesNotMatch(control.split("</div>")[0] ?? "", /Herdado/);
	assert.match(control, /justify-end/);
	assert.match(control, /min-w-0/);
	assert.match(control, /settings-ghost-controls/, "seletores viram ghost");
});

test("descrição que não é texto simples (ex.: com link) continua visível", () => {
	const html = renderToStaticMarkup(
		<SettingRow description={<a href="https://x.test">Criar chave</a>} label="Chave" />,
	);
	assert.match(html, />Criar chave</);
});

test("linha só de status não renderiza o bloco de controle", () => {
	const html = renderToStaticMarkup(<SettingRow caption={<p>Não conectado</p>} label="Conexão" />);
	assert.doesNotMatch(html, /setting-row-control/);
	assert.match(html, /Não conectado/);
});

test("linha de switch: legenda e erros ficam no bloco de texto, nunca no controle", () => {
	const html = renderToStaticMarkup(
		<SettingRow
			caption={<p>Herdado do padrão do servidor (ligado)</p>}
			control="inline"
			description="Descrição"
			label="Usar plano"
		>
			<button type="button">Voltar ao padrão</button>
			<button role="switch" type="button" />
		</SettingRow>,
	);
	const control = slot(html, "setting-row-control");
	assert.doesNotMatch(control, /Herdado/);
	assert.match(html, /items-center/);
	assert.match(control, /^<div class="[^"]* items-center /);
});

test("linha: 40px de altura mínima, padding 10/14, rótulo 13px, sem divisória", () => {
	const html = renderToStaticMarkup(
		<SettingRow label="Campo">
			<span>x</span>
		</SettingRow>,
	);
	assert.match(html, /min-h-10/);
	assert.match(html, /px-3\.5 py-2\.5/);
	assert.match(html, /text-body/);
	assert.doesNotMatch(html, /border-b|divide-/);
});

test("grupo: título de 12px com 8px de recuo, 8px até o cartão de raio 12 com borda fina", () => {
	const html = renderToStaticMarkup(
		<SettingsGroup title="Aparência">
			<SettingRow label="Tema" />
		</SettingsGroup>,
	);
	assert.match(html, /<h3 class="px-2 text-xs[^"]*"[^>]*>Aparência<\/h3>/);
	assert.match(html, /<section class="flex w-full flex-col gap-2"/);
	assert.match(html, /rounded-card border border-border\/60 py-2/);
});

test("grupos aninhados viram só as linhas (um cartão por título)", () => {
	const html = renderToStaticMarkup(
		<SettingsGroup title="Externo">
			<SettingsGroup>
				<SettingRow label="A" />
			</SettingsGroup>
			<SettingsGroup>
				<SettingRow label="B" />
			</SettingsGroup>
		</SettingsGroup>,
	);
	assert.equal((html.match(/data-slot="settings-group"/g) ?? []).length, 1);
	assert.equal((html.match(/data-slot="setting-row"/g) ?? []).length, 2);
});

test("painel: grupos separados por 28px", () => {
	assert.match(renderToStaticMarkup(<SettingsStack>x</SettingsStack>), /gap-7/);
});

test("linha com ícone (logo de app): ícone decorativo antes do título", () => {
	const Icon = ({ className }: { className?: string }) => <svg aria-hidden="true" className={className} data-testid="ic" />;
	const html = renderToStaticMarkup(
		<SettingRow htmlFor="x" icon={Icon} label="Titulo">
			<input id="x" />
		</SettingRow>,
	);
	const text = slot(html, "setting-row-text");
	assert.match(text, /class="size-4 shrink-0 text-muted-foreground"/);
	assert.ok(text.indexOf("data-testid") < text.indexOf("Titulo"));
	assert.match(html, /<label[^>]*for="x"[^>]*>Titulo<\/label>/);
});

test("linha sem ícone não renderiza o slot do ícone", () => {
	const html = renderToStaticMarkup(<SettingRow label="Titulo" />);
	assert.doesNotMatch(html, /setting-row-icon/);
});
