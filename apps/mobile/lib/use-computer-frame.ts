// Liga o laço da miniatura (`computer-thumb.ts`) ao ciclo de vida do cartão: roda só com `enabled` (cartão pendente, tela
// em foco, app ativo) e para ao desmontar, ao resolver ou ao sair da tela. A captura vive só neste estado.
import * as React from "react";
import type { ApiFetch } from "./home-sync";
import { conversationFrameFetcher, createFramePoller } from "./computer-thumb";

export function useComputerFrame({ apiFetch, conversationId, enabled }: { apiFetch: ApiFetch; conversationId: string | null; enabled: boolean }): string | null {
	const [frame, setFrame] = React.useState<string | null>(null);
	const api = React.useRef(apiFetch);
	api.current = apiFetch;

	React.useEffect(() => {
		if (!enabled || !conversationId) return;
		const poller = createFramePoller({
			fetchFrame: conversationFrameFetcher((path, init) => api.current(path, init), conversationId),
			onFrame: setFrame,
		});
		poller.start();
		return () => poller.stop();
	}, [enabled, conversationId]);

	return frame;
}
