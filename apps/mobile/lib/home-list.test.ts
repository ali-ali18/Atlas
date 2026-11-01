import type { Bot, Section } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { NO_SECTION_KEY, buildHome, foldText, formatListDate, initialsOf, previewOf, stripMarkdownPreview } from "./home-list";

function bot(id: string, extra: Partial<Bot> = {}): Bot {
	return {
		id,
		name: id,
		snippet: "",
		color: "#fff",
		shape: "blob",
		description: null,
		openRouterModel: null,
		language: "auto",
		pinned: false,
		pinOrder: null,
		notify: true,
		sectionId: null,
		memberIds: [],
		conversationId: null,
		lastMessage: null,
		isPrimary: false,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...extra,
	} as Bot;
}
const section = (id: string, name: string, order: number): Section => ({ id, name, order, createdAt: "", updatedAt: "" });

describe("buildHome", () => {
	it("fixados por pinOrder e fora das seções, mesmo com sectionId antigo", () => {
		const home = buildHome(
			[bot("b", { pinned: true, pinOrder: 1 }), bot("a", { pinned: true, pinOrder: 0, sectionId: "s1" }), bot("c", { sectionId: "s1" })],
			[section("s1", "Codding", 0)],
		);
		expect(home.pinned.map((item) => item.id)).toEqual(["a", "b"]);
		expect(home.sections).toEqual([{ key: "s1", title: "Codding", bots: [expect.objectContaining({ id: "c" })] }]);
	});
	it("seções na ordem de `order`; sem seção ou seção inexistente vai para Sem sessão no fim", () => {
		const home = buildHome([bot("x", { sectionId: "sumiu" }), bot("y", { sectionId: "s2" }), bot("z")], [section("s2", "Segunda", 5), section("s1", "Primeira", 1)]);
		expect(home.sections.map((item) => item.key)).toEqual(["s1", "s2", NO_SECTION_KEY]);
		expect(home.sections[2]?.bots.map((item) => item.id)).toEqual(["x", "z"]);
	});
	it("vazio: sem bots não há seção solta; seção sem bots continua sem busca", () => {
		expect(buildHome([], [])).toEqual({ pinned: [], sections: [] });
		expect(buildHome([], [section("s1", "Vazia", 0)]).sections).toHaveLength(1);
	});
	it("busca ignora caixa e acento, olha o nome e a prévia, e esconde seção vazia", () => {
		const bots = [
			bot("1", { name: "Sênior · Dev", sectionId: "s1" }),
			bot("2", { name: "Cookie", pinned: true, pinOrder: 0, lastMessage: { role: "assistant", content: "Fatura **paga**", createdAt: "" } }),
			bot("3", { name: "Tutor" }),
		];
		const sections = [section("s1", "Codding", 0), section("s2", "Outra", 1)];
		expect(buildHome(bots, sections, "SENIOR").sections.map((item) => item.key)).toEqual(["s1"]);
		expect(buildHome(bots, sections, "senior").pinned).toEqual([]);
		expect(buildHome(bots, sections, "paga").pinned.map((item) => item.id)).toEqual(["2"]);
		expect(buildHome(bots, sections, "zzz")).toEqual({ pinned: [], sections: [] });
	});
	it("estabilidade: pinOrder igual mantém a ordem do servidor", () => {
		const home = buildHome([bot("a", { pinned: true }), bot("b", { pinned: true }), bot("c", { pinned: true })], []);
		expect(home.pinned.map((item) => item.id)).toEqual(["a", "b", "c"]);
	});
});

describe("previewOf", () => {
	it("sem mensagem", () => expect(previewOf(bot("a"))).toEqual({ text: "", sent: false }));
	it("limpa markdown", () => {
		expect(stripMarkdownPreview("# Oi\n**negrito** e [link](http://x) `código`")).toBe("Oi negrito e link código");
	});
	it("prefixo de origem automatizada", () => {
		const p = previewOf(bot("a", { lastMessage: { role: "assistant", content: "Pronto", createdAt: "", source: { kind: "routine", label: "Agenda" } } }));
		expect(p).toEqual({ text: "Rotina: Agenda · Pronto", sent: false });
	});
	it("marcador de envio a outro bot", () => {
		const content = JSON.stringify({ v: 1, kind: "sent", botMessageId: "m", botId: "b", botName: "Grok Bot", title: "Revisar" });
		expect(previewOf(bot("a", { lastMessage: { role: "bot-link", content, createdAt: "" } }))).toEqual({ text: "Enviou mensagem para Grok Bot: Revisar", sent: true });
	});
	it("marcador ilegível não mostra JSON cru", () => {
		expect(previewOf(bot("a", { lastMessage: { role: "bot-link", content: "{oops", createdAt: "" } })).text).toBe("");
	});
});

describe("formatListDate", () => {
	const now = new Date(2026, 10, 1, 18, 4); // 1 nov 2026, domingo
	const at = (y: number, m: number, d: number, h = 9, min = 30) => new Date(y, m, d, h, min).toISOString();
	it("vazio e inválido", () => {
		expect(formatListDate(null, now)).toBe("");
		expect(formatListDate("lixo", now)).toBe("");
	});
	it("agora, hoje e ontem", () => {
		expect(formatListDate(new Date(2026, 10, 1, 18, 3, 40).toISOString(), now)).toBe("agora");
		expect(formatListDate(at(2026, 10, 1), now)).toBe("09:30");
		expect(formatListDate(at(2026, 9, 31, 23, 59), now)).toBe("Ontem");
	});
	it("dia da semana até 6 dias", () => {
		expect(formatListDate(at(2026, 9, 28), now)).toBe("Qua");
		expect(formatListDate(at(2026, 9, 26), now)).toBe("Seg"); // 6 dias antes
		expect(formatListDate(at(2026, 9, 25), now)).toBe("25 de out."); // 7 dias
	});
	it("data por extenso neste ano e com ano nos anteriores", () => {
		expect(formatListDate(at(2026, 9, 5), now)).toBe("5 de out.");
		expect(formatListDate(at(2025, 11, 30), now)).toBe("30 de dez. de 2025");
	});
});

describe("textos", () => {
	it("foldText", () => expect(foldText("  Sênior ÇÃO ")).toBe("senior cao"));
	it("initialsOf", () => {
		expect(initialsOf("Alisson Camargo", "a@b.c")).toBe("AC");
		expect(initialsOf("Alisson", null)).toBe("AL");
		expect(initialsOf(null, "dono@exemplo.com")).toBe("D");
		expect(initialsOf("", "")).toBe("?");
	});
});
