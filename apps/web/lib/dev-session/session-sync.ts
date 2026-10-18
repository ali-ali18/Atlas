import type { DevSessionStatusValue } from "@workspace/shared";

import { getDevSessionDetail, getDevSessionEvents, listDevSessions } from "@/lib/atlas-api";
import type { Message } from "@/components/ui/templates/template-4/data";

import { insertDevSessionCards } from "./cards";
import { getDevSessionSnapshot, hydrateDevSessionFromApi, hydrateDevSessionHistory } from "./store";

export const SESSION_SYNC_MS = 5_000;

type Listed = { id: string; status: DevSessionStatusValue; startedAt: string };

/**
 * Sessões da conversa que a aba ainda não conhece (criadas por outro run, rotina ou
 * dispositivo) ou cujo status mudou fora do stream. Com run ao vivo o stream é a fonte do status.
 */
export function sessionsNeedingSync<T extends Listed>(
	listed: readonly T[],
	known: Readonly<Record<string, { status: DevSessionStatusValue; runActive?: boolean } | undefined>>,
	runLive: boolean,
): T[] {
	return listed.filter((session) => {
		const view = known[session.id];
		if (!view) return true;
		if (runLive || view.runActive) return false;
		return view.status !== session.status;
	});
}

/** Traz para a conversa as sessões novas/alteradas: hidrata o painel e insere o cartão. */
export async function syncConversationDevSessions(
	conversationId: string,
	options: { runLive: boolean; setMessages: (update: (previous: Message[]) => Message[]) => void; isStale: () => boolean },
): Promise<void> {
	const listed = await listDevSessions(conversationId);
	if (options.isStale()) return;
	const todo = sessionsNeedingSync(listed, getDevSessionSnapshot().sessions, options.runLive);
	if (todo.length === 0) return;
	await Promise.all(
		todo.map(async (session) => {
			const [detail, history] = await Promise.all([
				getDevSessionDetail(session.id).catch(() => null),
				getDevSessionEvents(session.id).catch(() => null),
			]);
			if (history) hydrateDevSessionHistory(history.events);
			hydrateDevSessionFromApi(
				{
					id: session.id,
					status: session.status,
					tier: session.tier,
					repo: session.repo,
					branch: session.branch,
					startedAt: session.startedAt,
					lastActiveAt: session.lastActiveAt,
					...(detail ? { todos: detail.todos, stats: detail.stats, pr: detail.pr } : {}),
				},
				{ authoritativeStatus: true },
			);
		}),
	);
	if (options.isStale()) return;
	options.setMessages((previous) => insertDevSessionCards(previous, todo));
}
