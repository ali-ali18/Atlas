import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react-native";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { calloutView, type CalloutIcon } from "@/lib/page-views";
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

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, critical: OctagonAlert } as const satisfies Record<CalloutIcon, unknown>;

/**
 * Aviso do web (`Alert`): cantos de 14, fundo do tom a 12% (no âmbar vira o marrom escuro do print) e borda a 40%, ícone
 * do tipo na cor do tom, título em negrito e o texto do spec (nunca interpretado) em 85% do texto.
 */
export function CalloutNode({ node }: { node: Of<"callout"> }) {
	const view = calloutView(node.props);
	const { tone: toneOf, surface } = usePageTheme();
	const colors = toneOf(view.tone);
	const Icon = ICONS[view.icon];
	return (
		<View accessibilityRole="alert" className="min-w-0 flex-row items-start gap-3 px-4 py-3.5" style={{ borderRadius: 14, backgroundColor: colors.soft, borderWidth: 1, borderColor: colors.edge }}>
			<View style={{ paddingTop: 2 }}>
				<Icon size={18} color={colors.text} strokeWidth={2} />
			</View>
			<View className="min-w-0 flex-1 gap-0.5">
				{view.title ? (
					<Text className="text-control font-semibold" numberOfLines={3}>
						{view.title}
					</Text>
				) : null}
				<Text className="text-control" style={{ color: surface.foreground, opacity: 0.85 }}>
					{view.text}
				</Text>
			</View>
		</View>
	);
}
