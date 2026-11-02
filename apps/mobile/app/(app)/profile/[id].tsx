import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { Pressable, ScrollView, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PrimaryBadge } from "@/components/home/bot-avatar";
import { SoonSheet } from "@/components/home/soon-sheet";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { ChevronLeftIcon, ChevronRightIcon, ClockIcon, CodeIcon, LibraryIcon, MonitorIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { webChatUrl } from "@/lib/chat-links";
import { useHomeData } from "@/lib/home-data";
import { LIST_POSE } from "@/lib/avatar-pose";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

const ROWS = [
	{ key: "dev", label: "Programação", icon: <CodeIcon /> },
	{ key: "routines", label: "Rotinas", icon: <ClockIcon /> },
	{ key: "library", label: "Biblioteca", icon: <LibraryIcon /> },
	{ key: "computer", label: "Computador", icon: <MonitorIcon /> },
] as const;

/**
 * Perfil do bot (tela simples): avatar grande com a estrela do bot principal, nome, "Editar" (em breve), o cartão
 * com Programação / Rotinas / Biblioteca / Computador (abrem o web no navegador por enquanto) e Notificações (em breve).
 */
export default function ProfileScreen() {
	const router = useRouter();
	const scheme = useAppColorScheme();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { snapshot } = useHomeData();
	const { serverUrl } = useAtlasSession();
	const bot = snapshot?.bots.find((item) => item.id === id);
	const [soon, setSoon] = React.useState<string | null>(null);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const openWeb = () => {
		const url = webChatUrl(serverUrl, id);
		if (url) void WebBrowser.openBrowserAsync(url).catch(() => undefined);
	};
	return (
		<SafeAreaView className="flex-1 bg-background">
			<View className="flex-row items-center justify-between px-4 pt-1.5">
				<RoundButton label="Voltar" onPress={goBack}>
					<ChevronLeftIcon />
				</RoundButton>
			</View>
			{bot ? (
				<ScrollView contentContainerClassName="items-center gap-5 px-4 pb-10 pt-4">
					<View className="size-24 items-center justify-center">
						<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={88} animated={false} pose={LIST_POSE} />
						{bot.isPrimary ? <PrimaryBadge size={24} /> : null}
					</View>
					<Text className="text-center text-2xl font-semibold">{bot.name}</Text>
					<Button variant="secondary" onPress={() => setSoon("Editar bot")}>
						<Text>Editar</Text>
					</Button>
					<View className="w-full overflow-hidden rounded-panel bg-card">
						{ROWS.map((row, index) => (
							<Pressable key={row.key} role="button" accessibilityLabel={`${row.label}. Abrir no navegador`} onPress={openWeb} className="min-h-16 flex-row items-center gap-4 px-5 active:bg-muted/60">
								{row.icon}
								<Text className="min-w-0 flex-1 text-lg">{row.label}</Text>
								<ChevronRightIcon />
								{index < ROWS.length - 1 ? <View className="absolute bottom-0 left-14 right-0 h-px bg-border" /> : null}
							</Pressable>
						))}
					</View>
					<View className="w-full gap-2">
						<View className="min-h-16 flex-row items-center justify-between rounded-panel bg-card px-5">
							<Text className="text-lg">Notificações</Text>
							<Pressable accessibilityLabel="Notificações (em breve)" onPress={() => setSoon("Notificações")}>
								<View pointerEvents="none">
									<Switch value={false} disabled trackColor={{ false: themeColor(scheme, "input"), true: resolveColor(bot.color, bot.id) }} />
								</View>
							</Pressable>
						</View>
						<Text variant="muted" className="px-2 text-control">
							Receba uma notificação quando este Bot terminar ou estiver aguardando você. Em breve.
						</Text>
					</View>
				</ScrollView>
			) : (
				<View className="flex-1 items-center justify-center px-8">
					<Text variant="muted" className="text-center text-control">
						Não encontrei este bot.
					</Text>
				</View>
			)}
			<SoonSheet open={soon !== null} title={soon ?? ""} onClose={() => setSoon(null)} />
		</SafeAreaView>
	);
}
