import assert from "node:assert/strict"
import test from "node:test"
import { UI_LOCALES } from "./locales"
import { loadMessages } from "./messages"
import { createTranslator, interpolate, type MessageDictionary } from "./translator"

const PLACEHOLDER = /\{(\w+)\}/g
const placeholders = (text: string) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort()

test("todo idioma tem exatamente as chaves do pt-BR (nada faltando, nada sobrando)", async () => {
	const base = Object.keys(await loadMessages("pt-BR")).sort()
	for (const locale of UI_LOCALES) {
		const keys = Object.keys(await loadMessages(locale)).sort()
		assert.deepEqual(keys, base, `chaves de ${locale} diferem do pt-BR`)
	}
})

test("traduções não ficam vazias e mantêm os mesmos {parametros} do pt-BR", async () => {
	const base = await loadMessages("pt-BR")
	for (const locale of UI_LOCALES) {
		const messages = await loadMessages(locale)
		for (const [key, text] of Object.entries(base)) {
			const translated = (messages as Record<string, string>)[key]!
			assert.notEqual(translated.trim(), "", `${locale}: ${key} vazio`)
			assert.deepEqual(placeholders(translated), placeholders(text), `${locale}: parâmetros de ${key}`)
		}
	}
})

test("chave começa com o nome do arquivo/área e todo plural tem .other", async () => {
	const base = Object.keys(await loadMessages("pt-BR"))
	for (const key of base) assert.match(key, /^[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+$/, key)
	for (const key of base.filter((name) => /\.(one|zero|few|many)$/.test(name))) {
		const root = key.replace(/\.(one|zero|few|many)$/, "")
		assert.ok(base.includes(`${root}.other`), `${root}.other ausente`)
	}
})

test("interpolate troca {nome} e deixa o que não foi passado", () => {
	assert.equal(interpolate("Olá, {name}! {n} itens", { name: "Ana", n: 3 }), "Olá, Ana! 3 itens")
	assert.equal(interpolate("Olá, {name}", {}), "Olá, {name}")
	assert.equal(interpolate("sem parâmetro"), "sem parâmetro")
})

test("createTranslator usa o idioma pedido e cai no pt-BR para o que faltar", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"))
	assert.equal(en.t("common.cancel"), "Cancel")
	const partial = createTranslator("en-US", { "common.cancel": "Cancel" } as Partial<MessageDictionary>)
	assert.equal(partial.t("common.cancel"), "Cancel")
	assert.equal(partial.t("common.save"), "Salvar")
	assert.equal(createTranslator("pt-BR").t("common.save"), "Salvar")
})

test("chave inexistente e parâmetro sobrando não compilam (verificado pelo typecheck)", () => {
	const { t } = createTranslator("pt-BR")
	const never = () => {
		// @ts-expect-error chave que não existe no dicionário
		t("common.naoExiste")
		// @ts-expect-error esta mensagem não tem parâmetros
		t("common.cancel", { extra: 1 })
	}
	assert.equal(typeof never, "function")
})
