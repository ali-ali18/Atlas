// Cartões de rotina, alerta e gatilho no fio (puro, testado em routine-cards.test.ts): do que o servidor grava ou emite
// ao que a tela desenha. Três passos, nesta ordem, aplicados à lista já reconciliada (ao vivo + gravado):
//   1. `settleRoutineCards`: o cartão reflete o estado ATUAL da rotina. Pausa, retomada, edição ou exclusão que chega
//      depois de um cartão da mesma rotina não vira cartão novo: muda o estado do anterior (como no Grok).
//   2. `groupRoutineCards`: cartões de rotina seguidos (2 ou mais, mesmo substantivo) viram UMA linha no fio
//      ("Pausou 7 rotinas"); tocar abre a gaveta com cada cartão.
//   3. a tela desenha `routine` (cartão) e `routine-group` (linha).
import { type PersistedRoutineCard, type PersistedRoutineProposalCard, describeRoutineProposalSchedule } from "@workspace/shared";
import type { ChatItem, RoutineCardItem, RoutineListed, RoutineNoun, RoutineSettled, RoutineState, RoutineTrigger } from "./chat-types";
import { cronSentence } from "./routine-summary";

type RoutineItem = RoutineCardItem;
type ProposalItem = Extract<ChatItem, { kind: "routine-proposal" }>;
type GroupItem = Extract<ChatItem, { kind: "routine-group" }>;

/** Quantos cartões seguidos já viram uma linha (um par também: 1 cartão fica cartão). */
export const ROUTINE_GROUP_MIN = 2;
/** Acima disto a gaveta abre em altura cheia (e rola). */
export const ROUTINE_SHEET_FULL_AFTER = 6;

const MAX_LISTED = 25;
const TRIGGERS: readonly RoutineTrigger[] = ["cron", "event", "once", "interval"];

const firstLine = (detail: string | undefined): string => detail?.split("\n")[0]?.trim() ?? "";

// ---- do servidor ao item ------------------------------------------------------------------------------------------

function listedItems(raw: PersistedRoutineCard["items"]): RoutineListed[] | undefined {
	if (!raw?.length) return undefined;
	return raw.slice(0, MAX_LISTED).map((row) => ({ id: row.id, name: row.name, enabled: row.enabled, triggerType: row.triggerType, ...(row.schedule ? { schedule: row.schedule } : {}) }));
}

type RoutineFields = Pick<PersistedRoutineCard, "action" | "title" | "routineId" | "triggerType" | "detail" | "hookUrl" | "items">;

/**
 * Só a primeira linha do detalhe vai para o item (é a frase do agendamento ou do estado). As seguintes podem trazer o
 * secret do webhook e o prompt da rotina: não entram no item, nem no cache do aparelho. A URL do webhook também não.
 */
function storedDetail(detail: string | undefined): string | undefined {
	const first = firstLine(detail).slice(0, 200);
	if (!first) return undefined;
	return first.startsWith("Webhook:") || first.startsWith("Header:") ? "Webhook" : first;
}

/** Cartão `routine` gravado ou ao vivo → item. O segredo do webhook nunca entra: só se sabe que é um webhook. */
export function routineToItem(id: string, card: RoutineFields, createdAt?: string): RoutineItem {
	const items = listedItems(card.items);
	return {
		id,
		...(createdAt ? { createdAt } : {}),
		kind: "routine",
		action: card.action,
		title: card.title?.trim() || (card.action === "listed" ? "Suas rotinas" : "Rotina"),
		...(card.routineId ? { routineId: card.routineId } : {}),
		...(card.triggerType ? { triggerType: card.triggerType } : {}),
		...(storedDetail(card.detail) ? { detail: storedDetail(card.detail) } : {}),
		...(card.hookUrl ? { hook: true } : {}),
		...(items ? { items } : {}),
	};
}

/** Proposta de rotina do bot (modo proativo) → item de leitura. */
export function routineProposalToItem(id: string, card: PersistedRoutineProposalCard, createdAt?: string): ProposalItem {
	return {
		id,
		...(createdAt ? { createdAt } : {}),
		kind: "routine-proposal",
		proposalId: card.proposalId,
		mode: card.mode,
		status: card.status,
		name: card.spec.name,
		schedule: capitalize(describeRoutineProposalSchedule(card.spec)),
		...(card.routineId ? { routineId: card.routineId } : {}),
	};
}

/** Id estável do cartão ao vivo: o mesmo evento repetido (replay do stream) cai no mesmo item. */
export function liveRoutineId(runId: string | null, card: Pick<RoutineFields, "action" | "routineId" | "title" | "detail">): string {
	return `routine-${runId ?? "local"}-${card.action}-${card.routineId ?? card.title ?? ""}-${stateWord(card)}`;
}

function stateWord(card: Pick<RoutineFields, "action" | "detail">): string {
	return card.action === "created" ? "created" : firstLine(card.detail).slice(0, 40);
}

/**
 * Identidade entre ao vivo e gravado. "Criada" é uma por rotina (`routineId`). Os outros (pausa, edição…) podem se
 * repetir de verdade (pausa, retoma, pausa), então não deduplicam por chave: ver `routineSignature` no `reconcile`.
 */
export function routineCardKey(item: RoutineItem): string | null {
	return item.action === "created" ? `routine|created|${item.routineId ?? item.title}` : null;
}

/** Assinatura de um cartão que não é "criada": o ao vivo casa com o gravado igual (um por vez). */
export function routineSignature(item: RoutineItem): string {
	return `${item.action}|${item.routineId ?? ""}|${item.title}|${firstLine(item.detail)}`;
}

// ---- estado e resumo ----------------------------------------------------------------------------------------------

function capitalize(text: string): string {
	return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** Estado que o PRÓPRIO cartão conta (a primeira linha do detalhe é a frase que o servidor gravou). */
export function ownState(item: RoutineItem): RoutineState {
	if (item.action === "created") return "created";
	switch (firstLine(item.detail)) {
		case "Pausada":
			return "paused";
		case "Retomada":
			return "resumed";
		case "Apagada":
			return "deleted";
		case "Avisa a cada execução":
		case "Só avisa o que é importante":
			return "notify";
		default:
			return "edited";
	}
}

export type RoutineIcon = "webhook" | "email" | "github" | "alert" | "once" | "schedule";

/** Tipo do gatilho para o ícone: webhook, e-mail, GitHub, alerta (condição), uma vez ou recorrente. */
export function routineIcon(item: Pick<RoutineItem, "triggerType" | "detail" | "hook">): RoutineIcon {
	const first = firstLine(item.detail);
	if (first.startsWith("Alerta · ")) return "alert";
	if (item.triggerType === "event") {
		if (first.startsWith("Quando chegar e-mail")) return "email";
		if (first.startsWith("GitHub:")) return "github";
		return "webhook";
	}
	if (item.hook) return "webhook";
	return item.triggerType === "once" ? "once" : "schedule";
}

export const routineNoun = (item: Pick<RoutineItem, "triggerType" | "detail" | "hook">): RoutineNoun => (routineIcon(item) === "alert" ? "alerta" : "rotina");

/**
 * Frase do agendamento, a partir do que o agente gravou ("Cron: 0 8 * * 1 (fuso)", "A cada 50 min",
 * "Uma vez · 03/10 às 10:00", "Alerta · …", "Quando chegar e-mail…"). Sem gatilho legível: `null`, nunca o cron cru.
 */
export function routineSummaryOf(item: Pick<RoutineItem, "triggerType" | "detail" | "action">): string | null {
	const first = firstLine(item.detail);
	if (!first || first === "Pausada" || first === "Retomada" || first === "Apagada") return null;
	if (first === "Avisa a cada execução" || first === "Só avisa o que é importante") return first;
	if (first.startsWith("Alerta · ")) return first;
	if (first.startsWith("Seu dia · ")) return first.slice("Seu dia · ".length).trim() || null;
	if (first.startsWith("Cron:")) {
		const cron = /^Cron:\s+((?:\S+\s+){4}\S+)/.exec(first)?.[1];
		return cron ? cronSentence(cron) : null;
	}
	if (first.startsWith("Webhook") || first.startsWith("Header:")) return "Quando um webhook chamar";
	if (first.startsWith("GitHub:")) return `GitHub · ${first.slice("GitHub:".length).trim()}`.slice(0, 120);
	if (first.startsWith("Quando chegar e-mail")) return first;
	if (item.triggerType === "interval" || item.triggerType === "once") return capitalize(first);
	// Detalhe de edição ("Ativa: sim"): não é agendamento.
	if (first.startsWith("Ativa:")) return null;
	return capitalize(first).slice(0, 120);
}

/** Frase de uma rotina de lista: "Nos dias úteis às 9:00" não existe sem cron; usa o que o servidor mandou. */
export function listedSummary(row: RoutineListed): string | null {
	if (row.schedule && TRIGGERS.includes(row.triggerType) && row.triggerType === "cron") return cronSentence(row.schedule);
	if (row.triggerType === "event") return "Por evento";
	return row.schedule ? capitalize(row.schedule) : null;
}

export const STATE_BADGE: Record<RoutineState, { tone: "pending" | "success" | "danger" | "muted"; label: string }> = {
	created: { tone: "success", label: "Criada" },
	edited: { tone: "muted", label: "Atualizada" },
	notify: { tone: "muted", label: "Atualizada" },
	paused: { tone: "pending", label: "Pausada" },
	resumed: { tone: "success", label: "Retomada" },
	deleted: { tone: "danger", label: "Apagada" },
};

/** Selo do cartão: o estado atual (o substantivo fica no ícone e no título). */
export function badgeFor(item: RoutineItem) {
	return STATE_BADGE[item.settled?.state ?? ownState(item)];
}

// ---- 1. estado atual ----------------------------------------------------------------------------------------------

const normalizeTitle = (title: string): string => title.trim().toLocaleLowerCase("pt-BR");

/**
 * O cartão reflete o estado ATUAL da rotina. Um cartão que não é "criada" (pausa, retomada, edição, exclusão) cujo dono
 * (um cartão anterior da mesma rotina no fio) existe NÃO aparece: muda o estado do dono. A exclusão grava só o nome
 * (sem `routineId`), então casa pelo nome. Sem dono no fio (rotina criada antes, fora da página), o cartão fica.
 * Lista ("Suas rotinas") nunca é absorvida.
 */
export function settleRoutineCards(items: readonly ChatItem[]): ChatItem[] {
	const out: ChatItem[] = [];
	const owners = new Map<string, number>();
	const ownersByTitle = new Map<string, number[]>();
	const ownerOf = (item: RoutineItem): number | undefined => {
		if (item.routineId) {
			const at = owners.get(item.routineId);
			if (at !== undefined) return at;
		}
		// Sem id (exclusão): o dono mais recente de mesmo nome que ainda não foi apagado.
		const same = ownersByTitle.get(normalizeTitle(item.title)) ?? [];
		for (let i = same.length - 1; i >= 0; i -= 1) {
			const owner = out[same[i]!] as RoutineItem;
			if (item.routineId && owner.routineId && owner.routineId !== item.routineId) continue;
			if (owner.settled?.state !== "deleted") return same[i];
		}
		return undefined;
	};
	for (const item of items) {
		if (item.kind !== "routine" || item.action === "listed") {
			out.push(item);
			continue;
		}
		const own = ownState(item);
		const owner = own === "created" ? undefined : ownerOf(item);
		if (owner !== undefined) {
			const current = out[owner] as RoutineItem;
			const summary = (own === "edited" ? routineSummaryOf(item) : null) ?? current.settled?.summary ?? null;
			const state: RoutineState = own === "notify" ? (current.settled?.state ?? "created") : own === "edited" && current.settled?.state === "created" ? "edited" : own === "edited" ? (current.settled?.state ?? "edited") : own;
			out[owner] = { ...current, settled: { state, changed: true, summary } satisfies RoutineSettled };
			continue;
		}
		const settled: RoutineSettled = { state: own, changed: false, summary: routineSummaryOf(item) };
		const index = out.push({ ...item, settled }) - 1;
		if (own === "created" || own === "edited") {
			if (item.routineId) owners.set(item.routineId, index);
			const key = normalizeTitle(item.title);
			ownersByTitle.set(key, [...(ownersByTitle.get(key) ?? []), index]);
		}
	}
	return out;
}

// ---- 2. agrupar ---------------------------------------------------------------------------------------------------

/** Cartão que entra em grupo: de rotina/alerta (não a lista nem a proposta). */
const groupable = (item: ChatItem): item is RoutineItem => item.kind === "routine" && item.action !== "listed";

/**
 * Cartões de rotina SEGUIDOS do mesmo substantivo (mínimo 2) viram uma linha só. Qualquer outro item (fala, outro
 * cartão, marcador) fecha o trecho. A identidade da linha é a da primeira rotina (`routineId` ou nome), a mesma ao
 * vivo e depois de gravado.
 */
export function groupRoutineCards(items: readonly ChatItem[]): ChatItem[] {
	const out: ChatItem[] = [];
	let run: RoutineItem[] = [];
	const flush = () => {
		if (run.length >= ROUTINE_GROUP_MIN) {
			const first = run[0]!;
			out.push({ id: `routine-group:${first.routineId ?? normalizeTitle(first.title)}`, kind: "routine-group", noun: routineNoun(first), items: run, ...(first.createdAt ? { createdAt: first.createdAt } : {}) } satisfies GroupItem);
		} else out.push(...run);
		run = [];
	};
	for (const item of items) {
		if (groupable(item)) {
			if (run.length > 0 && routineNoun(run[0]!) !== routineNoun(item)) flush();
			run.push(item);
			continue;
		}
		flush();
		out.push(item);
	}
	flush();
	return out;
}

const stateOf = (item: RoutineItem): RoutineState => item.settled?.state ?? ownState(item);

const VERB: Record<RoutineState, string> = { created: "Criou", edited: "Editou", notify: "Alterou", paused: "Pausou", resumed: "Retomou", deleted: "Apagou" };
const PARTICIPLE: Record<RoutineState, { m: string; f: string }> = {
	created: { m: "criados", f: "criadas" },
	edited: { m: "editados", f: "editadas" },
	notify: { m: "alterados", f: "alteradas" },
	paused: { m: "pausados", f: "pausadas" },
	resumed: { m: "retomados", f: "retomadas" },
	deleted: { m: "apagados", f: "apagadas" },
};

export type RoutineGroupLabel = { text: string };

/**
 * Texto da linha. Todos no mesmo estado: verbo no passado ("Pausou 7 rotinas"); se o estado veio de um cartão
 * posterior (as 5 criadas foram apagadas), o estado atual vira o texto ("5 rotinas apagadas"). Estados
 * misturados: "Alterou 4 rotinas".
 */
export function routineGroupLabel(group: Pick<GroupItem, "items" | "noun">): RoutineGroupLabel {
	const { items, noun } = group;
	const plural = noun === "alerta" ? "alertas" : "rotinas";
	const states = new Set(items.map(stateOf));
	if (states.size !== 1) return { text: `Alterou ${items.length} ${plural}` };
	const state = [...states][0]!;
	const changed = items.some((item) => item.settled?.changed);
	if (changed) return { text: `${items.length} ${plural} ${PARTICIPLE[state][noun === "alerta" ? "m" : "f"]}` };
	return { text: `${VERB[state]} ${items.length} ${plural}` };
}

/** Os nomes que acompanham a linha na gaveta e na leitura em voz alta: "A, B e mais 5". */
export function routineGroupNames(items: readonly RoutineItem[], max = 3): string {
	const names = items.map((item) => item.title);
	if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}` : (names[0] ?? "");
	return `${names.slice(0, max).join(", ")} e mais ${names.length - max}`;
}

/** Todo o passo 1 + 2 para a tela. */
export function withRoutineCards(items: readonly ChatItem[]): ChatItem[] {
	return groupRoutineCards(settleRoutineCards(items));
}

/** Sentença do cartão de proposta. */
export function proposalCopy(item: ProposalItem): { badge: { tone: "pending" | "success" | "muted"; label: string }; line: string } {
	if (item.status === "accepted") return { badge: { tone: "success", label: item.mode === "auto" ? "Mantida" : "Criada" }, line: item.schedule };
	if (item.status === "declined") return { badge: { tone: "muted", label: item.mode === "auto" ? "Desfeita" : "Dispensada" }, line: item.schedule };
	return { badge: { tone: "pending", label: "Precisa de você" }, line: item.schedule };
}
