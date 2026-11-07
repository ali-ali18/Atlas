"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgendaAction, AgendaItemView, AgendaListResponse } from "@workspace/shared";
import { changeAgendaItem, listAgenda } from "@/lib/atlas-api";
import { useT } from "@/lib/i18n/provider";
import { useEngineV4 } from "@/lib/use-engine-v4";
import { performAgendaAction } from "./agenda-actions";
import { type AgendaActionResult } from "./agenda-card";
import { AgendaList } from "./agenda-list";
import { applyAgendaChange, hasAgendaLists } from "./agenda-text";
import { LibrarySection } from "./library-section";

/**
 * Seção Agenda da Biblioteca. Só existe quando o Motor v4 está ligado para a conta: o mesmo sinal do Caderno
 * (`useEngineV4`, uma consulta só para todas as seções). Desligado ou ainda sem resposta, nada é desenhado e nada é
 * buscado, então o app de quem não usa fica exatamente como era. `enabled` só existe para teste e prévia.
 */
export function BotAgenda({ botId, active, enabled }: { botId: string; active: boolean; enabled?: boolean }) {
	const t = useT();
	const fromServer = useEngineV4();
	const on = enabled ?? fromServer;
	const [data, setData] = useState<AgendaListResponse | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const reload = useCallback(() => {
		let stale = false;
		listAgenda(botId)
			.then((next) => {
				if (stale) return;
				// Resposta sem lista (servidor antigo, erro de proxy): trata como falha de carregamento, nunca derruba a Biblioteca.
				if (!hasAgendaLists(next)) return setLoadFailed(true);
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
		if (!active || !on) return;
		return reload();
	}, [active, on, reload]);

	const onAction = useCallback(
		async (item: AgendaItemView, action: AgendaAction): Promise<AgendaActionResult> => {
			const outcome = await performAgendaAction(changeAgendaItem, item, action);
			if (outcome.result === "ok") setData((current) => (current ? applyAgendaChange(current, outcome.item) : current));
			else if (outcome.result === "gone") reload();
			return outcome.result;
		},
		[reload],
	);

	if (!on) return null;
	return (
		<LibrarySection count={data?.items.length} id="agenda" title={t("agenda.title")}>
			{loadFailed ? <p className="pb-2 text-caption text-muted-foreground">{t("agenda.loadError")}</p> : null}
			{data ? <AgendaList ended={data.ended} items={data.items} now={new Date()} onAction={onAction} timezone={data.timezone} /> : null}
		</LibrarySection>
	);
}
