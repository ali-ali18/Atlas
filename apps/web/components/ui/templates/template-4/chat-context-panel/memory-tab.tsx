"use client";

import { useEffect, useRef } from "react";
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useBotMemory } from "@/hooks/use-bot-memory";
import { MemoryChanges } from "./memory-changes";
import { MemorySection } from "./memory-section";

export const MEMORY_USER_EMPTY = "Nada guardado sobre você ainda. O que o bot aprender sobre você aparece aqui.";
export const MEMORY_BOT_EMPTY = "Este bot ainda não guardou nada por conta própria.";

/**
 * Aba Memória: o que o bot lembra (perfil compartilhado e memória só deste bot), com editar/apagar/adicionar,
 * e o histórico "O que mudou" com desfazer. `focusChanges` (nonce) leva a vista até o histórico.
 */
export function MemoryTab({
	botId,
	active,
	focusChanges,
	onFixInChat,
}: {
	botId: string;
	active: boolean;
	/** Muda a cada pedido de "ver o que mudou" (cartão da reflexão); leva a rolagem até o histórico. */
	focusChanges?: number;
	onFixInChat?: (draft: string) => void;
}) {
	const memory = useBotMemory(botId, active);
	const changesRef = useRef<HTMLElement>(null);
	const now = new Date();

	const ready = memory.snapshot !== null;
	useEffect(() => {
		if (!active || !focusChanges || !ready) return;
		changesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
	}, [active, focusChanges, ready]);

	if (memory.loading && !memory.snapshot) {
		return (
			<div aria-busy="true" aria-label="Carregando a memória" className="flex flex-col gap-3" role="status">
				<Skeleton className="h-5 w-28" />
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-5 w-28" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}

	if (memory.error && !memory.snapshot) {
		return (
			<div className="flex flex-col items-center gap-3 py-8 text-center" role="alert">
				<p className="text-muted-foreground text-xs leading-relaxed">{memory.error}</p>
				<Button onClick={() => void memory.refresh()} size="sm" variant="outline">
					Tentar de novo
				</Button>
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-col gap-6" data-memory-tab>
			{memory.error ? (
				<p className="text-destructive text-xs leading-relaxed" role="alert">
					{memory.error}
				</p>
			) : null}
			<MemorySection
				emptyText={MEMORY_USER_EMPTY}
				entries={memory.snapshot?.user.entries ?? []}
				id="memory-user"
				note="Todos os seus bots veem isto"
				now={now}
				onAdd={(content) => memory.add("user", content)}
				onEdit={memory.edit}
				onFixInChat={onFixInChat}
				onRemove={memory.remove}
				title="Sobre você"
			/>
			<MemorySection
				emptyText={MEMORY_BOT_EMPTY}
				entries={memory.snapshot?.memory.entries ?? []}
				id="memory-bot"
				now={now}
				onAdd={(content) => memory.add("memory", content)}
				onEdit={memory.edit}
				onFixInChat={onFixInChat}
				onRemove={memory.remove}
				title="Deste bot"
			/>
			<MemoryChanges
				changes={memory.changes}
				hasMore={memory.nextCursor !== null}
				loadingMore={memory.loadingMore}
				now={now}
				onLoadMore={() => void memory.loadMore()}
				onUndo={(id) => void memory.undo(id)}
				ref={changesRef}
				undoErrors={memory.undoErrors}
				undoing={memory.undoing}
			/>
		</div>
	);
}
