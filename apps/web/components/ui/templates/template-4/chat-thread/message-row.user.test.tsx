import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../data";
import { MessageRow } from "./message-row";

Object.assign(globalThis, { React });

test("bolha do usuário mantém quebras de linha e linhas em branco como digitadas", () => {
	const message: Message = { id: "u-1", kind: "user", text: "linha 1\n\nlinha 2\nlinha 3" };
	const html = renderToStaticMarkup(<MessageRow message={message} />);
	assert.match(html, /linha 1\n\nlinha 2\nlinha 3/);
	assert.match(html, /data-slot="bubble-content"[^>]*class="[^"]*whitespace-pre-wrap/);
});
