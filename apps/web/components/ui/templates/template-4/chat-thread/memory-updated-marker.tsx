"use client";

import { BrainIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";

/** Linha discreta depois que o bot grava na memória durante a conversa: só o aviso, sem ação (autonomia do bot). */
export function MemoryUpdatedMarker() {
	return (
		<Marker className="my-1 justify-center text-xs" data-testid="memory-updated-marker">
			<MarkerIcon>
				<BrainIcon />
			</MarkerIcon>
			<MarkerContent>Memória atualizada</MarkerContent>
		</Marker>
	);
}
