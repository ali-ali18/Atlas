import { describe, expect, it } from "vitest";
import type { HomeBot } from "./home-types";
import { mentionableBots, removeTrigger, triggerState } from "./mention-input";

const bots = [
	{ id: "b1", name: "Cookie" },
	{ id: "b2", name: "Ana Maria" },
	{ id: "b3", name: "Financeiro" },
];
const skills = [
	{ id: "s1", name: "resumo-do-dia", description: "Resume" },
	{ id: "s2", name: "agenda" },
];

describe("triggerState", () => {
	it("@ sem consulta lista todos os bots", () => {
		const state = triggerState("@", 1, { bots, skills });
		expect(state?.trigger).toBe("@");
		expect(state?.candidates).toHaveLength(3);
	});
	it("filtra por prefixo de qualquer palavra do nome, sem acento", () => {
		expect(triggerState("@mar", 4, { bots, skills })?.candidates.map((b) => b.id)).toEqual(["b2"]);
		expect(triggerState("oi @fin", 7, { bots, skills })?.candidates.map((b) => b.id)).toEqual(["b3"]);
	});
	it("e-mail não abre o @", () => {
		expect(triggerState("ana@x", 5, { bots, skills })).toBeNull();
	});
	it("/ lista habilidades e filtra pelo prefixo de uma palavra do slug", () => {
		expect(triggerState("/", 1, { bots, skills })?.candidates).toHaveLength(2);
		expect(triggerState("/dia", 4, { bots, skills })?.candidates.map((s) => s.id)).toEqual(["s1"]);
	});
	it("/ sem resultado segue aberto (estado vazio); sem habilidades (grupo) não abre", () => {
		expect(triggerState("/zzz", 4, { bots, skills })).toMatchObject({ trigger: "/", candidates: [] });
		expect(triggerState("/", 1, { bots, skills: null })).toBeNull();
	});
	it("barra no meio da palavra não abre", () => {
		expect(triggerState("a/b", 3, { bots, skills })).toBeNull();
	});
	it("@ com espaço e sem resultado fecha; sem bots nenhum também", () => {
		expect(triggerState("@Cookie asd", 11, { bots, skills })).toBeNull();
		expect(triggerState("@", 1, { bots: [], skills })).toBeNull();
	});
	it("vale o gatilho mais perto do cursor", () => {
		expect(triggerState("@Cookie /re", 11, { bots, skills })?.trigger).toBe("/");
		expect(triggerState("/resumo @a", 10, { bots, skills })?.trigger).toBe("@");
	});
});

describe("removeTrigger", () => {
	it("tira @consulta e deixa o cursor onde ele estava", () => {
		expect(removeTrigger("@co", 3, 0)).toEqual({ text: "", caret: 0 });
		expect(removeTrigger("oi @co", 6, 3)).toEqual({ text: "oi ", caret: 3 });
	});
	it("no meio do texto: um espaço só entre os dois lados", () => {
		expect(removeTrigger("oi @co tchau", 6, 3)).toEqual({ text: "oi tchau", caret: 3 });
	});
	it("só espaço antes e nada depois zera o começo", () => {
		expect(removeTrigger("  /re", 5, 2)).toEqual({ text: "", caret: 0 });
	});
});

describe("mentionableBots", () => {
	const make = (id: string, name: string, memberIds: string[] = []): HomeBot => ({
		id, name, color: "#fff", shape: "round", pinned: false, pinOrder: null, sectionId: null, memberIds, isPrimary: false,
		conversationId: null, language: null, unread: false, lastAt: null, preview: "", previewSent: false,
	});
	const all = [make("a", "A"), make("b", "B"), make("g", "G", ["a", "b"]), make("c", "C")];
	it("no 1:1 oferece os outros bots, sem o atual nem os grupos", () => {
		expect(mentionableBots(all, all[0]).map((b) => b.id)).toEqual(["b", "c"]);
	});
	it("num grupo oferece os membros", () => {
		expect(mentionableBots(all, all[2]).map((b) => b.id)).toEqual(["a", "b"]);
	});
	it("sem bot atual não oferece nada", () => {
		expect(mentionableBots(all, undefined)).toEqual([]);
	});
});
