import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "./assistant-message";

Object.assign(globalThis, { React });

const md = "- **Commit:** `fd59716` em `next.config.ts`\n- https://github.com/ali-ali18/agent-bot/commit/fd597168e1b979701c7636040a62350e\n\n```\nconst muitoLongo = 1\n```\n";

test("links, código inline e itens quebram em qualquer ponto; bloco de código rola", () => {
	const html = renderToStaticMarkup(
		<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
			{md}
		</ReactMarkdown>,
	);
	assert.match(html, /<li class="[^"]*min-w-0[^"]*overflow-wrap:anywhere/);
	assert.match(html, /<a class="[^"]*overflow-wrap:anywhere/);
	assert.match(html, /<code class="[^"]*overflow-wrap:anywhere[^"]*">fd59716/);
	assert.match(html, /<pre class="[^"]*overflow-x-auto/);
});

test("a bolha nunca passa da largura máxima (68ch limitado a 100%)", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("./assistant-message.tsx", import.meta.url), "utf8");
	assert.match(source, /max-w-\[min\(68ch,100%\)\]/);
	assert.doesNotMatch(source, /"max-w-\[68ch\]/);
});
