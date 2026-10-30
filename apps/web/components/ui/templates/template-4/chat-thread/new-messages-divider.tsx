"use client";

import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import { useT } from "@/lib/i18n/provider";

/** Linha fina com o rótulo "Novas mensagens" acima da primeira mensagem não lida. */
export function NewMessagesDivider() {
	const t = useT();
	return (
		<Marker className="my-2 text-xs" data-testid="new-messages-divider" role="separator" variant="separator">
			<MarkerContent>{t("chat.newMessages")}</MarkerContent>
		</Marker>
	);
}
