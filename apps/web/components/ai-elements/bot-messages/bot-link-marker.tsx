"use client";

import { Marker, MarkerContent } from "@workspace/ui/components/marker";

import { BotChip, type BotRef } from "./bot-chip";

/**
 * Marcador fino e centralizado (mesmo estilo do separador de horário):
 * "Enviou mensagem para [avatar] X" ou "Mensagem de [avatar] X". A linha toda é
 * um botão que abre a conversa entre os dois bots (somente leitura).
 */
export function BotLinkMarker({
	direction,
	bot,
	onOpen,
}: {
	direction: "sent" | "received";
	bot: BotRef;
	/** Abre a conversa com o bot; sem ele (bot apagado) o marcador é só informativo. */
	onOpen?: () => void;
}) {
	const content = (
		<Marker className="justify-center text-xs">
			<MarkerContent className="inline-flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5">
				<span>{direction === "sent" ? "Enviou mensagem para" : "Mensagem de"}</span>
				<BotChip bot={bot} />
			</MarkerContent>
		</Marker>
	);
	return (
		<div className="my-2" data-testid="bot-link-marker">
			{onOpen ? (
				<button
					aria-label={`Ver conversa com ${bot.name}`}
					className="block w-full cursor-pointer rounded-full py-0.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={onOpen}
					type="button"
				>
					{content}
				</button>
			) : (
				content
			)}
		</div>
	);
}
