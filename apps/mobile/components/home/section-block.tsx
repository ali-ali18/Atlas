import type { HomeBot } from "@/lib/home-types";
import * as React from "react";
import { Pressable, View } from "react-native";
import { ChevronDownIcon, SendIcon } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { formatListDate, NO_SECTION_KEY, type HomeSection } from "@/lib/home-list";
import { chatChrome } from "@/lib/chat-surface";
import { useAppColorScheme } from "@/lib/use-theme";
import { BotAvatar } from "./bot-avatar";

const ROW_BODY = 48;

/** Linha de uma conversa: avatar, título em negrito, data à direita e a prévia da última mensagem. */
export function ConversationRow({ bot, bots, now, onOpen, onMenu }: { bot: HomeBot; bots: readonly HomeBot[]; now: Date; onOpen: (bot: HomeBot) => void; onMenu: (bot: HomeBot) => void }) {
	const date = formatListDate(bot.lastAt, now);
	const unread = bot.unread;
	return (
		<Pressable role="button" accessibilityLabel={`${bot.name}. ${bot.preview}`} onPress={() => onOpen(bot)} onLongPress={() => onMenu(bot)} accessibilityHint="Segure para ver as ações da conversa" className="min-h-[72px] flex-row items-center gap-3 px-5 py-2 active:bg-muted/60">
			<BotAvatar bot={bot} bots={bots} body={ROW_BODY} />
			<View className="min-w-0 flex-1 gap-0.5">
				<View className="flex-row items-center gap-2">
					<Text numberOfLines={1} ellipsizeMode="tail" className="min-w-0 flex-1 text-control font-bold">
						{bot.name}
					</Text>
					{date ? <Text className="text-body text-muted-foreground">{date}</Text> : null}
				</View>
				<View className="flex-row items-center gap-1.5">
					{bot.previewSent ? <SendIcon size={16} /> : null}
					<Text numberOfLines={1} ellipsizeMode="tail" className={`min-w-0 flex-1 text-control ${unread ? "text-foreground" : "text-muted-foreground"}`}>
						{bot.preview || "Sem mensagens ainda"}
					</Text>
					{unread ? <View accessibilityLabel="Não lida" className="size-2.5 rounded-full bg-info" /> : null}
				</View>
			</View>
		</Pressable>
	);
}

/** Seção recolhível ("Codding ⌄") com as conversas dentro. Recolhida por toque no título; segurar abre o menu de edição. */
export function SectionBlock({
	section,
	bots,
	now,
	open,
	onToggle,
	onOpen,
	onMenu,
	onSectionMenu,
	showEmpty,
	renaming,
	onCommitRename,
	onCancelRename,
}: {
	section: HomeSection;
	bots: readonly HomeBot[];
	now: Date;
	open: boolean;
	onToggle: () => void;
	onOpen: (bot: HomeBot) => void;
	onMenu: (bot: HomeBot) => void;
	/** Só para seções reais (não "Sem sessão"). */
	onSectionMenu?: (section: HomeSection) => void;
	showEmpty: boolean;
	renaming?: boolean;
	onCommitRename?: (name: string) => void;
	onCancelRename?: () => void;
}) {
	const editable = section.key !== NO_SECTION_KEY && Boolean(onSectionMenu);
	const draftName = React.useRef(section.title);
	// Enviar pelo teclado tira o foco e dispara o onBlur logo depois: só o primeiro dos dois salva.
	const settled = React.useRef(false);
	React.useEffect(() => {
		if (!renaming) return;
		draftName.current = section.title;
		settled.current = false;
	}, [renaming, section.title]);
	const settle = (action: () => void) => {
		if (settled.current) return;
		settled.current = true;
		action();
	};
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	return (
		<View>
			{renaming ? (
				<View className="min-h-11 justify-center px-5 py-1">
					<Input
						autoFocus
						defaultValue={section.title}
						returnKeyType="done"
						onChangeText={(text) => {
							draftName.current = text;
						}}
						onSubmitEditing={() => settle(() => onCommitRename?.(draftName.current))}
						onBlur={() =>
							settle(() => {
								if (draftName.current.trim() === section.title.trim()) onCancelRename?.();
								else onCommitRename?.(draftName.current);
							})
						}
						style={{ backgroundColor: chrome.fill, borderColor: chrome.edge }}
						className="h-11 rounded-full border px-4"
						accessibilityLabel="Nome da seção"
					/>
				</View>
			) : (
				<Pressable
					role="button"
					accessibilityState={{ expanded: open }}
					accessibilityLabel={section.title}
					accessibilityHint={editable ? "Toque para recolher ou expandir. Segure para editar a seção." : undefined}
					onPress={onToggle}
					onLongPress={editable ? () => onSectionMenu?.(section) : undefined}
					delayLongPress={400}
					className="min-h-11 flex-row items-center gap-1.5 self-start px-5 active:opacity-70"
				>
					<Text numberOfLines={1} className="shrink text-control text-muted-foreground">
						{section.title}
					</Text>
					<View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
						<ChevronDownIcon size={20} />
					</View>
				</Pressable>
			)}
			{open
				? section.bots.length > 0
					? section.bots.map((bot) => <ConversationRow key={bot.id} bot={bot} bots={bots} now={now} onOpen={onOpen} onMenu={onMenu} />)
					: showEmpty
						? <Text className="px-5 pb-3 text-body text-muted-foreground">Nenhuma conversa aqui ainda.</Text>
						: null
				: null}
		</View>
	);
}
