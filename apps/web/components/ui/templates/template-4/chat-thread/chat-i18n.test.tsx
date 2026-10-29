import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { UiLocale } from "@/lib/i18n/locales";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { createTranslator } from "@/lib/i18n/translator";
import { CodeRunCard } from "./code-run-card";
import { CompactionNotice } from "./compaction-card";
import { EmailReceivedCard } from "./email-received-card";
import { MemoryUpdatedMarker } from "./memory-updated-marker";
import { NewMessagesDivider } from "./new-messages-divider";
import { ScrollToBottom, newCountLabel } from "./scroll-to-bottom";

Object.assign(globalThis, { React });

async function render(locale: UiLocale, node: React.ReactNode): Promise<string> {
	return renderToStaticMarkup(
		<I18nProvider locale={locale} messages={await loadMessages(locale)}>
			{node}
		</I18nProvider>,
	);
}

test("marcadores e cards comuns da conversa em en-US", async () => {
	assert.match(await render("en-US", <NewMessagesDivider />), />New messages</);
	assert.match(await render("en-US", <MemoryUpdatedMarker />), />Memory updated</);
	assert.match(await render("en-US", <CompactionNotice state={{ status: "working" }} />), /Compacting the conversation…/);
	const email = await render("en-US", <EmailReceivedCard from="a@b.c" subject="" text="Hi" />);
	assert.match(email, /Email received/);
	assert.match(email, /\(no subject\)/);
	assert.match(email, /came from outside/);
	const code = await render("en-US", <CodeRunCard code="print(1)" defaultOpen output="1" status="ok" />);
	assert.match(code, /Ran code/);
	assert.match(code, />output</);
	const failed = await render("en-US", <CodeRunCard code="x" durationMs={1200} status="error" />);
	assert.match(failed, /Failed · /);
});

test("pílula de novas mensagens usa plural do idioma", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"));
	assert.equal(newCountLabel(1, en), "1 new");
	assert.equal(newCountLabel(3, en), "3 new");
	const es = createTranslator("es-ES", await loadMessages("es-ES"));
	assert.equal(newCountLabel(1, es), "1 nuevo");
	assert.equal(newCountLabel(2, es), "2 nuevos");
	const ref = { current: null };
	const html = await render("es-ES", <ScrollToBottom newCount={2} targetRef={ref} />);
	assert.match(html, /aria-label="Ir al final, 2 nuevos"/);
});
