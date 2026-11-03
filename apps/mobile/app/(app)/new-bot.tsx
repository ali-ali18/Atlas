import { useRouter } from "expo-router";
import * as React from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CloseIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { BOT_NAME_MAX } from "@/lib/bot-edit";
import { createBot } from "@/lib/bot-api";
import { cn } from "@/lib/cn";
import { useHomeData } from "@/lib/home-data";
import { canCreateBot, NEW_BOT_COLORS, NEW_BOT_SHAPES, randomAvatar, seededRandom } from "@/lib/new-bot";
import { createNewBotSubmitter } from "@/lib/new-bot-submit";
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
				refresh: () => latest.current.refresh(),
				onUnauthorized: () => void latest.current.signOut(),
			}),
		[],
	);
	const close = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const enabled = canCreateBot(name, busy);
	const create = async () => {
		if (!enabled) return;
		setBusy(true);
		setError(null);
		const outcome = await submitter({ name, shape, color });
		if (outcome === null) return;
		if (outcome.ok) {
			// Fecha o formulário e abre o chat do bot novo (voltar do chat leva à home).
			router.replace(`/chat/${encodeURIComponent(outcome.botId)}` as never);
			return;
		}
		setBusy(false);
		setError(outcome.error);
	};
	const neutral = themeColor(scheme, "muted-foreground");
	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<View className="flex-row items-center gap-3 px-4 pt-1.5">
					<Pressable role="button" accessibilityLabel="Fechar" onPress={close} className="size-11 items-center justify-center rounded-full bg-secondary active:opacity-70">
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
						className="h-14 w-full rounded-full bg-secondary px-6 text-center text-xl text-foreground outline-none"
					/>
					<View accessibilityRole="radiogroup" className="mt-4 w-full flex-row flex-wrap">
						{NEW_BOT_SHAPES.map((item) => (
							<View key={item} className="w-1/5 items-center py-0.5">
								<Pressable role="radio" accessibilityLabel={`Forma ${item}`} accessibilityState={{ checked: item === shape }} onPress={() => setShape(item)} className={cn("size-14 items-center justify-center rounded-2xl border-2", item === shape ? "border-foreground/60" : "border-transparent")}>
									<Avatar color={neutral} shape={item} size={44} animated={false} eyeColor={themeColor(scheme, "background")} />
								</Pressable>
							</View>
						))}
					</View>
					<View accessibilityRole="radiogroup" className="mt-2 w-full flex-row flex-wrap">
						{NEW_BOT_COLORS.map((item) => {
							const selected = item.value.toLowerCase() === color.toLowerCase();
							return (
								<View key={item.id} className="w-1/6 items-center py-1">
									<Pressable role="radio" accessibilityLabel={`Cor ${item.name}`} accessibilityState={{ checked: selected }} onPress={() => setColor(item.value)} className={cn("size-11 items-center justify-center rounded-full border-2", selected ? "border-foreground" : "border-transparent")}>
										<View style={{ backgroundColor: item.value, borderColor: themeColor(scheme, "border") }} className="size-8 rounded-full border" />
									</Pressable>
								</View>
							);
						})}
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
