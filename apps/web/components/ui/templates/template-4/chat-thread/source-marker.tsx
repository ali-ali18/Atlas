"use client";

import { ClockIcon, GitBranchIcon, MailIcon, SparklesIcon, WebhookIcon } from "lucide-react";
import { formatSourceMarker, type MessageSource } from "@workspace/shared";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";

/** Origem da mensagem: "Rotina · Resumo da agenda · 20:00", "Lembrete · …", "GitHub · …". */
export function SourceMarker({ source, timeZone, onOpenMemory }: { source: MessageSource; timeZone?: string; /** Reflexão diária: "ver" leva ao "O que mudou" da aba Memória. */ onOpenMemory?: () => void }) {
	const Icon = source.kind === "github" ? GitBranchIcon : source.kind === "webhook" ? WebhookIcon : source.kind === "reflection" ? SparklesIcon : source.kind === "email" ? MailIcon : ClockIcon;
	return (
		<Marker className="my-2 justify-center text-xs" data-source-kind={source.kind} data-testid="source-marker">
			<MarkerIcon>
				<Icon />
			</MarkerIcon>
			<MarkerContent className="min-w-0 truncate">{formatSourceMarker(source, timeZone)}</MarkerContent>
			{onOpenMemory ? (
				<button
					aria-label="Ver o que mudou na memória"
					className="shrink-0 cursor-pointer rounded-sm py-1 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={onOpenMemory}
					type="button"
				>
					ver
				</button>
			) : null}
		</Marker>
	);
}
