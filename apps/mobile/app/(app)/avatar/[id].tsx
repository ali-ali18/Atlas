import { identityFor } from "@workspace/shared/avatar/identity";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { DoneButton } from "@/components/bot/done-button";
import { SoonSheet } from "@/components/home/soon-sheet";
import { ChevronLeftIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import { getDraft, updateDraft } from "@/lib/bot-draft";
import { AVATAR_PALETTE, AVATAR_SHAPES, defaultAvatar, usesPalette } from "@/lib/bot-edit";
import { cn } from "@/lib/cn";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

const TABS = [
	{ key: "shape", label: "Forma" },
	{ key: "generate", label: "Gerar" },
	{ key: "upload", label: "Enviar" },
] as const;

/**
 * Editor de Avatar: abas Forma / Gerar / Enviar (as duas últimas em breve), prévia grande, a grade das formas do motor
 * (a mesma lista e ordem do seletor do web), a paleta do web (some em forma com cor própria) e "Restaurar o padrão".
 * "Concluído" aplica no rascunho do Editar Bot e volta; o que vai ao servidor é decidido lá.
 */
export default function AvatarEditorScreen() {
	const router = useRouter();
	const scheme = useAppColorScheme();
	const { id } = useLocalSearchParams<{ id: string }>();
	const start = getDraft(id);
	const [shape, setShape] = React.useState(start?.shape ?? identityFor(id).shape);
	const [color, setColor] = React.useState(start?.color ?? identityFor(id).color);
	const [soon, setSoon] = React.useState<string | null>(null);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const changed = shape !== start?.shape || color.toLowerCase() !== start?.color.toLowerCase();
	const palette = usesPalette(shape);
	const apply = () => {
		updateDraft(id, { shape, color });
		goBack();
	};
	const restore = () => {
		const fallback = defaultAvatar(id);
		setShape(fallback.shape);
		setColor(fallback.color);
	};
	return (
		<SafeAreaView className="flex-1 bg-background">
			<View className="flex-row items-center justify-between px-4 pt-1.5">
				<RoundButton label="Voltar" onPress={goBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<Text className="text-lg font-semibold">Avatar</Text>
				<DoneButton enabled={changed} onPress={apply} />
			</View>
			<ScrollView contentContainerClassName="items-center px-4 pb-12 pt-4">
				<View accessibilityRole="tablist" className="flex-row items-center gap-1">
					{TABS.map((tab) => (
						<Pressable key={tab.key} role="tab" accessibilityState={{ selected: tab.key === "shape" }} onPress={() => (tab.key === "shape" ? undefined : setSoon(tab.label === "Gerar" ? "Gerar avatar" : "Enviar avatar"))} className={cn("min-h-11 justify-center rounded-full px-5", tab.key === "shape" ? "bg-secondary" : "")}>
							<Text className={cn("text-lg", tab.key === "shape" ? "font-medium" : "text-muted-foreground")}>{tab.label}</Text>
						</Pressable>
					))}
				</View>
				<View className="h-48 w-full items-center justify-center">
					<Avatar color={color} shape={shape} size={170} animated={false} />
				</View>
				<View className="w-full overflow-hidden rounded-panel bg-card">
					<View className="flex-row flex-wrap justify-center gap-x-1 gap-y-2 px-2 pb-4 pt-5">
						{AVATAR_SHAPES.map((item) => (
							<Pressable key={item} role="radio" accessibilityLabel={`Forma ${item}`} accessibilityState={{ checked: item === shape }} onPress={() => setShape(item)} className={cn("size-16 items-center justify-center rounded-full border-2", item === shape ? "border-foreground/50" : "border-transparent")}>
								<Avatar color={color} shape={item} size={56} animated={false} />
							</Pressable>
						))}
					</View>
					{palette ? (
						<View className="flex-row flex-wrap justify-center gap-x-3 gap-y-3 px-4 pb-5 pt-1">
							{AVATAR_PALETTE.map((item) => {
								const selected = item.value.toLowerCase() === color.toLowerCase();
								return (
									<Pressable key={item.id} role="radio" accessibilityLabel={`Cor ${item.name}`} accessibilityState={{ checked: selected }} onPress={() => setColor(item.value)} className={cn("size-10 items-center justify-center rounded-full border-2", selected ? "border-foreground/50" : "border-transparent")}>
										<View style={{ backgroundColor: item.value, borderColor: themeColor(scheme, "border") }} className="size-8 rounded-full border" />
									</Pressable>
								);
							})}
						</View>
					) : null}
					<View className="border-t border-border">
						<Pressable role="button" accessibilityLabel="Restaurar o padrão" onPress={restore} className="min-h-14 justify-center px-5 active:bg-muted/60">
							<Text className="text-lg text-info">Restaurar o padrão</Text>
						</Pressable>
					</View>
				</View>
			</ScrollView>
			<SoonSheet open={soon !== null} title={soon ?? ""} onClose={() => setSoon(null)} />
		</SafeAreaView>
	);
}
