import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import { SkillActivityCard } from "@/components/ai-elements/skills/skill-activity";

Object.assign(globalThis, { React });

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("o contêiner de rolagem da conversa nunca rola na horizontal", () => {
	const source = read("./chat-thread.tsx");
	assert.match(source, /className="min-h-0 flex-1 overflow-x-clip overflow-y-auto/);
});

test("a tabela do markdown mantém a própria rolagem horizontal", () => {
	const source = read("./assistant-message.tsx");
	assert.match(source, /w-full max-w-full overflow-x-auto[^"]*"\s+data-slot="markdown-table"/);
});

test("separador com texto longo encolhe e quebra em vez de empurrar a conversa", () => {
	const html = renderToStaticMarkup(
		<Marker variant="separator">
			<MarkerContent>texto</MarkerContent>
		</Marker>,
	);
	assert.match(html, /marker:shrink/);
	assert.doesNotMatch(html, /marker:flex-none/);
	assert.match(html, /min-w-0 wrap-break-word/);
});

test("cartão de skill quebra título e chave sem espaços", () => {
	const html = renderToStaticMarkup(
		<SkillActivityCard action="created" capabilityKey="chave_muito_longa" detail="detalhe" title="Titulo_muito_longo" />,
	);
	assert.match(html, /min-w-0 max-w-xl|min-w-0[^"]*max-w-xl/);
	assert.match(html, /<span class="min-w-0 \[overflow-wrap:anywhere\]">/);
	assert.match(html, /<pre class="[^"]*\[overflow-wrap:anywhere\]/);
});

test("cartão de arquivo e balão de ferramenta ficam limitados à largura", () => {
	assert.match(read("../../../../ai-elements/files/file-attachment.tsx"), /max-w-\[min\(24rem,100%\)\]/);
	const row = read("./message-row.tsx");
	assert.match(row, /flex max-w-full min-w-0 items-center gap-2 self-start[^"]*"/);
	assert.match(row, /min-w-0 font-medium text-foreground \[overflow-wrap:anywhere\]/);
});

test("título do questionário e fieldset quebram texto longo", () => {
	assert.match(read("../../../../../../../packages/ui/src/components/questionnaire.tsx"), /max-w-full font-heading[^"]*wrap-break-word/);
	assert.match(read("../../../../../../../packages/ui/src/components/field.tsx"), /"flex min-w-0 flex-col gap-6/);
});
