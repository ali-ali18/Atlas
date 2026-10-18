"use client";

import { BrainIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";

/** Linha discreta depois que o bot grava na memória durante a conversa: "Memória atualizada · ver". */
export function MemoryUpdatedMarker({ onOpen }: { onOpen?: () => void }) {
	return (
		<Marker className="my-1 justify-center text-xs" data-testid="memory-updated-marker">
			<MarkerIcon>
				<BrainIcon />
			</MarkerIcon>
			<MarkerContent className="inline-flex items-center gap-1">
				<span>Memória atualizada</span>
				{onOpen ? (
					<>
						<span aria-hidden="true">·</span>
						<button
							aria-label="Ver a memória atualizada"
							className="cursor-pointer rounded-sm py-1 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={onOpen}
							type="button"
						>
							ver
						</button>
					</>
				) : null}
			</MarkerContent>
		</Marker>
	);
}
