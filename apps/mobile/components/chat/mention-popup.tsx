import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SparklesIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import type { BotCandidate, SkillCandidate, TriggerState } from "@/lib/mention-input";
import { useAppColorScheme } from "@/lib/use-theme";

const ROW_HEIGHT = 52;
/** Rola a partir de 6 linhas, como a lista do web. */
const MAX_ROWS = 6;
const AVATAR = 28;

/**
 * Lista acima do campo, aberta ao digitar `@` (bots) ou `/` (habilidades): a mesma caixa nos dois casos, na pele do
 * "chrome" do chat (preenchimento e contorno do campo), com o avatar do bot ou o ícone da habilidade. Escolher
 * (`onPick`) vira um marcador no campo.
 */
export function MentionPopup({
	state,
	loading,
	failed,
	limitReached,
	onRetry,
	onPick,
	onPressChange,
}: {
	state: TriggerState;
	loading?: boolean;
	/** As habilidades não carregaram: mostra o erro e "Tentar de novo". */
	failed?: boolean;
	/** Já há 3 habilidades na mensagem: as do `/` ficam desabilitadas, com a explicação no topo. */
	limitReached?: boolean;
	onRetry?: () => void;
	onPick: (state: TriggerState, index: number) => void;
	/** Dedo na lista (o campo perde o foco no web antes do toque terminar: o composer não fecha a lista nesse meio-tempo). */
	onPressChange?: (pressing: boolean) => void;
}) {
	const chrome = chatChrome(useAppColorScheme());
	const empty = state.candidates.length === 0;
	const locked = state.trigger === "/" && limitReached === true;
	return (
		<View
			role="list"
			accessibilityLabel={state.trigger === "@" ? "Bots para mencionar" : "Habilidades"}
			style={{ position: "absolute", left: 0, right: 0, bottom: "100%", marginBottom: 8, borderRadius: 24, borderColor: chrome.edge, backgroundColor: chrome.fill, maxHeight: ROW_HEIGHT * MAX_ROWS + 8 }}
			className="overflow-hidden border p-1"
		>
			{locked ? (
				<Text variant="muted" className="px-3 py-2 text-body">
					Até 3 habilidades por mensagem
				</Text>
			) : null}
			{empty ? (
				failed && state.trigger === "/" ? (
					<View className="min-h-11 flex-row items-center justify-between gap-2 px-3">
						<Text variant="muted" className="min-w-0 shrink text-body">
							Não consegui carregar as habilidades
						</Text>
						<Pressable role="button" accessibilityLabel="Tentar de novo" onPress={onRetry} style={{ backgroundColor: chrome.control }} className="min-h-9 justify-center rounded-full px-3 active:opacity-70">
							<Text className="text-body font-medium">Tentar de novo</Text>
						</Pressable>
					</View>
				) : (
					<View className="min-h-11 flex-row items-center gap-2 px-3">
						{loading ? <Spinner label="Carregando habilidades" /> : null}
						<Text variant="muted" className="text-body">
							{loading ? "Carregando habilidades…" : state.trigger === "@" ? "Nenhum bot" : "Nenhuma habilidade"}
						</Text>
					</View>
				)
			) : (
				<ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
					{state.candidates.map((candidate: BotCandidate | SkillCandidate, index) => (
						<Pressable
							key={candidate.id}
							role="button"
							accessibilityLabel={state.trigger === "@" ? candidate.name : `Habilidade ${candidate.name}`}
							accessibilityState={{ disabled: locked }}
							disabled={locked}
							onPressIn={() => onPressChange?.(true)}
							onPressOut={() => onPressChange?.(false)}
							onPress={() => onPick(state, index)}
							style={{ minHeight: ROW_HEIGHT, opacity: locked ? 0.4 : 1 }}
							className="flex-row items-center gap-3 rounded-2xl px-3 py-1.5 active:bg-foreground/10"
						>
							{state.trigger === "@" ? (
								<Avatar color={resolveColor((candidate as BotCandidate).color, candidate.id)} shape={resolveShape((candidate as BotCandidate).shape, candidate.id)} size={AVATAR} animated={false} eyeColor={chrome.fill} />
							) : (
								<View style={{ width: AVATAR, height: AVATAR, backgroundColor: chrome.control }} className="items-center justify-center rounded-full">
									<SparklesIcon size={14} />
								</View>
							)}
							<View className="min-w-0 flex-1">
								<Text numberOfLines={1} className="text-control font-medium">
									{state.trigger === "/" ? `/${candidate.name}` : candidate.name}
								</Text>
								{"description" in candidate && candidate.description?.trim() ? (
									<Text variant="caption" numberOfLines={1} className="text-body">
										{candidate.description.trim()}
									</Text>
								) : null}
							</View>
						</Pressable>
					))}
				</ScrollView>
			)}
		</View>
	);
}
