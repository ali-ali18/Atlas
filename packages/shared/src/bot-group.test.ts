import { describe, expect, it } from "vitest";
import {
	GROUP_MAX_DEPTH,
	GROUP_MENTION_MAX_REPLIES,
	GROUP_ROUTED_MAX_REPLIES,
	GROUP_TURN_MAX_BOT_REPLIES,
	activeMentionQuery,
	buildGroupSection,
	buildGroupTurnPrompt,
	filterMentionCandidates,
	groupTranscriptForBot,
	mentionedBotIds,
	normalizeGroupMemberIds,
	parseGroupMentions,
	parseGroupRouterReply,
	planGroupFollowUps,
	routeGroupMessage,
	splitGroupMentions,
	type GroupMember,
} from "./bot-group.js";

const ana: GroupMember = { id: "ana", name: "Ana", description: "Coordena o time e delega", isPrimary: true };
const bia: GroupMember = { id: "bia", name: "Bia", description: "Financeiro: contas a pagar, fluxo de caixa e notas fiscais" };
const caio: GroupMember = { id: "caio", name: "Caio Souza", description: "Vendas e propostas comerciais para clientes" };
const members = [ana, bia, caio];

describe("parseGroupMentions", () => {
	it("acha menções por nome, sem acento nem caixa", () => {
		const mentions = parseGroupMentions("@bia e @CAIO, vejam isso", members);
		expect(mentions.map((m) => m.botId)).toEqual(["bia", "caio"]);
		expect(mentions[0]).toMatchObject({ start: 0, end: 4 });
	});

	it("aceita a primeira palavra de nome composto quando única", () => {
		expect(mentionedBotIds("@Caio pode ver?", members)).toEqual(["caio"]);
		expect(mentionedBotIds("@Caio Souza pode ver?", members)).toEqual(["caio"]);
	});

	it("não casa primeira palavra ambígua", () => {
		const twins: GroupMember[] = [
			{ id: "a", name: "Ana Paula" },
			{ id: "b", name: "Ana Luiza" },
		];
		expect(mentionedBotIds("@Ana oi", twins)).toEqual([]);
		expect(mentionedBotIds("@Ana Luiza oi", twins)).toEqual(["b"]);
	});

	it("exige limite de palavra e ignora e-mail e código", () => {
		expect(mentionedBotIds("@Biance oi", members)).toEqual([]);
		expect(mentionedBotIds("fale com bia@empresa.com", members)).toEqual([]);
		expect(mentionedBotIds("```\n@Bia\n```", members)).toEqual([]);
		expect(mentionedBotIds("ok @Bia.", members)).toEqual(["bia"]);
	});

	it("deduplica ids e mantém a ordem", () => {
		expect(mentionedBotIds("@Bia @Ana @Bia", members)).toEqual(["bia", "ana"]);
	});
});

describe("splitGroupMentions", () => {
	it("separa texto e chips", () => {
		expect(splitGroupMentions("oi @Bia, tudo?", members)).toEqual([
			{ type: "text", text: "oi " },
			{ type: "mention", text: "@Bia", botId: "bia" },
			{ type: "text", text: ", tudo?" },
		]);
	});
	it("sem menção devolve um trecho só", () => {
		expect(splitGroupMentions("oi", members)).toEqual([{ type: "text", text: "oi" }]);
	});
});

describe("autocompletar", () => {
	it("detecta a consulta antes do cursor", () => {
		expect(activeMentionQuery("oi @bi", 6)).toEqual({ query: "bi", start: 3 });
		expect(activeMentionQuery("oi @", 4)).toEqual({ query: "", start: 3 });
		expect(activeMentionQuery("a@b", 3)).toBeNull();
		expect(activeMentionQuery("oi @bia olá", 11)).toEqual({ query: "bia olá", start: 3 });
		expect(activeMentionQuery("oi\n@x\ny", 7)).toBeNull();
	});
	it("filtra membros por prefixo de qualquer palavra do nome", () => {
		expect(filterMentionCandidates(members, "").map((m) => m.id)).toEqual(["ana", "bia", "caio"]);
		expect(filterMentionCandidates(members, "so").map((m) => m.id)).toEqual(["caio"]);
		expect(filterMentionCandidates(members, "B").map((m) => m.id)).toEqual(["bia"]);
	});
});

describe("routeGroupMessage", () => {
	it("menção vence: só os mencionados respondem", () => {
		const route = routeGroupMessage({ text: "@Bia quanto deu o caixa?", members });
		expect(route).toEqual({ ids: ["bia"], reason: "user_mention", needsLlm: false });
	});

	it("limita as menções do usuário", () => {
		const many: GroupMember[] = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, name: `Bot${i}x` }));
		const text = many.map((m) => `@${m.name}`).join(" ");
		expect(routeGroupMessage({ text, members: many }).ids).toHaveLength(GROUP_MENTION_MAX_REPLIES);
	});

	it("nome citado sem @ também endereça", () => {
		expect(routeGroupMessage({ text: "Bia, como estão as contas?", members })).toMatchObject({ ids: ["bia"], reason: "named" });
	});

	it("sinal forte de papel escolhe por descrição (até 2)", () => {
		const route = routeGroupMessage({ text: "preciso das notas fiscais e do fluxo de caixa deste mês", members });
		expect(route.ids).toEqual(["bia"]);
		expect(route.reason).toBe("router");
		expect(route.ids.length).toBeLessThanOrEqual(GROUP_ROUTED_MAX_REPLIES);
	});

	it("sem sinal usa o bot principal", () => {
		expect(routeGroupMessage({ text: "bom dia, tudo bem?", members })).toEqual({ ids: ["ana"], reason: "primary", needsLlm: false });
	});

	it("sem principal e sem sinal pede o roteador LLM, com o primeiro membro de reserva", () => {
		const route = routeGroupMessage({ text: "hmm", members: [bia, caio] });
		expect(route).toEqual({ ids: ["bia"], reason: "router", needsLlm: true });
	});

	it("sem principal e com um sinal fraco único escolhe esse membro", () => {
		const route = routeGroupMessage({ text: "mande a proposta", members: [bia, caio] });
		expect(route).toEqual({ ids: ["caio"], reason: "router", needsLlm: false });
	});
});

describe("parseGroupRouterReply", () => {
	it("lê JSON com ids", () => {
		expect(parseGroupRouterReply('{"bots":["bia","caio","zzz"]}', members)).toEqual(["bia", "caio"]);
	});
	it("lê JSON dentro de texto e por nome", () => {
		expect(parseGroupRouterReply('Claro: {"bots":["Caio Souza"]}', members)).toEqual(["caio"]);
	});
	it("cai para nomes soltos e respeita o teto", () => {
		expect(parseGroupRouterReply("Ana e Bia e Caio Souza", members)).toHaveLength(GROUP_ROUTED_MAX_REPLIES);
	});
	it("lixo vira lista vazia", () => {
		expect(parseGroupRouterReply("não sei", members)).toEqual([]);
	});
});

describe("planGroupFollowUps", () => {
	const base = { members, authorId: "ana", depth: 1, turnReplyCount: 1, queuedBotIds: [] as string[] };

	it("menção a outro membro dispara com depth+1", () => {
		expect(planGroupFollowUps({ ...base, text: "@Bia confere o caixa?" })).toEqual([{ botId: "bia", depth: 2 }]);
	});

	it("nunca dispara a si mesmo", () => {
		expect(planGroupFollowUps({ ...base, text: "eu, @Ana, resolvo" })).toEqual([]);
	});

	it("respeita a profundidade máxima", () => {
		expect(planGroupFollowUps({ ...base, depth: GROUP_MAX_DEPTH, text: "@Bia" })).toEqual([]);
		expect(planGroupFollowUps({ ...base, depth: GROUP_MAX_DEPTH - 1, text: "@Bia" })).toEqual([{ botId: "bia", depth: GROUP_MAX_DEPTH }]);
	});

	it("respeita o teto de respostas por turno", () => {
		expect(planGroupFollowUps({ ...base, turnReplyCount: GROUP_TURN_MAX_BOT_REPLIES, text: "@Bia" })).toEqual([]);
		const out = planGroupFollowUps({ ...base, turnReplyCount: GROUP_TURN_MAX_BOT_REPLIES - 1, text: "@Bia @Caio" });
		expect(out).toEqual([{ botId: "bia", depth: 2 }]);
	});

	it("não repete quem já está na fila do turno", () => {
		expect(planGroupFollowUps({ ...base, queuedBotIds: ["bia"], text: "@Bia @Caio" })).toEqual([{ botId: "caio", depth: 2 }]);
	});
});

describe("groupTranscriptForBot", () => {
	it("falas do membro viram assistant; as demais, user com autor", () => {
		const out = groupTranscriptForBot(
			[
				{ role: "user", content: "Quanto deu o caixa?" },
				{ role: "assistant", content: "Vou ver.", fromBotId: "ana", fromBotName: "Ana" },
				{ role: "assistant", content: "Deu R$ 10 mil.", fromBotId: "bia", fromBotName: "Bia" },
				{ role: "user", content: "Obrigado" },
			],
			"ana",
		);
		expect(out).toEqual([
			{ role: "user", content: "Usuário: Quanto deu o caixa?" },
			{ role: "assistant", content: "Vou ver." },
			{ role: "user", content: "Bia: Deu R$ 10 mil.\n\nUsuário: Obrigado" },
		]);
	});

	it("respeita o limite e ignora vazios e papéis internos", () => {
		const rows = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const out = groupTranscriptForBot([...rows, { role: "bot-link", content: "{}" }, { role: "user", content: "  " }], "ana", 5);
		expect(out).toHaveLength(1);
		expect(out[0]!.content.split("m").length - 1).toBe(3);
	});
});

describe("prompts", () => {
	it("seção do grupo lista membros, marca o próprio e o principal, e não cita o produto", () => {
		const text = buildGroupSection({ groupName: "Time", selfId: "bia", members });
		expect(text).toContain('GRUPO "Time"');
		expect(text).toContain("- Bia (você)");
		expect(text).toContain("- Ana [principal]");
		expect(text).toContain("@Nome");
		expect(text).not.toMatch(/atlas/i);
	});

	it("prompt do turno varia conforme o motivo", () => {
		expect(buildGroupTurnPrompt({ groupName: "Time", reason: "user_mention" })).toContain("mencionou você");
		expect(buildGroupTurnPrompt({ groupName: "Time", reason: "bot_mention", fromName: "Ana" })).toContain("Ana mencionou você");
		expect(buildGroupTurnPrompt({ groupName: "Time", reason: "primary" })).toContain("encaminhada");
	});
});

describe("normalizeGroupMemberIds", () => {
	it("exige de 2 a 8 ids únicos", () => {
		expect(normalizeGroupMemberIds(["a"])).toBeNull();
		expect(normalizeGroupMemberIds(["a", "a"])).toBeNull();
		expect(normalizeGroupMemberIds(["a", "b", "a"])).toEqual(["a", "b"]);
		expect(normalizeGroupMemberIds(["a", 3])).toBeNull();
		expect(normalizeGroupMemberIds(Array.from({ length: 9 }, (_, i) => `m${i}`))).toBeNull();
	});
});
