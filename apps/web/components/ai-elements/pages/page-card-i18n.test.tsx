import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePageSpec } from "@workspace/shared";

import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";

import { PageCard } from "./page-card";

Object.assign(globalThis, { React });

test("cartão de painel: rótulos acessíveis e rodapé seguem o idioma da tela", async () => {
	const parsed = parsePageSpec({ v: 2, title: "Forecast", root: { type: "stack", children: [{ type: "heading", props: { text: "Detalhes" } }] } });
	if (!parsed.ok) throw new Error(parsed.error);
	const card = { pageId: "p1", revision: 1, title: "Forecast Q4", action: "created" as const, spec: parsed.spec, sourceCount: 0 };
	const html = renderToStaticMarkup(
		<I18nProvider locale="en-US" messages={await loadMessages("en-US")}>
			<PageCard card={card} loadPage={async () => "missing"} />
		</I18nProvider>,
	);
	assert.match(html, /aria-label="Panel: Forecast Q4"/);
	assert.match(html, /aria-label="Open panel full screen"/);
	assert.doesNotMatch(html, /Abrir painel|Painel/);
});
