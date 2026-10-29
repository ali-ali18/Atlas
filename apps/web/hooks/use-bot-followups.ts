"use client";

import { useCallback, useEffect, useState } from "react";
import { cancelBotFollowup, listBotFollowups, rescheduleBotFollowup, type BotFollowup } from "@/lib/atlas-api";
import { activeT } from "@/lib/i18n/active";

const REFRESH_MS = 30_000;

/**
 * Lembretes agendados do bot principal (modo proativo). Atualiza ao abrir e a cada 30 s com a aba
 * visível; cancelar tira da lista na hora e devolve se o servidor aceitou.
 */
export function useBotFollowups(botId: string | undefined, enabled: boolean) {
	const [followups, setFollowups] = useState<BotFollowup[]>([]);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		if (!botId || !enabled) {
			setFollowups([]);
			setLoaded(false);
			return;
		}
		let cancelled = false;
		const refresh = () => {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			listBotFollowups(botId)
				.then((items) => {
					if (cancelled) return;
					setFollowups(items);
					setLoaded(true);
				})
				.catch((error) => console.warn("list followups failed", error));
		};
		refresh();
		const timer = window.setInterval(refresh, REFRESH_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [botId, enabled]);

	const cancel = useCallback(
		async (followupId: string): Promise<boolean> => {
			if (!botId) return false;
			try {
				await cancelBotFollowup(botId, followupId);
				setFollowups((previous) => previous.filter((item) => item.id !== followupId));
				return true;
			} catch (error) {
				console.warn("cancel followup failed", error);
				return false;
			}
		},
		[botId],
	);

	const reschedule = useCallback(
		async (followupId: string, when: string, stage?: number): Promise<{ ok: true; movedForQuietHours: boolean } | { ok: false; error: string }> => {
			if (!botId) return { ok: false, error: activeT("errors.botUnavailable") };
			try {
				const result = await rescheduleBotFollowup(botId, followupId, when, stage);
				setFollowups((previous) =>
					previous.map((item) => (item.id === followupId ? result.followup : item)).sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
				);
				return { ok: true, movedForQuietHours: result.movedForQuietHours };
			} catch (error) {
				console.warn("reschedule followup failed", error);
				return { ok: false, error: error instanceof Error && error.message ? error.message : activeT("errors.reschedule") };
			}
		},
		[botId],
	);

	return { followups, loaded, cancel, reschedule };
}
