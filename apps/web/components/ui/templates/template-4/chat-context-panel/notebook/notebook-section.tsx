"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/provider";
import { useEngineV4 } from "@/lib/use-engine-v4";
import { LibrarySection } from "../library-section";
import type { NotebookApi } from "./notebook-actions";
import { NightReviewBlock } from "./night-review-block";
import { NotesBlock } from "./notes-block";
import { RulesBlock } from "./rules-block";

/** O miolo do Caderno: três sub-blocos recolhíveis (notas abertas; regras e revisão da noite fechadas). */
export function NotebookBody({ botId, api, defaultOpen }: { botId: string; api?: NotebookApi; defaultOpen?: { rules?: boolean; review?: boolean } }) {
	return (
		<div className="flex flex-col gap-1" data-notebook-body>
			<NotesBlock api={api} botId={botId} />
			<RulesBlock api={api} botId={botId} defaultOpen={defaultOpen?.rules} />
			<NightReviewBlock api={api} botId={botId} defaultOpen={defaultOpen?.review} />
		</div>
	);
}

/**
 * Seção "Caderno" da Biblioteca. Só existe quando o Motor v4 está ligado para a conta (`useEngineV4`, o mesmo sinal da
 * Agenda); desligado ou ainda sem resposta, não desenha nada. O conteúdo só é montado (e só busca) quando a Biblioteca
 * está visível (`active`) e, depois de aberto, fica montado para não perder o que a pessoa estava editando.
 * `enabled` e `active` explícitos existem para teste e prévia.
 */
export function NotebookSection({ botId, enabled, active = true }: { botId: string; enabled?: boolean; active?: boolean }) {
	const t = useT();
	const fromServer = useEngineV4();
	const [activated, setActivated] = useState(active);
	useEffect(() => {
		if (active) setActivated(true);
	}, [active]);
	if (!(enabled ?? fromServer)) return null;
	return (
		<LibrarySection id="notebook" title={t("notebook.title")}>
			{activated ? <NotebookBody botId={botId} /> : null}
		</LibrarySection>
	);
}
