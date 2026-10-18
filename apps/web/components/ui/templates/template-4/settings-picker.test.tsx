import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPicker, withOptionIcons } from "./settings-picker";

Object.assign(globalThis, { React });

const options = [
	{ value: "a", label: "Opção A", description: "Descrição longa da opção A" },
	{ value: "b", label: "Herdar (Desligado, valor bem comprido)" },
] as const;

test("trigger preenche o slot do controle, com texto truncado e title", () => {
	const html = renderToStaticMarkup(
		<SettingsPicker onChange={() => {}} options={options} value="b" />,
	);
	assert.match(html, /data-slot="settings-picker-trigger"/);
	assert.match(html, /class="[^"]*\bw-full\b[^"]*\bmin-w-0\b/);
	assert.doesNotMatch(html, /\bw-(auto|fit)\b/);
	assert.match(html, /<span class="[^"]*\btruncate\b[^"]*">Herdar \(Desligado, valor bem comprido\)/);
	assert.match(html, /title="Herdar \(Desligado, valor bem comprido\)"/);
});

test("title não aparece quando o texto é curto (sem truncamento)", () => {
	const curto = renderToStaticMarkup(
		<SettingsPicker onChange={() => {}} options={options} value="a" />,
	);
	assert.doesNotMatch(curto, /title=/);
});

test("popup abre alinhado ao fim do trigger (fora de cartão), com folga da borda; em cartão alinha às bordas dele", () => {
	const src = readFileSync(new URL("./settings-picker.tsx", import.meta.url), "utf8");
	assert.match(src, /"end"/);
	assert.match(src, /collisionPadding=[{]card [?] 0 : 12[}]/);
	assert.match(src, /data-slot="settings-group"/);
	assert.match(src, /alignOffset=[{]card [?] card.offset : 0[}]/);
});

test("popup: largura mínima = âncora, no mínimo 18rem, máximo 22rem; descrição quebra normal", () => {
	const src = readFileSync(new URL("./settings-picker.tsx", import.meta.url), "utf8");
	assert.match(src, /min-w-\[max\(var\(--anchor-width\),18rem\)\]/);
	assert.match(src, /max-w-\[22rem\]/);
	assert.match(src, /w-auto/);
	assert.match(src, /whitespace-normal text-muted-foreground/);
});

test("opção com ícone: o trigger mostra o ícone da selecionada, decorativo", () => {
	const Icon = ({ className }: { className?: string }) => (
		<svg aria-hidden="true" className={className} data-icon="sun" />
	);
	const html = renderToStaticMarkup(
		<SettingsPicker
			onChange={() => {}}
			options={[
				{ value: "a", label: "Claro", icon: Icon },
				{ value: "b", label: "Escuro" },
			]}
			value="a"
		/>,
	);
	assert.match(html, /data-icon="sun"/);
	assert.match(html, /data-icon="sun"><[/]svg><span[^>]*>Claro/);
	const semIcone = renderToStaticMarkup(
		<SettingsPicker
			onChange={() => {}}
			options={[{ value: "a", label: "Claro", icon: Icon }, { value: "b", label: "Escuro" }]}
			value="b"
		/>,
	);
	assert.doesNotMatch(semIcone, /data-icon/);
});

test("withOptionIcons anexa ícones por valor e preserva o resto", () => {
	const Icon = () => null;
	const result = withOptionIcons(
		[
			{ value: "a", label: "A", description: "d" },
			{ value: "b", label: "B" },
		],
		{ a: Icon },
	);
	assert.equal(result[0]?.icon, Icon);
	assert.equal(result[0]?.description, "d");
	assert.equal(result[1]?.icon, undefined);
});
