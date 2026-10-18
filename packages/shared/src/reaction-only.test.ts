import { describe, expect, test } from "vitest";
import {
	BOT_REACTION_EMOJIS,
	REACTION_ONLY_EMOJI,
	assistantAskedSomething,
	classifyReactionOnly,
	isAmbiguousShortMessage,
	normalizeReactionEmoji,
	reactionOnlyBlock,
	toBotReactionEmoji,
	type ReactionGuardContext,
} from "./reaction-only.js";
import { resolveEffectiveConfig } from "./effective-config.js";
import { validateAccountConfigPatch } from "./account-config.js";

describe("conjunto fixo de reações do bot", () => {
	test("são exatamente 6 e tudo que o mapeador devolve pertence a elas", () => {
		expect([...BOT_REACTION_EMOJIS]).toEqual(["❤️", "😂", "👍", "👎", "🙏", "😮"]);
		for (const emoji of Object.values(REACTION_ONLY_EMOJI)) expect(BOT_REACTION_EMOJIS).toContain(emoji);
	});
	test("fora do conjunto vira 👍", () => {
		expect(toBotReactionEmoji("🌙")).toBe("👍");
		expect(toBotReactionEmoji(undefined)).toBe("👍");
		expect(toBotReactionEmoji("🙏")).toBe("🙏");
	});
});

describe("camada 1: só aceno/agradecimento/riso/despedida/emoji", () => {
	const positives: Array<[string, string]> = [
		["ok", "👍"], ["Okk", "👍"], ["okkkk!", "👍"], ["blz", "👍"], ["beleza", "👍"], ["show", "👍"], ["top", "👍"], ["ok, entendi", "👍"],
		["valeu", "❤️"], ["valeu!", "❤️"], ["vlw", "❤️"], ["obrigado", "❤️"], ["Obrigada!!", "❤️"], ["brigado", "❤️"], ["tmj", "❤️"], ["muito obrigado", "❤️"], ["ok, valeu", "❤️"], ["valeu! 🙏", "❤️"],
		["kkk", "😂"], ["kkkkkkk", "😂"], ["haha", "😂"], ["hahaha", "😂"], ["rsrs", "😂"], ["😂", "😂"],
		["boa noite", "👍"], ["até amanhã", "👍"], ["tchau", "👍"], ["👍", "👍"], ["👍🏽", "👍"], ["❤️", "❤️"], ["🙏", "❤️"], ["👍👍", "👍"],
	];
	test.each(positives)("%s => %s", (text, emoji) => {
		expect(classifyReactionOnly(text)?.emoji).toBe(emoji);
	});

	const negatives = [
		"ok, manda o relatório", "valeu, e o estoque?", "ok?", "ok!?", "certo?", "obrigado, mas está errado", "ok 3", "ok https://x.com",
		"oi", "bom dia", "sim", "não", "pode fazer", "", "   ", "😡", "😭", "👎", "ok\nmanda", "@bot ok", "/ok",
		"valeu mas preciso de outra coisa", "kkk e agora?",
	];
	test.each(negatives)("%j não é só reação", (text) => {
		expect(classifyReactionOnly(text)).toBeNull();
	});
});

describe("camada 2: portão de mensagens curtas ambíguas", () => {
	test.each(["boa essa", "interessante", "vou ver isso depois", "show de bola hein", "fechou então"])("%s passa", (text) => {
		expect(isAmbiguousShortMessage(text)).toBe(true);
	});
	test.each([
		"ok?", "manda o relatório", "qual o estoque", "preciso de ajuda", "isso está errado", "uma frase bem mais longa do que oito palavras com certeza aqui",
		"veja 12", "https://a.b", "ok\nok", "", "faz isso", "não",
	])("%j não passa", (text) => {
		expect(isAmbiguousShortMessage(text)).toBe(false);
	});
});

describe("fala anterior do assistente", () => {
	test("pergunta ou pedido", () => {
		expect(assistantAskedSomething("Quer que eu envie?")).toBe(true);
		expect(assistantAskedSomething("Me avise quando terminar")).toBe(true);
		expect(assistantAskedSomething("Pronto, enviei o relatório.")).toBe(false);
	});
});

describe("travas", () => {
	const now = new Date("2026-10-17T12:00:00Z");
	const base: ReactionGuardContext = {
		enabled: true, origin: "chat", silent: false, hasAttachments: false, hasDecisionConfirm: false, isGroup: false,
		hasActiveRun: false, hasPendingCard: false, now,
		previous: { role: "assistant", text: "Enviei o relatório.", at: new Date("2026-10-17T11:50:00Z") },
	};
	test("liberado no caso comum", () => expect(reactionOnlyBlock(base)).toBeNull());
	const cases: Array<[string, Partial<ReactionGuardContext>]> = [
		["disabled", { enabled: false }],
		["origin", { origin: "routine" }],
		["silent", { silent: true }],
		["attachments", { hasAttachments: true }],
		["confirm", { hasDecisionConfirm: true }],
		["group", { isGroup: true }],
		["active-run", { hasActiveRun: true }],
		["pending-card", { hasPendingCard: true }],
		["no-context", { previous: null }],
		["no-context", { previous: { role: "user", text: "oi", at: new Date("2026-10-17T11:59:00Z") } }],
		["stale", { previous: { role: "assistant", text: "ok", at: new Date("2026-10-16T11:00:00Z") } }],
		["asked", { previous: { role: "assistant", text: "Posso enviar agora?", at: new Date("2026-10-17T11:59:00Z") } }],
	];
	test.each(cases)("bloqueia: %s", (reason, patch) => {
		expect(reactionOnlyBlock({ ...base, ...patch })).toBe(reason);
	});
});

describe("emoji de reação", () => {
	test("aceita emoji e rejeita texto", () => {
		expect(normalizeReactionEmoji("❤️")).toBe("❤️");
		expect(normalizeReactionEmoji("👍🏽")).toBe("👍🏽");
		expect(normalizeReactionEmoji("🇧🇷")).toBe("🇧🇷");
		expect(normalizeReactionEmoji("a")).toBeNull();
		expect(normalizeReactionEmoji("👍 ok")).toBeNull();
		expect(normalizeReactionEmoji("")).toBeNull();
		expect(normalizeReactionEmoji(5)).toBeNull();
	});
});

describe("configuração da conta", () => {
	test("padrão ligado e valida booleano", () => {
		const effective = resolveEffectiveConfig({ user: { config: null }, env: {} });
		expect(effective.execution.reactionOnly).toEqual({ value: true, source: "default" });
		const off = resolveEffectiveConfig({ user: { config: { v: 1, execution: { reactionOnly: false } } }, env: {} });
		expect(off.execution.reactionOnly.value).toBe(false);
		expect(validateAccountConfigPatch({ execution: { reactionOnly: false } }).ok).toBe(true);
		expect(validateAccountConfigPatch({ execution: { reactionOnly: "x" } }).ok).toBe(false);
	});
});
