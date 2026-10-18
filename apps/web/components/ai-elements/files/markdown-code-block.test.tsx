import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { markdownComponents } from "@/components/ui/templates/template-4/chat-thread/assistant-message";
import { highlightCode, normalizeLanguage } from "./code-highlight";
import { MarkdownCodeBlock } from "./markdown-code-block";

Object.assign(globalThis, { React });

const render = (md: string) =>
	renderToStaticMarkup(
		<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
			{md}
		</ReactMarkdown>,
	);

test("bloco com linguagem: cabeçalho com nome, botão copiar e realce", () => {
	const html = render("```ts\nconst x: number = 1;\n```\n");
	assert.match(html, /data-slot="code-block"/);
	assert.match(html, />ts</);
	assert.match(html, /aria-label="Copiar código"/);
	assert.match(html, /<span class="hljs-keyword">const<\/span>/);
	assert.match(html, /overflow-x-auto/);
});

test("python e bash são realçados; aliases funcionam", () => {
	assert.match(render("```python\ndef f():\n    return 1\n```\n"), /hljs-keyword/);
	assert.match(render("```bash\nif true; then echo oi; fi\n```\n"), /hljs-keyword/);
	assert.equal(normalizeLanguage("TSX"), "typescript");
	assert.equal(normalizeLanguage("py"), "python");
});

test("sem linguagem: texto plano com rótulo genérico, sem span de realce", () => {
	const html = render("```\nls -la <dir>\n```\n");
	assert.match(html, />texto</);
	assert.doesNotMatch(html, /class="hljs-/);
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
	assert.match(html, /print<\/span>\(<\/code>/);
	assert.equal(highlightCode("x = (", "python") !== undefined, true);
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

test("copiar usa clipboard com o texto sem a quebra final e alterna para check", () => {
	const src = readFileSync(new URL("./markdown-code-block.tsx", import.meta.url), "utf8");
	assert.match(src, /navigator\.clipboard\.writeText\(text\)/);
	assert.match(src, /setCopied\(true\)/);
	assert.match(src, /copied \? <CheckIcon \/> : <CopyIcon \/>/);
});
