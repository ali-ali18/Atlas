"use client";

import { BrainIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";
import { useT } from "@/lib/i18n/provider";

/** Linha discreta depois que o bot grava na memória durante a conversa: só o aviso, sem ação (autonomia do bot). */
export function MemoryUpdatedMarker() {
	const t = useT();
	return (
		<Marker className="my-1 justify-center text-xs" data-testid="memory-updated-marker">
			<MarkerIcon>
				<BrainIcon />
			</MarkerIcon>
			<MarkerContent>{t("chat.memoryUpdated")}</MarkerContent>
		</Marker>
	);
}
