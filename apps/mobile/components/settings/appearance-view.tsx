import { useRouter } from "expo-router";
import * as React from "react";
import { Pressable, View } from "react-native";
import { ColorWheelIcon, HalfCircleIcon, MoonIcon, SolidDotIcon, SunIcon } from "@/components/icons";
import { FloatingHeaderScroll } from "@/components/ui/floating-header-scroll";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Text } from "@/components/ui/text";
import { usePreferences } from "@/lib/app-preferences";
import { type AccentPreference, accentPreferenceLabel, type ThemePreference, themePreferenceLabel } from "@/lib/preferences";
import { SURFACE_RADIUS } from "@/lib/surfaces";
import { useSurfaces } from "@/lib/use-surfaces";

const TILE_HEIGHT = 96;

/** Ladrilho de escolha como no Grok: cartão arredondado com o ícone no centro e o rótulo embaixo. Escolhido = preenchido (`surface`), rótulo em foreground; o resto só com contorno e rótulo apagado. */
function Tile({ label, selected, onPress, children }: { label: string; selected: boolean; onPress: () => void; children: React.ReactNode }) {
	const surfaces = useSurfaces();
	return (
		<Pressable role="radio" aria-checked={selected} accessibilityLabel={label} onPress={onPress} className="flex-1 active:opacity-70">
			<View className="items-center justify-center" style={{ height: TILE_HEIGHT, borderRadius: SURFACE_RADIUS, borderWidth: 1, borderColor: surfaces.surfaceEdge, backgroundColor: selected ? surfaces.surface : "transparent" }}>
				{children}
			</View>
			<Text numberOfLines={1} variant={selected ? undefined : "muted"} className="pt-2 text-center text-control">
				{label}
			</Text>
		</Pressable>
	);
}

const THEMES: readonly { value: ThemePreference; icon: React.ReactNode }[] = [
	{ value: "system", icon: <HalfCircleIcon /> },
	{ value: "light", icon: <SunIcon /> },
	{ value: "dark", icon: <MoonIcon /> },
];

const ACCENTS: readonly { value: AccentPreference; icon: React.ReactNode }[] = [
	{ value: "neutral", icon: <SolidDotIcon /> },
	{ value: "bot", icon: <ColorWheelIcon /> },
];

/** Aparência: três ladrilhos de tema (Sistema, Claro, Escuro) e dois de cor de destaque (Neutro, Cor do bot). Valem só neste aparelho. */
export function AppearanceView() {
	const router = useRouter();
	const { preferences, update } = usePreferences();
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/settings" as never));
	return (
		<ScreenFrame edges={["bottom", "left", "right"]}>
			<FloatingHeaderScroll header={<ScreenHeader title="Aparência" align="left" onBack={goBack} />} contentContainerClassName="px-4 pb-12">
				<View className="flex-row gap-3" role="radiogroup" accessibilityLabel="Tema">
					{THEMES.map((item) => (
						<Tile key={item.value} label={themePreferenceLabel(item.value)} selected={preferences.theme === item.value} onPress={() => update({ theme: item.value })}>
							{item.icon}
						</Tile>
					))}
				</View>
				<Text variant="muted" className="px-1 pb-2 pt-7 text-body">
					Cor de destaque
				</Text>
				<View className="flex-row gap-3" role="radiogroup" accessibilityLabel="Cor de destaque">
					{ACCENTS.map((item) => (
						<Tile key={item.value} label={accentPreferenceLabel(item.value)} selected={preferences.accent === item.value} onPress={() => update({ accent: item.value })}>
							{item.icon}
						</Tile>
					))}
				</View>
			</FloatingHeaderScroll>
		</ScreenFrame>
	);
}
