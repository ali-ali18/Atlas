import assert from "node:assert/strict"
import test from "node:test"
import { jevStatusText } from "../jev-status"
import { typingLabel, coordinationLabel } from "../group-thread"
import { proposalView } from "../routine-proposal-message"
import { UI_LOCALES } from "./locales"
import { loadMessages } from "./messages"
import { createTranslator } from "./translator"
import { getActiveTranslator, setActiveTranslator } from "./active"

const en = createTranslator("en-US", await loadMessages("en-US"))
const es = createTranslator("es-ES", await loadMessages("es-ES"))

test("textos de estado do lib/ em en-US e es-ES", () => {
	assert.equal(jevStatusText({ mode: "gate", result: "allow" }, true, en), "JEV approved this action.")
	assert.equal(jevStatusText({ mode: "gate", result: "allow" }, true, es), "JEV aprobó esta acción.")
	assert.equal(jevStatusText({ mode: "gate", result: "allow" }, true), "JEV aprovou esta ação.")
	assert.equal(typingLabel(["Ana"], en), "Ana is typing…")
	assert.equal(typingLabel(["Ana", "Bia", "Caio"], en), "Ana, Bia and Caio are typing…")
	assert.equal(typingLabel(["Ana", "Bia"]), "Ana e Bia estão digitando…")
	assert.equal(
		coordinationLabel({ coordinatorBotId: "a", replies: [{ botId: "b", status: "running", role: "worker" }] }, [{ id: "a", name: "Ana" }, { id: "b", name: "Bia" }], es),
		"Ana está coordinando: Bia trabajando…",
	)
	const view = proposalView({ mode: "suggest", status: "pending", spec: { name: "Resumo", prompt: "x" }, schedule: "Todo dia" }, en)
	assert.equal(view.cancelLabel, "Not now")
	assert.equal(view.badge.label, "Suggestion")
	assert.equal(proposalView({ mode: "suggest", status: "pending", spec: { name: "Resumo", prompt: "x" }, schedule: "Todo dia" }).cancelLabel, "Agora não")
})

test("erros de hooks e API seguem o idioma do tradutor ativo", async () => {
	const previous = getActiveTranslator()
	const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
	Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
	try {
		const { validateImageFiles } = await import("../../hooks/use-image-attachments")
		const { compactErrorText } = await import("../atlas-api")
		const tooMany = Array.from({ length: 5 }, () => ({ type: "image/png", size: 10 }) as File)
		assert.match(validateImageFiles(tooMany, 0) ?? "", /Até 4/)
		setActiveTranslator(en)
		assert.match(validateImageFiles(tooMany, 0) ?? "", /Up to 4 images/)
		assert.match(compactErrorText(new Error("x")), /couldn't summarize/i)
		setActiveTranslator(es)
		assert.match(validateImageFiles(tooMany, 0) ?? "", /Hasta 4 imágenes/)
	} finally {
		setActiveTranslator(previous)
		if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
		else delete (globalThis as { window?: unknown }).window
	}
})

test("toda chave de errors/status existe nos 3 idiomas e nenhum idioma deixa texto vazio", async () => {
	for (const locale of UI_LOCALES) {
		const messages = (await loadMessages(locale)) as Record<string, string>
		for (const [key, value] of Object.entries(messages)) {
			if (/^(errors|status)\./.test(key)) assert.notEqual(value.trim(), "", `${locale}.${key}`)
		}
	}
})
