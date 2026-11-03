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
export function MentionPopup({ state, loading, onPick }: { state: TriggerState; loading?: boolean; onPick: (state: TriggerState, index: number) => void }) {
	const chrome = chatChrome(useAppColorScheme());
	const empty = state.candidates.length === 0;
	return (
		<View
			role="list"
			accessibilityLabel={state.trigger === "@" ? "Bots para mencionar" : "Habilidades"}
			style={{ position: "absolute", left: 0, right: 0, bottom: "100%", marginBottom: 8, borderRadius: 24, borderColor: chrome.edge, backgroundColor: chrome.fill, maxHeight: ROW_HEIGHT * MAX_ROWS + 8 }}
			className="overflow-hidden border p-1"
		>
			{empty ? (
				<View className="min-h-11 flex-row items-center gap-2 px-3">
					{loading ? <Spinner label="Carregando habilidades" /> : null}
					<Text variant="muted" className="text-body">
						{loading ? "Carregando habilidades…" : state.trigger === "@" ? "Nenhum bot" : "Nenhuma habilidade"}
					</Text>
				</View>
			) : (
				<ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
					{state.candidates.map((candidate: BotCandidate | SkillCandidate, index) => (
						<Pressable
							key={candidate.id}
							role="button"
							accessibilityLabel={state.trigger === "@" ? candidate.name : `Habilidade ${candidate.name}`}
							onPress={() => onPick(state, index)}
							style={{ minHeight: ROW_HEIGHT }}
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
