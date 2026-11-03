import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { View } from "react-native";
import { SparklesIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import { routineSurface } from "@/lib/chat-surface";
import type { MentionBotRef, MessagePart } from "@/lib/message-text";
import { useAppColorScheme } from "@/lib/use-theme";

const AVATAR = 16;

/** Avatar pequeno do bot, para entrar dentro de um `Text` (o RN aceita `View` inline no meio do texto). */
export function InlineAvatar({ bot, eyeColor }: { bot: MentionBotRef; eyeColor?: string }) {
	return (
		<View style={{ width: AVATAR + 5, height: AVATAR, marginBottom: -3 }} className="justify-center">
			<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={AVATAR} animated={false} eyeColor={eyeColor} />
		</View>
	);
}

/** Ícone da habilidade inline (o SVG não entra solto num `Text`; o `View` entra). */
function InlineSparkles() {
	return (
		<View style={{ width: 19, height: 16, marginBottom: -2 }} className="justify-center">
			<SparklesIcon size={14} />
		</View>
	);
}

/**
 * Trechos da fala do usuário num `Text` só: o texto como veio e, no lugar de cada `@bot` / `/habilidade`, o mesmo visual
 * do marcador do composer (`MarkerChip`): avatar pequeno (ou ícone da habilidade) e o nome em azul, sem `@`, sem fundo,
 * na mesma linha. Os trechos são `Text` aninhados: herdam fonte e cor do balão.
 */
export function MentionText({ parts, eyeColor }: { parts: readonly MessagePart[]; eyeColor?: string }) {
	const blue = routineSurface(useAppColorScheme()).link;
	return (
		<>
			{parts.map((part, index) => {
				if (part.type === "text") return <React.Fragment key={index}>{part.text}</React.Fragment>;
				return (
					<Text key={index} className="text-base font-medium leading-snug" style={{ color: blue }}>
						{part.type === "bot" ? <InlineAvatar bot={part.bot} eyeColor={eyeColor} /> : <InlineSparkles />}
						{part.text}
					</Text>
				);
			})}
		</>
	);
}
