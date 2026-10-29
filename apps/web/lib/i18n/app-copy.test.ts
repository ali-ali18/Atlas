import assert from "node:assert/strict"
import test from "node:test"
import { loadMessages } from "./messages"
import { createTranslator } from "./translator"

test("diálogo de exclusão e avisos da tela principal usam o nome e o idioma", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"))
	assert.equal(en.t("app.deleteGroupTitle", { name: "Team" }), "Delete group “Team”?")
	assert.equal(en.t("app.deleteBotTitle", { name: "Atlas" }), "Delete “Atlas”?")
	const es = createTranslator("es-ES", await loadMessages("es-ES"))
	assert.equal(es.t("app.deleteBotTitle", { name: "Atlas" }), "¿Eliminar “Atlas”?")
	assert.equal(es.t("app.configSaved"), "Configuración guardada")
	assert.equal(createTranslator("pt-BR").t("app.deleteGroupTitle", { name: "Time" }), "Excluir grupo “Time”?")
})
