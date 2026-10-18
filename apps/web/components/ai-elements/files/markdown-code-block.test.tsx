import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { markdownComponents } from "@/components/ui/templates/template-4/chat-thread/assistant-message";
import { highlightCode } from "@workspace/ui/lib/highlighter";
import { MarkdownCodeBlock } from "./markdown-code-block";

Object.assign(globalThis, { React });

const render = (md: string) =>
	renderToStaticMarkup(
		<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
			{md}
		</ReactMarkdown>,
	);

test("bloco com linguagem: título com o nome, botão copiar e rolagem horizontal", () => {
	const html = render("```ts\nconst x: number = 1;\n```\n");
	assert.match(html, /data-slot="code-block"/);
	assert.match(html, /data-slot="code-block-title"[^>]*>ts</);
	assert.match(html, /aria-label="Copiar código"/);
	assert.match(html, /overflow-auto/);
	assert.match(html, /const x: number = 1;/);
});

test("realce Shiki: ts, python e bash têm tokens com as duas cores de tema; aliases funcionam", async () => {
	for (const lang of ["ts", "python", "py", "bash", "sh"]) {
		const lines = await highlightCode("x = 1", lang);
		assert.ok(lines && lines.length === 1, lang);
	}
	const html = renderToStaticMarkup(<>{(await highlightCode("const a = 1", "ts"))![0]}</>);
	assert.match(html, /--shiki-light:#/);
	assert.match(html, /--shiki-dark:#/);
	assert.equal(await highlightCode("x", "linguagem-inexistente"), null);
});

test("sem linguagem: texto plano com rótulo genérico", () => {
	const html = render("```\nls -la <dir>\n```\n");
	assert.match(html, />texto</);
	assert.match(html, /ls -la &lt;dir&gt;/);
});

test("linguagem desconhecida não quebra e mostra o texto", () => {
	const html = render("```brainfuck\n+++\n```\n");
	assert.match(html, />brainfuck</);
	assert.match(html, /\+\+\+/);
});

test("bloco incompleto (streaming) renderiza sem erro", () => {
	const html = render("Veja:\n\n```python\nfor i in range(3):\n    print(");
	assert.match(html, /data-slot="code-block"/);
	assert.match(html, /print\(/);
});

test("HTML no código é escapado", () => {
	const html = renderToStaticMarkup(<MarkdownCodeBlock code={'<img src=x onerror="a">'} language="html" />);
	assert.doesNotMatch(html, /<img/);
});

test("código inline continua inline", () => {
	const html = render("use `npm i` aqui");
	assert.doesNotMatch(html, /data-slot="code-block"/);
	assert.match(html, /<code class="[^"]*bg-muted[^"]*">npm i/);
});

test("copiar: o botão leva o texto sem a quebra final (CodeBlockCopyButton grava no clipboard e alterna para check)", () => {
	const src = readFileSync(new URL("./markdown-code-block.tsx", import.meta.url), "utf8");
	assert.match(src, /<CodeBlockCopyButton value=\{text\} \/>/);
	const ui = readFileSync(new URL("../../../../../packages/ui/src/components/code-block.tsx", import.meta.url), "utf8");
	assert.match(ui, /navigator\.clipboard\s*\.writeText\(value\)/);
	assert.match(ui, /copied \? \(\s*<CheckIcon/);
});
