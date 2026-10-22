"use client";

import { ClockIcon, GitBranchIcon, MailIcon, SparklesIcon, WebhookIcon } from "lucide-react";
import { formatSourceMarker, type MessageSource } from "@workspace/shared";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";

/** Origem da mensagem: "Rotina · Resumo da agenda · 20:00", "Lembrete · …", "GitHub · …". */
export function SourceMarker({ source, timeZone }: { source: MessageSource; timeZone?: string }) {
	const Icon = source.kind === "github" ? GitBranchIcon : source.kind === "webhook" ? WebhookIcon : source.kind === "reflection" ? SparklesIcon : source.kind === "email" ? MailIcon : ClockIcon;
	return (
		<Marker className="my-2 justify-center text-xs" data-source-kind={source.kind} data-testid="source-marker">
			<MarkerIcon>
				<Icon />
			</MarkerIcon>
			<MarkerContent className="min-w-0 truncate">{formatSourceMarker(source, timeZone)}</MarkerContent>
		</Marker>
	);
}
