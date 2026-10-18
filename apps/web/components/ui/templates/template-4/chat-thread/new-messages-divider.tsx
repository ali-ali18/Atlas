"use client";

import { Marker, MarkerContent } from "@workspace/ui/components/marker";

/** Linha fina com o rótulo "Novas mensagens" acima da primeira mensagem não lida. */
export function NewMessagesDivider() {
	return (
		<Marker className="my-2 text-xs" data-testid="new-messages-divider" role="separator" variant="separator">
			<MarkerContent>Novas mensagens</MarkerContent>
		</Marker>
	);
}
