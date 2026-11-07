"use client";

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
 * Seção "Caderno" da Biblioteca. Só existe quando o Motor v4 está ligado para a conta (sinal do servidor em
 * `capabilities.engineV4`); desligado ou ainda sem resposta, não desenha nada, então ninguém vê tela de algo que o bot
 * não faz.
 */
export function NotebookSection({ botId, enabled }: { botId: string; /** Sinal já conhecido (teste/prévia); sem ele, lê do servidor. */ enabled?: boolean }) {
	const t = useT();
	const fromServer = useEngineV4();
	if (!(enabled ?? fromServer)) return null;
	return (
		<LibrarySection id="notebook" title={t("notebook.title")}>
			<NotebookBody botId={botId} />
		</LibrarySection>
	);
}
