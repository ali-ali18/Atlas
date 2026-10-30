import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { loadMessages } from "@/lib/i18n/messages"
import { I18nProvider } from "@/lib/i18n/provider"
import { createTranslator } from "@/lib/i18n/translator"
import { formatCodeRunDuration } from "@/lib/code-run"
import { taskListDockLine, taskListSettledLabel } from "@/lib/task-list"
import { CompactionCard } from "./compaction-card"
import { TaskListCard } from "./task-list-card"
import { TaskListDock } from "./task-list-dock"

Object.assign(globalThis, { React })

const ITEMS = [
	{ content: "A", status: "completed" as const },
	{ content: "B", status: "in_progress" as const },
	{ content: "C", status: "pending" as const },
]

async function wrap(locale: "en-US" | "es-ES", node: React.ReactNode) {
	return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>)
}

test("lista de tarefas: resumo, 'ver tudo' e doca no idioma da tela", async () => {
	const en = await wrap("en-US", <TaskListCard items={ITEMS} />)
	assert.match(en, /Tasks · 1\/3/)
	assert.match(en, /See all \(3\)/)
	assert.doesNotMatch(en, /Tarefas|Ver tudo/)
	const dock = await wrap("es-ES", <TaskListDock defaultOpen items={ITEMS} />)
	assert.match(dock, /aria-label="Tareas del bot"/)
	assert.match(dock, /aria-label="Pendiente"/)
	const done = ITEMS.map((item) => ({ ...item, status: "completed" as const }))
	const en2 = createTranslator("en-US", await loadMessages("en-US"))
	assert.equal(taskListDockLine(done, en2), "3/3 · All done")
	assert.equal(taskListSettledLabel(done, en2), "Tasks · 3/3 completed")
})

test("compactação e duração do código usam o formato do idioma da tela", async () => {
	const en = await wrap("en-US", <CompactionCard after={9100} before={84200} focus={undefined} summary="" />)
	assert.match(en, /84\.2k → 9\.1k tokens \(−89%\)/)
	const es = await wrap("es-ES", <CompactionCard after={9100} before={84200} summary="" />)
	assert.match(es, /84,2 mil → 9,1 mil tokens/)
	assert.equal(formatCodeRunDuration(1234, createTranslator("en-US", await loadMessages("en-US"))), "1.2 s")
	assert.equal(formatCodeRunDuration(1234), "1,2 s")
})
