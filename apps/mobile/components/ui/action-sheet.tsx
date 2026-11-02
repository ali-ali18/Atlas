import * as React from "react";
import { Pressable, View } from "react-native";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";
import { canGoBack, currentPage, goBack, openSubmenu, submenuPage, type SheetPage, type SheetStack } from "@/lib/action-sheet-nav";

/** Uma linha da gaveta. Com `submenu` ela abre uma subpágina (seta à direita) em vez de executar `onPress`. */
export type SheetAction = {
	key: string;
	label: string;
	icon?: React.ReactNode;
	onPress?: () => void;
	/** `destructive`: texto em vermelho (Ocultar, Apagar). */
	tone?: "default" | "destructive";
	submenu?: SheetPage<SheetAction>;
};

export type SheetGroup = SheetAction[];

/** Cartão arredondado com linhas (ícone à esquerda) e um divisor fino de ponta a ponta entre elas. */
function ActionCard({ actions, onOpen }: { actions: SheetGroup; onOpen: (action: SheetAction) => void }) {
	return (
		<View className="overflow-hidden rounded-card bg-muted">
			{actions.map((action, index) => (
				<React.Fragment key={action.key}>
					{index > 0 ? <View className="h-px bg-border" /> : null}
					<Pressable
						role="button"
						accessibilityLabel={action.label}
						onPress={() => (action.submenu ? onOpen(action) : action.onPress?.())}
						className="min-h-14 flex-row items-center gap-4 px-5 active:bg-foreground/10"
					>
						{action.icon}
						<Text numberOfLines={1} className={`flex-1 text-control ${action.tone === "destructive" ? "text-destructive" : ""}`}>
							{action.label}
						</Text>
						{action.submenu ? <ChevronRightIcon /> : null}
					</Pressable>
				</React.Fragment>
			))}
		</View>
	);
}

/**
 * Gaveta de ações que sobe de baixo: o padrão do app para qualquer menu de segurar (mensagem, conversa, bot).
 * Alça cinza, um `header` opcional (as reações, no caso da mensagem) e grupos de ações em cartões. Ação com `submenu`
 * troca a página da própria gaveta, com um "voltar" no topo. Não fecha sozinha ao tocar numa ação: quem chama decide.
 * É um `DraggableSheet`: abre na altura do conteúdo e o dono pode puxar até o topo; toque no fundo fecha.
 */
export function ActionSheet({ visible, onClose, groups, header }: { visible: boolean; onClose: () => void; groups: SheetGroup[]; header?: React.ReactNode }) {
	const [stack, setStack] = React.useState<SheetStack<SheetAction>>([]);
	// Fechou: a próxima abertura volta à raiz.
	React.useEffect(() => {
		if (!visible) setStack([]);
	}, [visible]);
	const page = currentPage<SheetAction>({ groups }, stack);
	const nested = canGoBack(stack);
	return (
		<DraggableSheet
			visible={visible}
			onClose={onClose}
			onRequestClose={nested ? () => setStack(goBack) : onClose}
			header={
				nested ? (
					<Pressable role="button" accessibilityLabel="Voltar" onPress={() => setStack(goBack)} className="min-h-11 flex-row items-center gap-2 self-start pr-4 active:opacity-70">
						<ChevronLeftIcon size={20} />
						<Text className="text-control font-semibold">{page.title}</Text>
					</Pressable>
				) : null
			}
		>
			{nested ? null : header}
			{page.groups.map((group, index) => (
				<ActionCard key={index} actions={group} onOpen={(action) => action.submenu && setStack((current) => openSubmenu(current, submenuPage(action.label, action.submenu as SheetPage<SheetAction>)))} />
			))}
		</DraggableSheet>
	);
}
