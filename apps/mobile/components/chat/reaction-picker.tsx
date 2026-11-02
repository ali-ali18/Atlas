import * as React from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { REACTION_ROWS } from "@/lib/message-actions";

/**
 * Reações do menu da mensagem, em duas fileiras de 6 colunas (a segunda tem 5 e fecha com um vão, para os botões
 * ficarem alinhados). A reação atual do usuário fica destacada; tocar nela de novo a remove (quem decide é o controlador).
 */
export function ReactionPicker({ current, onPick }: { current: string | null; onPick: (emoji: string) => void }) {
	return (
		<View className="gap-2">
			{REACTION_ROWS.map((row, index) => (
				<View key={index} className="flex-row">
					{row.map((emoji) => {
						const selected = emoji === current;
						return (
							<View key={emoji} className="flex-1 items-center">
								<Pressable
									role="button"
									accessibilityLabel={selected ? `Tirar reação ${emoji}` : `Reagir com ${emoji}`}
									accessibilityState={{ selected }}
									onPress={() => onPick(emoji)}
									className={selected ? "size-12 items-center justify-center rounded-full border-2 border-primary bg-primary/15 active:opacity-70" : "size-12 items-center justify-center rounded-full border-2 border-transparent bg-muted active:opacity-70"}
								>
									<Text className="text-2xl">{emoji}</Text>
								</Pressable>
							</View>
						);
					})}
					{row.length < 6 ? <View className="flex-1" /> : null}
				</View>
			))}
		</View>
	);
}
