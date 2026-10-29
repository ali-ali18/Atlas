import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { EMOJI_INDEX } from "./emoji-index";
import { CopyButton, ReactionBadges, ReactionTrigger } from "./message-reactions";

Object.assign(globalThis, { React });

async function wrap(locale: "en-US" | "es-ES", node: React.ReactNode) {
	return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>);
}

test("reações e copiar no idioma da tela", async () => {
	const en = await wrap("en-US", <ReactionTrigger onSelect={() => {}} />);
	assert.match(en, /aria-label="React"/);
	assert.doesNotMatch(en, /Reagir/);
	assert.match(await wrap("es-ES", <CopyButton text="x" />), /aria-label="Copiar"/);
	assert.match(await wrap("en-US", <CopyButton text="x" />), /aria-label="Copy"/);
	const badges = await wrap("en-US", <ReactionBadges reactions={[{ emoji: "👍" } as never]} />);
	assert.match(badges, /aria-label="Reaction: 👍"/);
});

test("busca de emoji acha por palavra em pt, en ou es", () => {
	const find = (word: string) => EMOJI_INDEX.filter((entry) => Object.values(entry.keys).join(" ").includes(word)).map((entry) => entry.char);
	assert.ok(find("fogo").includes("🔥"));
	assert.ok(find("fire").includes("🔥"));
	assert.ok(find("fuego").includes("🔥"));
	for (const entry of EMOJI_INDEX) {
		for (const keys of Object.values(entry.keys)) assert.ok(keys.length > 0, entry.char);
	}
});
