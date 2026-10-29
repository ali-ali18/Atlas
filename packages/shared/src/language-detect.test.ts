import { describe, expect, it } from "vitest";
import { detectLanguage, LANGUAGE_LONG_MESSAGE_LETTERS, nextLanguageMemory, stripForLanguageDetection, toLanguageMemory, type LanguageMemory } from "./language-detect.js";

const PT = "Preciso que você me mostre os pedidos de hoje e também o estoque dos produtos mais vendidos";
const EN = "I need you to show me the orders from today and also the stock of the best selling products";
const ES = "Necesito que me muestres los pedidos de hoy y también el inventario de los productos más vendidos";

describe("detectLanguage", () => {
	it("reconhece português, inglês e espanhol em frases normais", () => {
		expect(detectLanguage(PT)?.language).toBe("pt-BR");
		expect(detectLanguage(EN)?.language).toBe("en-US");
		expect(detectLanguage(ES)?.language).toBe("es-ES");
		expect(detectLanguage("Can you remind me to call the dentist tomorrow morning?")?.language).toBe("en-US");
		expect(detectLanguage("Me lembra de ligar para o dentista amanhã de manhã, por favor")?.language).toBe("pt-BR");
		expect(detectLanguage("Recuérdame llamar al dentista mañana por la mañana, por favor")?.language).toBe("es-ES");
	});

	it("mensagem curta ou ambígua não vale", () => {
		for (const text of ["ok", "👍", "sim", "yes please", "Maria", "obrigado!", "valeu pessoal", "ok, pode fazer isso", "", "   "]) {
			expect(detectLanguage(text), text).toBeNull();
		}
	});

	it("só código, URL, caminho, menção ou emoji não vale", () => {
		expect(detectLanguage("```ts\nconst total = items.reduce((sum, item) => sum + item.price, 0);\nconsole.log(total, 'the value is');\n```")).toBeNull();
		expect(detectLanguage("https://example.com/the/best/products-and-the/orders?with=all&for=you")).toBeNull();
		expect(detectLanguage("@maria @joao 🎉🎉🎉 🚀🚀🚀 #release #the-and-of")).toBeNull();
		expect(detectLanguage("src/components/the_order_list.tsx apps/api/src/routes/orders.ts")).toBeNull();
		expect(detectLanguage("const isReady = true; if (isReady) { return value; } function run() {}")).toBeNull();
	});

	it("código e URL dentro da frase não decidem o idioma", () => {
		const text = `Preciso que você revise o trecho \`const the = and of with for\` e abra https://the-and-of.example.com para mim hoje`;
		expect(detectLanguage(text)?.language).toBe("pt-BR");
	});

	it("texto misto sem maioria clara não vale; com maioria vale", () => {
		expect(detectLanguage("Mostre os pedidos and show me the orders")).toBeNull();
		expect(detectLanguage("Preciso que você envie o relatório do deploy para o cliente e me avise quando os testes terminarem no pipeline de staging")?.language).toBe("pt-BR");
	});

	it("sinais de grafia ajudam, e palavra de dois idiomas não conta", () => {
		expect(detectLanguage("amanhã não consigo ir à reunião mas ligo à noite")?.language).toBe("pt-BR");
		expect(detectLanguage("¿qué hora es? mañana no puedo ir, señor")?.language).toBe("es-ES");
		// "de", "que", "no", "a" existem em mais de um idioma: sozinhas não decidem
		expect(detectLanguage("de que no a de que no a de que no a")).toBeNull();
	});

	it("conta letras só do que sobrou depois da limpeza", () => {
		expect(stripForLanguageDetection("oi @ana veja https://x.com/a e `code` 🎉 ok")).toBe("oi veja e ok");
		expect(detectLanguage(EN)?.letters).toBeGreaterThan(60);
	});
});

describe("nextLanguageMemory (grava só com confiança alta)", () => {
	const empty: LanguageMemory = { last: null, pending: null };
	const step = (memory: LanguageMemory, text: string) => nextLanguageMemory(memory, text).memory;

	it("sem idioma gravado, a primeira mensagem confiável grava", () => {
		expect(step(empty, EN)).toEqual({ last: "en-US", pending: null });
	});

	it("mensagem curta ou ambígua não muda nada", () => {
		const memory: LanguageMemory = { last: "en-US", pending: null };
		for (const text of ["ok", "👍", "sim", "Maria", "```js\nconsole.log(1)\n```"]) {
			const result = nextLanguageMemory(memory, text);
			expect(result.memory).toBe(memory);
			expect(result.changed).toBe(false);
		}
	});

	it("troca só na segunda mensagem seguida no idioma novo (sem vai-e-volta)", () => {
		let memory: LanguageMemory = { last: "en-US", pending: null };
		const first = nextLanguageMemory(memory, PT);
		expect(first.memory).toEqual({ last: "en-US", pending: "pt-BR" });
		expect(first.changed).toBe(true);
		// uma mensagem no idioma antigo zera o candidato
		memory = step(first.memory, EN);
		expect(memory).toEqual({ last: "en-US", pending: null });
		memory = step(memory, PT);
		expect(memory.last).toBe("en-US");
		memory = step(memory, PT);
		expect(memory).toEqual({ last: "pt-BR", pending: null });
	});

	it("candidato é por idioma: pt depois es não confirma nenhum", () => {
		let memory: LanguageMemory = { last: "en-US", pending: null };
		memory = step(memory, PT);
		memory = step(memory, ES);
		expect(memory).toEqual({ last: "en-US", pending: "es-ES" });
	});

	it("mensagem longa troca de uma vez", () => {
		const long = `${PT}. ${PT}. ${PT}.`;
		expect(detectLanguage(long)!.letters).toBeGreaterThanOrEqual(LANGUAGE_LONG_MESSAGE_LETTERS);
		expect(step({ last: "en-US", pending: null }, long)).toEqual({ last: "pt-BR", pending: null });
	});

	it("estado que não mudou devolve changed=false", () => {
		expect(nextLanguageMemory({ last: "pt-BR", pending: null }, PT).changed).toBe(false);
	});
});

describe("toLanguageMemory", () => {
	it("ignora valor fora do registro", () => {
		expect(toLanguageMemory({ last: "en-US", pending: "fr-FR" })).toEqual({ last: "en-US", pending: null });
		expect(toLanguageMemory(null)).toEqual({ last: null, pending: null });
		expect(toLanguageMemory({ last: "auto" })).toEqual({ last: null, pending: null });
	});
});
