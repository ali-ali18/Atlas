import { mergeSubagentTasks, type SubagentTaskView } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { insertDevSessionCards } from "@/lib/dev-session/cards";
import { collapseSkillProposalCards } from "@/lib/skill-proposal-message";
import { collapseBotProposalCards } from "@/lib/bot-proposal-message";

/** Cartão ao vivo que, quando o servidor já gravou o equivalente, vale o gravado. */
function isDedupedLiveCard(message: Message): boolean {
	return message.kind === "images" || message.kind === "provider-fallback" || message.kind === "code-run" || message.kind === "chart" || message.kind === "task-list";
}

function cardDedupeKey(message: Message): string | null {
	if (message.kind === "images") return `images|${message.source}|${message.items.map((item) => item.artifactId).join("|")}`;
	if (message.kind === "skill") {
		return `skill|${message.action}|${message.capabilityKey ?? ""}|${message.title ?? ""}|${message.versionNumber ?? ""}|${message.draftCount ?? ""}|${message.detail ?? ""}|${JSON.stringify(message.items ?? [])}`;
	}
	if (message.kind === "routine") {
		return `routine|${message.action}|${message.routineId ?? ""}|${message.title ?? ""}|${message.triggerType ?? ""}|${message.detail ?? ""}|${message.hookUrl ?? ""}|${JSON.stringify(message.items ?? [])}`;
	}
	if (message.kind === "tool-budget") {
		// Mesmo marcador ao vivo (id do run) e persistido (id do banco) colapsam.
		return `tool-budget|${message.tool}|${message.from}|${message.to}`;
	}
	if (message.kind === "jev-status") return `jev-status|${message.id}`;
	// Marcador ao vivo (id do run) e persistido (id do banco) colapsam.
	if (message.kind === "provider-fallback") return `provider-fallback|${message.from}|${message.to}`;
	if (message.kind === "subagents") {
		// Bloco ao vivo (id do run) e persistido (id do banco) colapsam.
		return `subagents|${message.groupId}`;
	}
	if (message.kind === "devsession") return `devsession|${message.sessionId}`;
	if (message.kind === "context-summary") return `context-summary|${message.id}`;
	if (message.kind === "confirm") {
		return `confirm|${message.confirmId ?? message.id}|${message.title}`;
	}
	if (message.kind === "login") {
		return `login|${message.loginId}|${message.status ?? "pending"}`;
	}
	if (message.kind === "file") return `file|${message.artifactId}`;
	// Cartão ao vivo (id da chamada) e o gravado (id do banco) colapsam.
	if (message.kind === "code-run" && message.callId) return `code-run|${message.callId}`;
	if (message.kind === "chart") return `chart|${message.chartId}`;
	// Um cartão por run: o ao vivo (id do run) e o gravado (id do banco) colapsam.
	if (message.kind === "task-list") return `task-list|${message.runId}`;
	if (message.kind === "questionnaire") {
		return `questionnaire|${message.questionnaireId}|${message.title}`;
	}
	if (message.kind === "skill-proposal") return `skill-proposal|${message.proposal.proposalId}`;
	if (message.kind === "routine-proposal") return `routine-proposal|${message.proposalId}`;
	if (message.kind === "bot-proposal") return `bot-proposal|${message.proposal.proposalId}`;
	if (message.kind === "bot-profile-confirm") {
		return `bot-profile-confirm|${message.id}|${message.proposal.botId}|${message.proposal.fields.join(",")}`;
	}
	return null;
}

/**
 * Um grupo de subagentes (`groupId`) existe uma vez só. O bloco ao vivo
 * (id `subagents-<groupId>`) e o card salvo (id do banco) não são vizinhos
 * na lista, então a checagem por vizinho não os colapsava. Fica o card salvo,
 * na posição dele, com as tarefas mescladas.
 */
function collapseSubagentGroups(messages: Message[]): Message[] {
	type SubagentsMessage = Extract<Message, { kind: "subagents" }>;
	const groups = new Map<string, SubagentsMessage[]>();
	for (const message of messages) {
		if (message.kind !== "subagents") continue;
		groups.set(message.groupId, [...(groups.get(message.groupId) ?? []), message]);
	}
	if ([...groups.values()].every((cards) => cards.length === 1)) return messages;
	const isLive = (id: string) => id.startsWith("subagents-");
	return messages.flatMap((message): Message[] => {
		if (message.kind !== "subagents") return [message];
		const cards = groups.get(message.groupId) ?? [message];
		if (cards.length === 1) return [message];
		const keeper = cards.find((card) => !isLive(card.id)) ?? cards[0];
		if (message !== keeper) return [];
		const tasks = cards.reduce<SubagentTaskView[]>(
			(acc, card) => mergeSubagentTasks(acc, card.tasks),
			[],
		);
		return [{ ...message, tasks }];
	});
}

/** Divisores "Contexto resumido" empilhados viram um só (o último); `mergedIds` guarda os ids juntados (contagem sem repetir). */
export function collapseContextSummaries(input: Message[]): Message[] {
	const result: Message[] = [];
	for (const message of input) {
		const prev = result[result.length - 1];
		if (message.kind === "context-summary" && prev?.kind === "context-summary") {
			const ids = new Set([...(prev.mergedIds ?? [prev.id]), ...(message.mergedIds ?? [message.id])]);
			result[result.length - 1] = { ...message, mergedIds: [...ids] };
			continue;
		}
		result.push(message);
	}
	return result;
}

/** Uma sessão de desenvolvimento tem um cartão só na conversa, mesmo que ids diferentes tenham chegado (stream, sync, histórico). */
function collapseDevSessionCards(messages: Message[]): Message[] {
	const seen = new Set<string>();
	let changed = false;
	const result = messages.filter((message) => {
		if (message.kind !== "devsession") return true;
		if (seen.has(message.sessionId)) {
			changed = true;
			return false;
		}
		seen.add(message.sessionId);
		return true;
	});
	return changed ? result : messages;
}

/** Cartões que fecham o turno: a sessão de código e o pedido de aprovação de comando/escrita. */
function closesTurn(message: Message): boolean {
	return message.kind === "devsession" || (message.kind === "confirm" && !!message.devApproval);
}

/**
 * Cartão da sessão e cartão de aprovação ficam no fim do turno (antes da próxima fala do usuário),
 * abaixo do texto do agente, na ordem em que chegaram: sessão primeiro, aprovações depois. Idempotente:
 * ao vivo, no histórico e depois de reconciliar o resultado é sempre o mesmo lugar.
 */
export function settleTurnCards(messages: Message[]): Message[] {
	if (!messages.some(closesTurn)) return messages;
	const result: Message[] = [];
	let held: Message[] = [];
	const flush = () => {
		result.push(...held.filter((m) => m.kind === "devsession"), ...held.filter((m) => m.kind !== "devsession"));
		held = [];
	};
	for (const message of messages) {
		if (message.kind === "user") flush();
		if (closesTurn(message)) held.push(message);
		else result.push(message);
	}
	flush();
	return result.every((message, index) => message === messages[index]) ? messages : result;
}

/** Cards iguais consecutivos ou com o mesmo id aparecem uma vez; turnos diferentes ficam. */
export function dedupeCards(input: Message[]): Message[] {
	const messages = collapseContextSummaries(collapseBotProposalCards(collapseSkillProposalCards(collapseConfirmCards(collapseSubagentGroups(collapseDevSessionCards(input))))));
	const seenIds = new Set<string>();
	const result: Message[] = [];
	// Aviso de fallback repetido no mesmo turno (run retomado) aparece uma vez, mesmo não consecutivo.
	let turnFallbacks = new Set<string>();
	for (const message of messages) {
		if (seenIds.has(message.id)) continue;
		seenIds.add(message.id);
		if (message.kind === "user") turnFallbacks = new Set();
		if (message.kind === "provider-fallback") {
			const fallbackKey = `${message.from}>${message.to}`;
			if (turnFallbacks.has(fallbackKey)) continue;
			turnFallbacks.add(fallbackKey);
		}
		const key = cardDedupeKey(message);
		const prev = result[result.length - 1];
		if (key && prev && cardDedupeKey(prev) === key) continue;
		result.push(message);
	}
	return placeJevMarkersAboveCards(settleTurnCards(result));
}

/** Usa a thread persistida como fonte principal e mantém apenas bolhas live ainda sem equivalente. */
export function reconcilePersistedThread(persisted: Message[], live: Message[], resultText?: string | null): Message[] {
	const persistedIds = new Set(persisted.map((message) => message.id));
	const persistedImageKeys = new Set(persisted.filter((message) => isDedupedLiveCard(message)).map((message) => cardDedupeKey(message)));
	const firstOverlap = live.findIndex((message) => persistedIds.has(message.id));
	// Sem sobreposição (conversa nova, ou o fim buscado não alcança o que está na tela) o histórico antigo é só o
	// que vem ANTES do primeiro item local (otimista/stream): o resto tem a posição decidida pelas âncoras abaixo.
	const firstLocal = live.findIndex((message) => message.id.startsWith("msg-") || message.id.startsWith("cu-"));
	const olderEnd = firstOverlap >= 0 ? firstOverlap : firstLocal >= 0 ? firstLocal : live.length;
	const older = live.slice(0, olderEnd)
		.filter((message) => !message.id.startsWith("msg-") &&
			message.kind !== "devsession" &&
			!(isDedupedLiveCard(message) && persistedImageKeys.has(cardDedupeKey(message))) &&
			!(message.kind === "assistant" && message.id.startsWith("cu-") && !message.text.trim()));
	const olderIds = new Set(older.map((message) => message.id));
	const liveIds = new Set(live.map((message) => message.id));
	let lastKnownLiveIndex = -1;
	for (let index = 0; index < live.length; index += 1) {
		const item = live[index];
		if (item && persistedIds.has(item.id)) lastKnownLiveIndex = index;
	}
	let lastKnownIndex = -1;
	for (let index = 0; index < persisted.length; index += 1) {
		const item = persisted[index];
		if (item && liveIds.has(item.id)) lastKnownIndex = index;
	}
	const newPersisted = persisted.slice(lastKnownIndex + 1);
	// Otimista (msg-*) casa com qualquer bolha persistida de mesmo texto que o live ainda não conhece.
	const unknownPersisted = persisted.filter((message) => !liveIds.has(message.id));
	const newPersistedText = newPersisted
		.filter((message) => message.kind === "assistant")
		.map((message) => message.text.trim())
		.filter(Boolean)
		.join("\n\n");
	const finalPersisted = !!resultText?.trim() && newPersistedText.includes(resultText.trim());
	// Linhas persistidas que o live ainda não conhece, por texto, na ordem do servidor: casam com a otimista
	// (usuário) ou com a bolha ao vivo (assistente) e dão a posição real a quem fica.
	const unknownByText = new Map<string, string[]>();
	for (const message of unknownPersisted) {
		if (message.kind !== "user" && message.kind !== "assistant") continue;
		const key = `${message.kind}|${normalizeUserText(message.text)}`;
		unknownByText.set(key, [...(unknownByText.get(key) ?? []), message.id]);
	}
	const usedPersisted = new Set<string>();
	const takeMatch = (kind: "user" | "assistant", text: string): string | null => {
		const ids = unknownByText.get(`${kind}|${normalizeUserText(text)}`);
		const id = ids?.shift() ?? null;
		if (id) usedPersisted.add(id);
		if (id || kind !== "assistant") return id;
		return takeAssistantRange(text);
	};
	// Uma resposta = uma bolha ao vivo, mas o servidor grava um parágrafo por linha: a bolha inteira casa com
	// as linhas consecutivas do assistente cuja junção (sem olhar espaços/quebras) é o mesmo texto.
	const takeAssistantRange = (text: string): string | null => {
		const target = normalizeUserText(text);
		if (!target) return null;
		for (let start = 0; start < persisted.length; start += 1) {
			let joined = "";
			for (let end = start; end < persisted.length; end += 1) {
				const item = persisted[end];
				if (!item || item.kind !== "assistant" || liveIds.has(item.id) || usedPersisted.has(item.id)) break;
				joined = joined ? `${joined} ${normalizeUserText(item.text)}` : normalizeUserText(item.text);
				if (joined === target && end > start) {
					for (let k = start; k <= end; k += 1) usedPersisted.add(persisted[k]!.id);
					return item.id;
				}
				if (!target.startsWith(joined)) break;
			}
		}
		return null;
	};
	// Cartão de sessão ao vivo que o histórico ainda não tem: volta ao turno dele pela hora, não ao fim.
	const liveDevCards: Array<{ id: string; startedAt: string }> = [];
	// O que só existe ao vivo fica logo depois da última linha persistida que o precede NA TELA (âncora), não
	// no fim: a ordem do servidor vale para o que ele tem e a ordem de chegada para o resto. Mandar as
	// mensagens do usuário (com o run ativo) para o servidor e jogar as falas ainda não gravadas no fim
	// invertia quem falou primeiro.
	const START = "::start";
	const pending = new Map<string, Message[]>();
	let anchor = START;
	// A âncora só avança na ordem do servidor: uma fala ao vivo que casa com uma linha MAIS ANTIGA do que a que já
	// ancorou o item anterior da tela não pode puxar os seguintes para trás (a segunda mensagem do usuário ia
	// parar antes da primeira).
	const persistedOrder = new Map(persisted.map((message, index) => [message.id, index]));
	let anchorOrder = -1;
	const advanceAnchor = (id: string) => {
		const order = persistedOrder.get(id) ?? -1;
		if (order <= anchorOrder) return;
		anchor = id;
		anchorOrder = order;
	};
	for (let index = 0; index < live.length; index += 1) {
		const message = live[index];
		if (!message) continue;
		if (persistedIds.has(message.id)) {
			advanceAnchor(message.id);
			continue;
		}
		if (olderIds.has(message.id)) continue;
		if (message.kind === "devsession") {
			liveDevCards.push({ id: message.sessionId, startedAt: message.anchorAt ?? "" });
			continue;
		}
		if (isDedupedLiveCard(message) && persistedImageKeys.has(cardDedupeKey(message))) continue;
		if (message.kind === "user") {
			if (message.id.startsWith("msg-")) {
				const matched = takeMatch("user", message.text);
				if (matched) {
					advanceAnchor(matched);
					continue;
				}
			}
		} else if (message.kind === "assistant" && message.id.startsWith("cu-")) {
			if (!message.text.trim()) continue;
			if (finalPersisted && index > lastKnownLiveIndex) continue;
			// Fala intermediária que o servidor já gravou: vale a linha dele, na posição dele.
			const matched = takeMatch("assistant", message.text);
			if (matched) {
				advanceAnchor(matched);
				continue;
			}
		} else if (message.kind !== "skill" && message.kind !== "routine" &&
		message.kind !== "images" &&
		message.kind !== "tool-budget" &&
		message.kind !== "jev-status" &&
		message.kind !== "provider-fallback" &&
		message.kind !== "memory-updated" &&
		message.kind !== "code-run" &&
		message.kind !== "image-gen" &&
		message.kind !== "chart" &&
		message.kind !== "task-list" &&
		message.kind !== "subagents" &&
		message.kind !== "context-summary" &&
		message.kind !== "confirm" && message.kind !== "questionnaire" &&
		message.kind !== "skill-proposal" &&
		message.kind !== "routine-proposal" &&
		message.kind !== "bot-proposal" &&
		message.kind !== "bot-profile-confirm") {
			continue;
		}
		pending.set(anchor, [...(pending.get(anchor) ?? []), message]);
	}
	const result: Message[] = [...older, ...(pending.get(START) ?? [])];
	for (const message of persisted) {
		result.push(message, ...(pending.get(message.id) ?? []));
	}
	return dedupeCards(liveDevCards.length ? insertDevSessionCards(result, liveDevCards) : result);
}

function normalizeUserText(text: string): string {
	return text.trim().split(/\s+/).join(" ");
}

type ConfirmMessage = Extract<Message, { kind: "confirm" }>;

/**
 * Card de confirmação ao vivo (id = confirmId) e o persistido (id do banco)
 * não são vizinhos quando há marcador do Jev entre eles, então a checagem por
 * vizinho não colapsava. Um confirmId existe uma vez só: fica o persistido, na
 * posição dele.
 */
function collapseConfirmCards(messages: Message[]): Message[] {
	const groups = new Map<string, ConfirmMessage[]>();
	for (const message of messages) {
		if (message.kind !== "confirm" || !message.confirmId) continue;
		groups.set(message.confirmId, [...(groups.get(message.confirmId) ?? []), message]);
	}
	if ([...groups.values()].every((cards) => cards.length === 1)) return messages;
	return messages.filter((message) => {
		if (message.kind !== "confirm" || !message.confirmId) return true;
		const cards = groups.get(message.confirmId) ?? [message];
		if (cards.length === 1) return true;
		const keeper = cards.find((card) => card.id !== card.confirmId) ?? cards[0];
		return message === keeper;
	});
}

/** Marcadores em que o Jev segurou a ação: precisam aparecer acima do card de confirmação. */
function isConfirmationJevMarker(message: Message): boolean {
	return message.kind === "jev-status" &&
		/confirma/i.test(message.text) &&
		/JEV (pediu|indispon)/i.test(message.text);
}

/**
 * O marcador "JEV pediu confirmação" descreve o card logo abaixo dele. Vindo
 * depois do card (ordem de chegada ou de gravação), sobe para antes dele.
 * Só considera cards do mesmo turno (sem mensagem do usuário no meio).
 */
export function placeJevMarkersAboveCards(messages: Message[]): Message[] {
	const result = [...messages];
	for (let index = 0; index < result.length; index += 1) {
		const marker = result[index];
		if (!marker || !isConfirmationJevMarker(marker)) continue;
		if (result[index + 1]?.kind === "confirm") continue; // já está acima do card dele
		let cardIndex = -1;
		for (let back = index - 1; back >= 0; back -= 1) {
			const candidate = result[back];
			if (!candidate || candidate.kind === "user") break;
			if (candidate.kind !== "confirm") continue;
			const above = result[back - 1];
			if (above && isConfirmationJevMarker(above)) continue;
			cardIndex = back;
			break;
		}
		if (cardIndex < 0) continue;
		result.splice(index, 1);
		result.splice(cardIndex, 0, marker);
	}
	return result;
}
