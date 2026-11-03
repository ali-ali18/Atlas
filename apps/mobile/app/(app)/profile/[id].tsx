import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { ScrollView, View } from "react-native";
import { PrimaryBadge } from "@/components/home/bot-avatar";
import { SoonSheet } from "@/components/home/soon-sheet";
import { ChevronRightIcon, ClockIcon, CodeIcon, LibraryIcon, MonitorIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useAtlasSession } from "@/lib/atlas-session";
import { webChatUrl } from "@/lib/chat-links";
import { runStatusLine, useBotRun } from "@/lib/run-store";
import { botColors } from "@/lib/bot-color";
import { useHomeData } from "@/lib/home-data";
import { LIST_POSE } from "@/lib/avatar-pose";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

const ROWS = [
	{ key: "executions", label: "Execuções", icon: <CodeIcon /> },
	{ key: "routines", label: "Rotinas", icon: <ClockIcon /> },
	{ key: "library", label: "Biblioteca", icon: <LibraryIcon /> },
	{ key: "computer", label: "Computador", icon: <MonitorIcon /> },
] as const;

/**
 * Perfil do bot (tela simples): avatar grande com a estrela do bot principal, nome, "Editar" (em breve), o cartão
 * com Execuções / Rotinas / Biblioteca / Computador (telas do app) e Notificações (em breve).
 */
export default function ProfileScreen() {
	const router = useRouter();
	const scheme = useAppColorScheme();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { snapshot } = useHomeData();
	const { serverUrl } = useAtlasSession();
	const bot = snapshot?.bots.find((item) => item.id === id);
	const run = useBotRun(id);
	const [soon, setSoon] = React.useState<string | null>(null);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const openWeb = () => {
		const url = webChatUrl(serverUrl, id);
		if (url) void WebBrowser.openBrowserAsync(url).catch(() => undefined);
	};
	return (
		<ScreenFrame>
			<ScreenHeader onBack={goBack} />
			{bot ? (
				<ScrollView contentContainerClassName="items-center gap-5 px-4 pb-10 pt-4">
					<View className="size-24 items-center justify-center">
						<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={88} animated={false} pose={LIST_POSE} />
						{bot.isPrimary ? <PrimaryBadge size={24} /> : null}
					</View>
					<Text className="text-center text-2xl font-semibold">{bot.name}</Text>
					<Button variant="secondary" onPress={() => router.push(`/edit/${encodeURIComponent(id)}` as never)}>
						<Text>Editar</Text>
					</Button>
					<SurfaceGroup className="w-full">
						{ROWS.map((row) => (
							<SurfaceRow key={row.key} label={row.key === "executions" ? `${row.label}. ${runStatusLine(run)}` : row.label} onPress={row.key === "executions" ? () => router.push(`/executions/${encodeURIComponent(id)}` as never) : row.key === "routines" ? () => router.push(`/routines/${encodeURIComponent(id)}` as never) : row.key === "library" ? () => router.push(`/library/${encodeURIComponent(id)}` as never) : row.key === "computer" ? () => router.push(`/computer/${encodeURIComponent(id)}` as never) : openWeb} className="min-h-16">
								{row.icon}
								<Text className="text-lg">{row.label}</Text>
								<View className="min-w-0 flex-1 items-end">{row.key === "executions" ? <Text numberOfLines={1} variant="muted" className="text-control">{runStatusLine(run)}</Text> : null}</View>
								<ChevronRightIcon />
							</SurfaceRow>
						))}
					</SurfaceGroup>
					<View className="w-full gap-2">
						<SurfaceGroup>
							<SurfaceRow className="min-h-16 justify-between">
								<Text className="text-lg">Notificações</Text>
								<ToggleSwitch accessibilityLabel="Notificações (em breve)" value={false} onValueChange={() => setSoon("Notificações")} color={botColors(resolveColor(bot.color, bot.id), { accent: themeColor(scheme, "primary"), foreground: themeColor(scheme, "primary-foreground") }).accent} />
							</SurfaceRow>
						</SurfaceGroup>
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
		</ScreenFrame>
	);
}
