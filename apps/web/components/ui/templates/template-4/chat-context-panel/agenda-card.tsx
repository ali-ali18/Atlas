"use client";

import { useState } from "react";
import type { AgendaAction, AgendaItemView } from "@workspace/shared";
import { Badge } from "@workspace/ui/components/badge";
import { Switch } from "@workspace/ui/components/switch";
import { cn } from "@workspace/ui/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { AgendaCardModel } from "./agenda-text";
import { DeletableRow } from "./deletable-row";

/** Resultado de uma ação para o cartão mostrar o aviso certo. */
export type AgendaActionResult = "ok" | "gone" | "error";

const STATE_BADGE = { active: "success", paused: "warning", ended: "secondary" } as const;

/** Um combinado da agenda. Pausar/retomar é o interruptor; cancelar é a lixeira apagável (hover/foco no mouse, pressão longa no toque) com confirmação na própria linha. */
export function AgendaCard({
	item,
	model,
	onAction,
	revealed,
	confirming,
}: {
	item: AgendaItemView;
	model: AgendaCardModel;
	onAction?: (item: AgendaItemView, action: AgendaAction) => Promise<AgendaActionResult>;
	/** Só teste/prévia: já mostra a lixeira. */
	revealed?: boolean;
	confirming?: boolean;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ended = model.state === "ended";

	async function run(action: AgendaAction) {
		if (!onAction) return;
		setBusy(true);
		setError(null);
		const result = await onAction(item, action);
		setBusy(false);
		if (result === "gone") setError(t("agenda.changeGone"));
		else if (result === "error") setError(t("agenda.changeError"));
	}

	return (
		<DeletableRow
			busy={busy}
			cancelLabel={t("agenda.cancelKeep")}
			canDelete={!ended}
			confirmBody={t("agenda.cancelBody")}
			confirmLabel={t("agenda.cancelConfirm")}
			confirmTitle={t("agenda.cancelTitle")}
			deleteLabel={t("agenda.cancelNamed", { note: model.note })}
			onDelete={() => void run("cancel")}
			confirming={confirming}
			revealed={revealed}
			rowData={{ "data-agenda-card": item.id, "data-agenda-state": model.state }}
			rowId={item.id}
			trailing={
				ended ? null : (
					<Switch
						aria-label={t(model.state === "paused" ? "agenda.resumeNamed" : "agenda.pauseNamed", { note: model.note })}
						checked={model.state === "active"}
						className="data-checked:border-(--bot-accent,var(--primary)) data-checked:bg-(--bot-accent,var(--primary)) *:data-[slot=switch-thumb]:data-checked:bg-white!"
						disabled={busy || !onAction}
						onCheckedChange={() => void run(model.state === "paused" ? "resume" : "pause")}
					/>
				)
			}
		>
			<div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
				<span className={cn("line-clamp-2 break-words font-medium text-body", ended && "text-muted-foreground")}>{model.note}</span>
				<span className="flex flex-wrap items-center gap-1.5">
					<Badge variant="outline">{model.kind}</Badge>
					<Badge variant={STATE_BADGE[model.state]}>{model.stateLabel}</Badge>
				</span>
				{model.summary ? <span className="break-words text-caption text-muted-foreground">{model.summary}</span> : null}
				{model.endText ? <span className="break-words text-caption text-muted-foreground">{model.endText}</span> : null}
				{model.next ? <span className="break-words text-caption text-muted-foreground">{model.next}</span> : null}
				{model.last ? <span className="line-clamp-3 break-words text-caption text-muted-foreground">{model.last}</span> : null}
				{error ? (
					<p aria-live="polite" className="m-0 pt-1 text-caption text-destructive" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</DeletableRow>
	);
}
