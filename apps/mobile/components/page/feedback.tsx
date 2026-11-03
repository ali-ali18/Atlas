import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { calloutTone } from "@/lib/page-tone";
import { type Of, usePageTheme } from "./page-theme";

export function BadgeNode({ node }: { node: Of<"badge"> }) {
	const { text, tone } = node.props;
	const { tone: toneOf } = usePageTheme();
	const colors = toneOf(tone);
	return (
		<View className="max-w-full flex-row self-start">
			<View className="max-w-full rounded-full px-2.5 py-0.5" style={{ backgroundColor: colors.soft, borderWidth: 1, borderColor: colors.edge }}>
				<Text className="text-caption font-medium" numberOfLines={1} style={{ color: colors.text }}>
					{text}
				</Text>
			</View>
		</View>
	);
}

/** Aviso: faixa colorida à esquerda, fundo suave do tom, título e texto (o texto vem do spec: nunca interpretado). */
export function CalloutNode({ node }: { node: Of<"callout"> }) {
	const { title, text, tone } = node.props;
	const { tone: toneOf } = usePageTheme();
	const colors = toneOf(calloutTone(tone));
	return (
		<View accessibilityRole="alert" className="min-w-0 gap-0.5 rounded-card px-3.5 py-3" style={{ backgroundColor: colors.soft, borderWidth: 1, borderColor: colors.edge, borderLeftWidth: 3, borderLeftColor: colors.fill }}>
			{title ? (
				<Text className="font-semibold" numberOfLines={3} style={{ color: colors.text }}>
					{title}
				</Text>
			) : null}
			<Text className="text-control">{text}</Text>
		</View>
	);
}
