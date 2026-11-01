import { GROUP_NO_WAIT_RULE, mentionedBotIds, parseGroupMentions, type GroupMember } from "./bot-group.js";

/**
 * Grupos: coordenação inteligente (opt-in, decidida pelo Jev). Regras puras:
 * perguntas sim/não de roteamento, decisão por probabilidade, partição de subtarefas
 * a partir das @menções do coordenador e prompts de cada papel. Sem I/O.
 */

/** Probabilidade mínima para um "sim" do Jev valer. */
export const GROUP_JEV_THRESHOLD = 0.6;
/** Teto de respostas de bots por turno no modo coordenado (coordenador, membros, retentativas e resumo). */
export const GROUP_JEV_TURN_MAX_REPLIES = 8;
/** Subtarefas entregues a membros por turno (o resto fica de fora). */
export const GROUP_JEV_MAX_WORKERS = 5;
/** Retentativas por membro depois de a verificação reprovar. */
export const GROUP_JEV_MAX_RETRIES = 1;

export type GroupReplyRole = "coordinator" | "worker" | "summary";

export type JevQuestionDef = { instructions: string; criteria: { true: string; false: string } };

const oneLine = (value: string, max: number): string => value.replace(/\s+/g, " ").trim().slice(0, max);

export const JEV_KEY_GROUP_WIDE = "group_wide";
export const JEV_KEY_MULTI_TASK = "multi_task";
export const jevMemberKey = (id: string): string => `member_${id}`;

/** Perguntas do roteamento: uma por membro + "todos?" + "tarefa de vários membros?". */
export function buildJevRoutingQuestions(members: readonly GroupMember[]): Record<string, JevQuestionDef> {
	const questions: Record<string, JevQuestionDef> = {};
	for (const member of members) {
		const about = oneLine(member.description?.trim() || member.snippet?.trim() || "sem descrição", 140);
		questions[jevMemberKey(member.id)] = {
			instructions: `Esta mensagem pede ou se beneficia de uma resposta/ação de ${oneLine(member.name, 60)} (${about})?`,
			criteria: { true: "A mensagem é da área dele ou pede algo que ele faz", false: "Não tem relação com ele" },
		};
	}
	questions[JEV_KEY_GROUP_WIDE] = {
		instructions: "Esta mensagem é dirigida ao grupo todo / pede que todos respondam?",
		criteria: { true: "Todos os membros devem responder", false: "Só alguns membros precisam responder" },
	};
	questions[JEV_KEY_MULTI_TASK] = {
		instructions: "É um pedido de tarefa que envolve trabalho de mais de um membro?",
		criteria: { true: "A tarefa pode ser dividida entre vários membros", false: "Um membro só resolve" },
	};
	return questions;
}

export function jevRoutingState(text: string, members: readonly GroupMember[]): unknown {
	return {
		userMessage: text.slice(0, 1_500),
		members: members.map((member) => ({
			name: oneLine(member.name, 60),
			about: oneLine(member.description?.trim() || member.snippet?.trim() || "", 140),
		})),
	};
}

export type JevRouteDecision = {
	mode: "coordinate" | "group_wide" | "members";
	/** Em `coordinate`, o único id é o coordenador. */
	ids: string[];
	scores: Record<string, number>;
};

/** Escolhe quem responde a partir das probabilidades do Jev (sem rede). */
export function decideJevRoute(input: {
	members: readonly GroupMember[];
	answers: Readonly<Record<string, number>>;
	threshold?: number;
}): JevRouteDecision {
	const threshold = input.threshold ?? GROUP_JEV_THRESHOLD;
	const { members, answers } = input;
	const scores: Record<string, number> = {};
	for (const member of members) scores[member.id] = answers[jevMemberKey(member.id)] ?? 0;
	const ranked = [...members].sort((a, b) => scores[b.id]! - scores[a.id]!);
	const primary = members.find((member) => member.isPrimary);
	const best = ranked[0];
	if (!best) return { mode: "members", ids: [], scores };
	const pickOne = primary?.id ?? best.id;
	if ((answers[JEV_KEY_MULTI_TASK] ?? 0) >= threshold && members.length >= 2) {
		return { mode: "coordinate", ids: [pickOne], scores };
	}
	if ((answers[JEV_KEY_GROUP_WIDE] ?? 0) >= threshold) {
		const ordered = [...members].sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
		return { mode: "group_wide", ids: ordered.slice(0, GROUP_JEV_TURN_MAX_REPLIES).map((member) => member.id), scores };
	}
	const picked = ranked.filter((member) => scores[member.id]! >= threshold).slice(0, GROUP_JEV_TURN_MAX_REPLIES);
	return { mode: "members", ids: picked.length > 0 ? picked.map((member) => member.id) : [pickOne], scores };
}

export type GroupAssignment = { botId: string; subtask: string };

/**
 * Subtarefas da fala do coordenador: cada linha com @menção a outro membro vira a
 * entrega dele (o texto da linha sem a menção). Um membro citado em várias linhas
 * junta as subtarefas. O coordenador nunca se atribui.
 */
export function parseCoordinatorAssignments(input: {
	text: string;
	members: readonly GroupMember[];
	coordinatorId: string;
	max?: number;
}): GroupAssignment[] {
	const max = input.max ?? GROUP_JEV_MAX_WORKERS;
	const byBot = new Map<string, string[]>();
	let inFence = false;
	for (const line of input.text.split("\n")) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !line.includes("@")) continue;
		const mentions = parseGroupMentions(line, input.members).filter((mention) => mention.botId !== input.coordinatorId);
		if (mentions.length === 0) continue;
		let rest = line;
		for (const mention of [...mentions].sort((a, b) => b.start - a.start)) rest = rest.slice(0, mention.start) + rest.slice(mention.end);
		let subtask = oneLine(rest.replace(/^[\s>*\-–—•\d.):,;]+/, "").replace(/\s+([,.;:])/g, "$1"), 300);
		subtask = subtask.replace(/^(e|,|:|-)\s+/i, "").trim();
		if (!subtask) subtask = oneLine(line, 300);
		for (const botId of new Set(mentions.map((mention) => mention.botId))) {
			byBot.set(botId, [...(byBot.get(botId) ?? []), subtask]);
		}
	}
	return [...byBot.entries()].slice(0, max).map(([botId, parts]) => ({ botId, subtask: oneLine(parts.join("; "), 400) }));
}

/** O texto atribui trabalho a algum outro membro? */
export function hasAssignments(text: string, members: readonly GroupMember[], coordinatorId: string): boolean {
	return mentionedBotIds(text, members).some((id) => id !== coordinatorId);
}

export function buildJevVerifyQuestions(input: { name: string; subtask: string }): Record<string, JevQuestionDef> {
	return {
		fulfilled: {
			instructions: `A resposta de ${oneLine(input.name, 60)} cumpre a subtarefa '${oneLine(input.subtask, 300)}'?`,
			criteria: { true: "A resposta entrega o que a subtarefa pedia", false: "A resposta não entrega, está incompleta ou fugiu do pedido" },
		},
	};
}

export function jevVerifyState(input: { subtask: string; reply: string }): unknown {
	return { subtask: oneLine(input.subtask, 400), reply: input.reply.slice(0, 3_000) };
}

/** Texto do empurrão de retentativa ("faltou: …"). */
export function buildRetryNudge(subtask: string): string {
	return `faltou: entregar de fato a subtarefa "${oneLine(subtask, 300)}", com o resultado concreto e não só um plano ou um comentário.`;
}

const groupQuoted = (name: string): string => `"${oneLine(name, 80)}"`;

/** Cobrança de uma rodada para o membro que devolveu pergunta/"aguardando" em vez de entregar. */
export const GROUP_NUDGE_RULE =
	"Do not wait; use the original request and what was already said in the group; assume the most reasonable option and deliver; list your assumptions.";
/** Para o resumo: membro que não entregou entra em uma linha e o resumo sai com o que há. */
export const GROUP_SUMMARY_MISSING_RULE =
	"If a member did not deliver, say so in one line and deliver with what you have; never say the next step is to wait.";

/** Última mensagem do turno por papel (coordenador, membro, retentativa e resumo). */
export function buildGroupRolePrompt(input: {
	role: GroupReplyRole;
	groupName: string;
	members: readonly GroupMember[];
	selfId: string;
	coordinatorName?: string | null;
	subtask?: string | null;
	attempt?: number;
	workerNames?: readonly string[];
	/** Cobrança: a resposta anterior do membro não entregou (pergunta ou "aguardando"). */
	nudge?: boolean;
	/** Resumo: membros que não entregaram, com o motivo curto (inglês). */
	missing?: ReadonlyArray<{ name: string; reason: string }>;
}): string {
	const group = groupQuoted(input.groupName);
	if (input.role === "coordinator") {
		const others = input.members.filter((member) => member.id !== input.selfId);
		const list = others
			.map((member) => `- @${oneLine(member.name, 60)}${member.description?.trim() ? `: ${oneLine(member.description, 100)}` : ""}`)
			.join("\n");
		return [
			`[Grupo ${group}] O usuário delegou uma tarefa ao grupo e você é o coordenador.`,
			'Divida o trabalho e atribua cada parte com @Nome, UMA LINHA POR MEMBRO, cada linha com a entrega esperada, por exemplo: "@Nome faça X e entregue Y".',
			"Não faça a parte dos outros. Chame só quem de fato é necessário. Você não executa as partes deles; depois que todos responderem, você escreve o resumo final.",
			"Membros disponíveis:",
			list,
			GROUP_NO_WAIT_RULE,
		].join("\n");
	}
	if (input.role === "worker") {
		const from = input.coordinatorName ? oneLine(input.coordinatorName, 60) : "O coordenador";
		const lines = [`[Grupo ${group}] ${from} atribuiu esta subtarefa a você: ${oneLine(input.subtask ?? "", 400)}`];
		if (input.nudge) {
			lines.push(`Your previous reply did not deliver it. ${GROUP_NUDGE_RULE}`);
		} else if ((input.attempt ?? 1) > 1) {
			lines.push(`Sua resposta anterior não cumpriu a subtarefa. ${buildRetryNudge(input.subtask ?? "")}`);
		}
		lines.push("Faça só a sua parte, use suas ferramentas se precisar e poste o resultado no grupo. Não mencione outros membros nem delegue.", GROUP_NO_WAIT_RULE);
		return lines.join("\n");
	}
	const names = (input.workerNames ?? []).map((name) => oneLine(name, 60)).join(", ");
	const missing = (input.missing ?? []).map((item) => `${oneLine(item.name, 60)} did not deliver: ${oneLine(item.reason, 100)}`);
	return [
		`[Grupo ${group}] Os membros${names ? ` (${names})` : ""} terminaram as subtarefas que você atribuiu.`,
		"Escreva agora o resumo final para o usuário: o que foi entregue por cada um, o que ficou pendente (se algo) e o próximo passo. Seja curto e consolidado.",
		"Não use @menções e não peça mais nada a ninguém.",
		...(missing.length > 0 ? [`Not delivered: ${missing.join("; ")}.`] : []),
		GROUP_SUMMARY_MISSING_RULE,
	].join("\n");
}
