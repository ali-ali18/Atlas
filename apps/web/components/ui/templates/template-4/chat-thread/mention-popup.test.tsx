import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MentionPopup } from "./mention-popup";

Object.assign(globalThis, { React });

test("o / mostra /compact como comando, com a descrição em português e ícone próprio, antes das skills", () => {
	const html = renderToStaticMarkup(
		<MentionPopup
			activeIndex={0}
			candidates={[
				{ id: "command:compact", name: "compact", description: "Resume a conversa para liberar contexto", kind: "command" },
				{ id: "relatorio", name: "relatorio", description: "Monta o relatório" },
			]}
			onPick={() => undefined}
			trigger="/"
		/>,
	);
	assert.match(html, /aria-label="Escolher skill"/);
	assert.match(html, /\/compact/);
	assert.match(html, /Resume a conversa para liberar contexto/);
	assert.match(html, /data-kind="command"/);
	assert.match(html, /data-kind="skill"/);
	assert.ok(html.indexOf("/compact") < html.indexOf("/relatorio"));
});
