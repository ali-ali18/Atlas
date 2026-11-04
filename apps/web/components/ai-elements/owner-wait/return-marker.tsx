"use client";

import { AlarmClockIcon, CheckIcon, XIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";
import { cn } from "@workspace/ui/lib/utils";
import { useTranslations } from "@/lib/i18n/provider";
import { returnMarkerText, returnMarkerTime } from "@/lib/owner-wait";

export type ReturnMarkerProps = {
	at: string;
	status: "pending" | "cancelled" | "done";
	/** Cancelar o retorno (só pendente). Sem handler, o marcador fica só de leitura. */
	onCancel?: () => void;
	cancelling?: boolean;
	error?: string | null;
	now?: Date;
	timeZone?: string;
};

/**
 * "Volto às 14:30": linha única na conversa quando o bot promete voltar (retorno visível). Pendente tem "Cancelar";
 * cancelado ou concluído só diz o estado. O retorno silencioso nunca chega aqui.
 */
export function ReturnMarker({ at, status, onCancel, cancelling, error, now, timeZone }: ReturnMarkerProps) {
	const translator = useTranslations();
	const { t } = translator;
	const options = timeZone ? { timeZone } : {};
	const label = returnMarkerText(at, now ?? new Date(), translator, options);
	const Icon = status === "done" ? CheckIcon : status === "cancelled" ? XIcon : AlarmClockIcon;
	return (
		<div className="flex min-w-0 flex-col items-center gap-1 py-1" data-return-marker={status}>
			<Marker className="w-auto justify-center text-xs">
				<MarkerIcon>
					<Icon />
				</MarkerIcon>
				<MarkerContent className={cn(status === "cancelled" && "line-through decoration-muted-foreground/60")}>{label}</MarkerContent>
				{status === "cancelled" ? <span className="text-xs">· {t("ownerWait.return.cancelled")}</span> : null}
				{status === "done" ? <span className="text-xs">· {t("ownerWait.return.done")}</span> : null}
				{status === "pending" && onCancel ? (
					<Button
						aria-label={t("ownerWait.return.cancelLabel", { time: returnMarkerTime(at, translator, options) })}
						className="ml-1"
						disabled={cancelling}
						onClick={onCancel}
						size="sm"
						type="button"
						variant="ghost"
					>
						{t("ownerWait.return.cancel")}
					</Button>
				) : null}
			</Marker>
			{error ? (
				<p className="m-0 text-caption text-destructive" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
