import { describe, expect, it } from "vitest";
import type { HomeBot } from "./home-types";
import { applyPick, composerCommands, mentionableBots, removeTrigger, triggerState } from "./mention-input";

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

describe("fechar o @", () => {
	it("espaço logo depois do arroba fecha ('custa @ 5')", () => {
		expect(triggerState("custa @ 5", 9, { bots, skills })).toBeNull();
		expect(triggerState("custa @ ", 8, { bots, skills })).toBeNull();
	});
	it("usa o cursor, não o fim do texto", () => {
		// cursor logo depois do @ no começo; o resto do texto vem depois.
		expect(triggerState("@ e mais coisa", 1, { bots, skills })?.query).toBe("");
		expect(triggerState("@co e mais coisa", 3, { bots, skills })?.query).toBe("co");
	});
});

describe("applyPick", () => {
	const at = (text: string, caret: number) => triggerState(text, caret, { bots, skills })!;
	it("gatilho no começo vira chip e tira o gatilho", () => {
		const out = applyPick("@co", 3, at("@co", 3), 0)!;
		expect(out.marker).toMatchObject({ kind: "bot", id: "b1", name: "Cookie" });
		expect(out.text).toBe("");
	});
	it("com chips antes e o gatilho no começo do texto livre também vira chip, e o resto fica", () => {
		const out = applyPick("@ana e depois", 4, at("@ana e depois", 4), 0)!;
		expect(out.marker?.kind).toBe("bot");
		expect(out.text).toBe("e depois");
	});
	it("no meio da frase insere @Nome como texto no cursor e preserva a frase", () => {
		const text = "pergunte ao @mar sobre isso";
		const state = at(text, 16);
		const out = applyPick(text, 16, state, 0)!;
		expect(out.marker).toBeNull();
		expect(out.text).toBe("pergunte ao @Ana Maria sobre isso");
		expect(out.caret).toBe("pergunte ao @Ana Maria ".length);
	});
	it("no fim da frase acrescenta o espaço", () => {
		const out = applyPick("fale com @cook", 14, at("fale com @cook", 14), 0)!;
		expect(out.text).toBe("fale com @Cookie ");
		expect(out.caret).toBe(out.text.length);
	});
	it("habilidade no meio da frase entra como /slug no texto", () => {
		const text = "faça o /res agora";
		const out = applyPick(text, 11, at(text, 11), 0)!;
		expect(out.marker).toBeNull();
		expect(out.text).toBe("faça o /resumo-do-dia agora");
	});
	it("habilidade com o limite batido não insere nada (o gatilho fica)", () => {
		expect(applyPick("/re", 3, at("/re", 3), 0, { skillsFull: true })).toBeNull();
	});
	it("bot continua valendo com o limite de habilidades batido", () => {
		expect(applyPick("@co", 3, at("@co", 3), 0, { skillsFull: true })?.marker?.kind).toBe("bot");
	});
	it("índice fora da lista não faz nada", () => {
		expect(applyPick("@", 1, at("@", 1), 9)).toBeNull();
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

describe("/compact na lista do /", () => {
	const commands = composerCommands({ compactAvailable: true });
	it("o comando só existe quando o chat sabe tratá-lo (grupo não tem)", () => {
		expect(composerCommands({ compactAvailable: false })).toEqual([]);
		expect(commands).toEqual([{ id: "command:compact", name: "compact", description: "Compactar a conversa", kind: "command" }]);
	});
	it("aparece primeiro, antes das habilidades", () => {
		const state = triggerState("/", 1, { bots, skills, commands });
		expect(state?.candidates.map((c) => c.id)).toEqual(["command:compact", "s1", "s2"]);
	});
	it("aparece mesmo sem habilidades carregadas (lista vazia)", () => {
		expect(triggerState("/", 1, { bots, skills: [], commands })?.candidates.map((c) => c.id)).toEqual(["command:compact"]);
	});
	it("filtra por prefixo: 'comp' mostra o comando, 'agen' não", () => {
		expect(triggerState("/comp", 5, { bots, skills, commands })?.candidates.map((c) => c.id)).toEqual(["command:compact"]);
		expect(triggerState("/agen", 5, { bots, skills, commands })?.candidates.map((c) => c.id)).toEqual(["s2"]);
	});
	it("sem comandos na fonte (grupo), o / não ganha nada", () => {
		expect(triggerState("/", 1, { bots, skills })?.candidates.map((c) => c.id)).toEqual(["s1", "s2"]);
	});
	it("escolher o comando tira o gatilho, não cria marcador e devolve o comando (mesmo com o limite de habilidades batido)", () => {
		const state = triggerState("/comp", 5, { bots, skills, commands })!;
		expect(applyPick("/comp", 5, state, 0, { skillsFull: true })).toEqual({ text: "", caret: 0, marker: null, command: "compact" });
	});
	it("escolher uma habilidade continua virando marcador", () => {
		const state = triggerState("/", 1, { bots, skills, commands })!;
		expect(applyPick("/", 1, state, 1)?.marker).toMatchObject({ kind: "skill", id: "s1" });
	});
});
