import { Stack, useRouter } from "expo-router";
import * as React from "react";
import { BackHandler, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CloseIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { ShapeOption } from "@/components/ui/shape-option";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { BOT_NAME_MAX } from "@/lib/bot-edit";
import { createBot } from "@/lib/bot-api";
import { cn } from "@/lib/cn";
import { useHomeData } from "@/lib/home-data";
import { canCreateBot, shapeLabel, NEW_BOT_COLORS, NEW_BOT_SHAPES, randomAvatar, seededRandom } from "@/lib/new-bot";
import { createNewBotSubmitter } from "@/lib/new-bot-submit";
import { chatChrome } from "@/lib/chat-surface";
import { chunkRows, COLORS_PER_ROW, GRID_SHAPE_CELL, GRID_SHAPE_SIZE, needsExpanded, SHAPES_PER_ROW, visibleShapes } from "@/lib/shape-ring";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

/**
 * Criar novo Bot (o "+" da home): X e título no topo, prévia grande do avatar (respira e pisca; parado se o sistema pede
 * para reduzir movimento), campo do nome, grade das formas do motor, grade das cores e "Criar" no rodapé, cinza até
 * haver um nome. Forma e cor começam sorteadas. Criado, o bot entra na home e a tela dá lugar ao chat dele. Não vira o
 * bot principal e não manda idioma nem modelo (vale o padrão da conta).
 */
export default function NewBotScreen() {
	const router = useRouter();
	const scheme = useAppColorScheme();
	const { apiFetch, signOut } = useAtlasSession();
	const { addBot, refresh } = useHomeData();
	const [initial] = React.useState(() => randomAvatar(seededRandom((Math.random() * 2 ** 32) >>> 0)));
	const [name, setName] = React.useState("");
	const [shape, setShape] = React.useState(initial.shape);
	const [color, setColor] = React.useState(initial.color);
	// A forma sorteada pode estar depois da 3a linha: a grade já abre expandida para ela aparecer.
	const [expanded, setExpanded] = React.useState(() => needsExpanded(NEW_BOT_SHAPES, initial.shape));
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const latest = React.useRef({ apiFetch, signOut, addBot, refresh });
	latest.current = { apiFetch, signOut, addBot, refresh };
	// Um criador por abertura da tela: o toque duplo e o "já criado" valem para ele.
	const submitter = React.useMemo(
		() =>
			createNewBotSubmitter({
				createBot: (body) => createBot(latest.current.apiFetch, body),
				addBot: (bot) => latest.current.addBot(bot),
				refresh: () => latest.current.refresh({ fresh: true }),
				onUnauthorized: () => void latest.current.signOut(),
			}),
		[],
	);
	// Criando: fechar no meio deixaria o bot nascer sem a pessoa ver. O X, o gesto e o voltar do Android esperam.
	const mounted = React.useRef(true);
	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	React.useEffect(() => {
		if (!busy) return;
		const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
		return () => subscription.remove();
	}, [busy]);
	const close = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const enabled = canCreateBot(name, busy);
	const create = async () => {
		if (!enabled) return;
		setBusy(true);
		setError(null);
		const outcome = await submitter({ name, shape, color });
		// A tela já saiu (sessão encerrada, por exemplo): o bot foi criado, mas não há o que navegar nem estado a mexer.
		if (outcome === null || !mounted.current) return;
		if (outcome.ok) {
			// Fecha o formulário e abre o chat do bot novo (voltar do chat leva à home).
			router.replace(`/chat/${encodeURIComponent(outcome.botId)}` as never);
			return;
		}
		setBusy(false);
		setError(outcome.error);
	};
	// Mesma pele dos controles do chat (o RoundButton do topo): fill e borda do chatChrome.
	const chrome = chatChrome(scheme);
	const neutral = themeColor(scheme, "muted-foreground");
	return (
		<SafeAreaView className="flex-1 bg-background">
			<Stack.Screen options={{ gestureEnabled: !busy }} />
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<View className="flex-row items-center gap-3 px-4 pt-1.5">
					<Pressable role="button" accessibilityLabel="Fechar" accessibilityState={{ disabled: busy }} disabled={busy} onPress={close} style={{ backgroundColor: chrome.fill, borderColor: chrome.edge }} className={cn("size-11 items-center justify-center rounded-full border active:opacity-70", busy && "opacity-40")}>
						<CloseIcon size={20} tone="foreground" />
					</Pressable>
					<Text className="text-lg font-semibold">Criar novo Bot</Text>
				</View>
				<ScrollView className="flex-1" contentContainerClassName="items-center px-4 pb-6 pt-2" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
					<View className="h-52 w-full items-center justify-center">
						<Avatar color={color} shape={shape} size={190} animated breathe look />
					</View>
					<TextInput
						accessibilityLabel="Nome do bot"
						placeholder="Dê um nome ao seu Bot"
						placeholderTextColor={themeColor(scheme, "muted-foreground")}
						value={name}
						onChangeText={setName}
						maxLength={BOT_NAME_MAX}
						returnKeyType="done"
						onSubmitEditing={() => void create()}
						editable={!busy}
						style={{ backgroundColor: chrome.fill, borderColor: chrome.edge }}
						className="h-14 w-full rounded-full border px-6 text-center text-xl text-foreground outline-none"
					/>
					{/* Três linhas à vista (a referência) e "Ver mais" para as demais; a lista é a do editor de avatar e do web. */}
					<View accessibilityRole="radiogroup" className="mt-3 w-full">
						{chunkRows(visibleShapes(NEW_BOT_SHAPES, expanded), SHAPES_PER_ROW).map((row, rowIndex) => (
							<View key={rowIndex} className="w-full flex-row justify-between">
								{row.map((item, column) =>
									item === null ? (
										<View key={`gap-${column}`} style={{ width: GRID_SHAPE_CELL, height: GRID_SHAPE_CELL }} />
									) : (
										<ShapeOption key={item} shape={item} color={neutral} label={shapeLabel(NEW_BOT_SHAPES.indexOf(item), NEW_BOT_SHAPES.length)} selected={item === shape} cell={GRID_SHAPE_CELL} size={GRID_SHAPE_SIZE} eyeColor={themeColor(scheme, "background")} surface={themeColor(scheme, "background")} onPress={() => setShape(item)} />
									),
								)}
							</View>
						))}
					</View>
					<Button variant="ghost" size="sm" accessibilityState={{ expanded }} accessibilityLabel={expanded ? "Ver menos formas" : "Ver mais formas"} onPress={() => setExpanded((value) => !value)} className="mt-1">
						<Text>{expanded ? "Ver menos" : "Ver mais"}</Text>
					</Button>
					<View accessibilityRole="radiogroup" className="mt-2 w-full">
						{chunkRows(NEW_BOT_COLORS, COLORS_PER_ROW).map((row, rowIndex) => (
							<View key={rowIndex} className="w-full flex-row justify-between py-1">
								{row.map((item, column) => {
									if (item === null) return <View key={`gap-${column}`} className="size-10" />;
									const selected = item.value.toLowerCase() === color.toLowerCase();
									return (
										<Pressable key={item.id} role="radio" accessibilityLabel={`Cor ${item.name}`} accessibilityState={{ checked: selected }} onPress={() => setColor(item.value)} style={{ borderColor: selected ? chrome.edge : "transparent" }} className="size-10 items-center justify-center rounded-full border-2">
											<View style={{ backgroundColor: item.value, borderColor: themeColor(scheme, "border") }} className="size-8 rounded-full border" />
										</Pressable>
									);
								})}
							</View>
						))}
					</View>
				</ScrollView>
				<View className="gap-2 px-4 pb-3 pt-2">
					{error ? (
						<Text accessibilityRole="alert" className="text-center text-control text-destructive">
							{error}
						</Text>
					) : null}
					<Pressable role="button" accessibilityLabel={busy ? "Criando o bot" : "Criar"} accessibilityState={{ disabled: !enabled, busy }} disabled={!enabled} onPress={() => void create()} className={cn("h-14 w-full flex-row items-center justify-center gap-2 rounded-full", enabled ? "bg-primary active:opacity-80" : "bg-muted")}>
						{busy ? <Spinner tone="primary-foreground" label="Criando" /> : null}
						<Text className={cn("text-lg font-semibold", enabled ? "text-primary-foreground" : "text-muted-foreground")}>{busy ? "Criando…" : "Criar"}</Text>
					</Pressable>
				</View>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
