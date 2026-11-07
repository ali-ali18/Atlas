"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgendaAction, AgendaItemView, AgendaListResponse } from "@workspace/shared";
import { changeAgendaItem, listAgenda } from "@/lib/atlas-api";
import { useT } from "@/lib/i18n/provider";
import { performAgendaAction } from "./agenda-actions";
import { type AgendaActionResult } from "./agenda-card";
import { AgendaList } from "./agenda-list";
import { applyAgendaChange } from "./agenda-text";
import { LibrarySection } from "./library-section";

/**
 * Seção Agenda da Biblioteca. Só existe para quem usa o motor novo: enquanto o servidor não confirma (`enabled`) e
 * quando diz que não, nada é desenhado, então o app de quem não usa fica exatamente como era.
 */
export function BotAgenda({ botId, active }: { botId: string; active: boolean }) {
	const t = useT();
	const [data, setData] = useState<AgendaListResponse | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const reload = useCallback(() => {
		let stale = false;
		listAgenda(botId)
			.then((next) => {
				if (stale) return;
				setData(next);
				setLoadFailed(false);
			})
			.catch(() => {
				if (!stale) setLoadFailed(true);
			});
		return () => {
			stale = true;
		};
	}, [botId]);

	useEffect(() => {
		setData(null);
		setLoadFailed(false);
	}, [botId]);

	useEffect(() => {
		if (!active) return;
		return reload();
	}, [active, reload]);

	const onAction = useCallback(
		async (item: AgendaItemView, action: AgendaAction): Promise<AgendaActionResult> => {
			const outcome = await performAgendaAction(changeAgendaItem, item, action);
			if (outcome.result === "ok") {
				setData((current) => (current ? applyAgendaChange(current, outcome.item) : current));
			} else if (outcome.result === "gone") {
				reload();
			}
			return outcome.result;
		},
		[reload],
	);

	if (!data?.enabled) return null;
	return (
		<LibrarySection count={data.items.length} id="agenda" title={t("agenda.title")}>
			{loadFailed ? <p className="pb-2 text-caption text-muted-foreground">{t("agenda.loadError")}</p> : null}
			<AgendaList
				ended={data.ended}
				items={data.items}
				now={new Date()}
				onAction={onAction}
				timezone={data.timezone}
			/>
		</LibrarySection>
	);
}
