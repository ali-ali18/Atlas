import * as Clipboard from "expo-clipboard";
import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type { ChatItem } from "@/lib/chat-types";
import { tap } from "@/lib/haptics";
import { messageMenuFor, type MessageMenu } from "@/lib/message-actions";
import type { ChatHook } from "@/lib/use-chat";
import { MessageActionsSheet } from "./message-actions-sheet";
import { TextSelectModal } from "./text-select-modal";

type Target = { id: string; menu: MessageMenu; item: ChatItem };

const TOAST_MS = 1800;

/** Aviso curto ("Mensagem copiada") acima do composer; some sozinho. */
function Toast({ message, bottom }: { message: string | null; bottom: number }) {
	if (!message) return null;
	return (
		<View pointerEvents="none" className="absolute inset-x-0 items-center" style={{ bottom }}>
			<View role="status" className="rounded-full bg-popover px-4 py-2.5">
				<Text className="text-control">{message}</Text>
			</View>
		</View>
	);
}

/**
 * Tudo do menu ao segurar a mensagem: qual mensagem está aberta, as ações (reagir, não lida, copiar, selecionar) e
 * o aviso depois de copiar. A tela só chama `open` no toque longo e desenha `node` (gaveta, seleção e aviso).
 */
export function useMessageMenu({ chat, goBack, composerHeight, onReply }: { chat: Pick<ChatHook, "react" | "markUnread">; goBack: () => void; composerHeight: number; onReply?: (item: ChatItem) => void }) {
	const [target, setTarget] = React.useState<Target | null>(null);
	const [selecting, setSelecting] = React.useState<string | null>(null);
	const [toast, setToast] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), TOAST_MS);
		return () => clearTimeout(timer);
	}, [toast]);

	const open = React.useCallback((item: ChatItem) => {
		const menu = messageMenuFor(item);
		if (!menu) return;
		tap();
		setTarget({ id: item.id, menu, item });
	}, []);
	const close = React.useCallback(() => setTarget(null), []);

	const copy = React.useCallback(async (text: string, done: string) => {
		setTarget(null);
		try {
			await Clipboard.setStringAsync(text);
			setToast(done);
		} catch {
			setToast("Não consegui copiar agora.");
		}
	}, []);

	const node = (
		<>
			<MessageActionsSheet
				menu={target?.menu ?? null}
				onClose={close}
				handlers={{
					onReact: (emoji) => {
						if (target) chat.react(target.id, emoji);
						close();
					},
					...(onReply ? { onReply: () => { if (target) onReply(target.item); close(); } } : {}),
					onMarkUnread: () => {
						close();
						void chat.markUnread().then((ok) => ok && goBack());
					},
					onCopy: () => target && void copy(target.menu.text, "Mensagem copiada"),
					onSelect: () => {
						if (target) setSelecting(target.menu.text);
						close();
					},
					onCopyRunId: () => target?.menu.runId && void copy(target.menu.runId, "ID da solicitação copiado"),
				}}
			/>
			<TextSelectModal text={selecting} onClose={() => setSelecting(null)} />
			<Toast message={toast} bottom={composerHeight + 12} />
		</>
	);
	return { open, node };
}
