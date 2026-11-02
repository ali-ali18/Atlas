import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RoundButton } from "@/components/chat/chat-top-bar";
import { DoneButton } from "@/components/bot/done-button";
import { OptionSheet } from "@/components/bot/option-sheet";
import { SoonSheet } from "@/components/home/soon-sheet";
import { ChevronLeftIcon, ChevronRightIcon, ChevronUpDownIcon, PencilIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { patchBot } from "@/lib/bot-api";
import { createSaveGuard, saveBot } from "@/lib/bot-save";
import { clearDraft, initDraft, updateDraft, useDraft } from "@/lib/bot-draft";
import { buildBotPatch, hasChanges, languageLabel, LANGUAGE_OPTIONS, validateBotName, type BotDraft } from "@/lib/bot-edit";
import { useHomeData } from "@/lib/home-data";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

function SectionLabel({ children }: { children: string }) {
	return (
		<Text variant="muted" className="px-4 pb-2 pt-6 text-control">
			{children}
		</Text>
	);
}

/** Editar Bot: nome, avatar (abre o editor de Avatar), idioma. Voz e velocidade ficam "em breve" (o servidor não tem esses campos). */
export default function EditBotScreen() {
	const router = useRouter();
	const scheme = useAppColorScheme();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { snapshot, applyBotUpdate, refresh } = useHomeData();
	const { apiFetch, signOut } = useAtlasSession();
	const bot = snapshot?.bots.find((item) => item.id === id);
	const original = React.useMemo<BotDraft | null>(() => (bot ? { name: bot.name, shape: resolveShape(bot.shape, bot.id), color: resolveColor(bot.color, bot.id), language: bot.language ?? "auto" } : null), [bot]);
	// Bot que veio de um cache antigo (sem o idioma): atualiza antes de mostrar, para não exibir "Automático" sem saber.
	const languageKnown = bot ? bot.language !== null : false;
	const draft = useDraft(id);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [soon, setSoon] = React.useState<string | null>(null);
	const [languageOpen, setLanguageOpen] = React.useState(false);
	const saveGuard = React.useRef(createSaveGuard()).current;

	React.useEffect(() => {
		if (bot && !languageKnown) void refresh();
	}, [bot?.id, languageKnown, refresh]);
	// Idempotente: remontar (StrictMode) não zera o que já foi editado.
	React.useEffect(() => {
		if (original && languageKnown) initDraft(id, original);
	}, [id, original, languageKnown]);
	// Sair da tela sem concluir descarta o rascunho (voltar para o avatar não passa por aqui: a tela fica na pilha).
	React.useEffect(() => () => clearDraft(id), [id]);

	if (bot && !languageKnown) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center gap-3 bg-background px-8">
				<Spinner label="Carregando" />
				<Text variant="muted" className="text-center text-control">
					Carregando os dados do bot…
				</Text>
				<Pressable role="button" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} className="min-h-11 justify-center px-4">
					<Text className="text-control text-info">Voltar</Text>
				</Pressable>
			</SafeAreaView>
		);
	}
	if (!bot || !original || !draft) return <SafeAreaView className="flex-1 bg-background" />;

	const nameCheck = validateBotName(draft.name);
	const patch = buildBotPatch(original, draft);
	const canSave = nameCheck.ok && hasChanges(patch);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const save = async () => {
		if (!patch || !canSave) return;
		setError(null);
		const result = await saveGuard.run(() => {
			setSaving(true);
			return saveBot({ patchBot: (body) => patchBot(apiFetch, id, body), applyUpdate: (body) => applyBotUpdate(id, body) }, patch);
		});
		if (result.ok === "ignored") return;
		if (result.ok) {
			goBack();
			return;
		}
		if (result.unauthorized) void signOut();
		setError(result.error);
		setSaving(false);
	};

	return (
		<SafeAreaView className="flex-1 bg-background">
			<View className="flex-row items-center justify-between px-4 pt-1.5">
				<RoundButton label="Voltar" onPress={goBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<Text className="text-lg font-semibold">Editar Bot</Text>
				<DoneButton enabled={canSave} busy={saving} onPress={() => void save()} />
			</View>
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="px-4 pb-12 pt-4">
				<Pressable role="button" accessibilityLabel="Editar avatar" onPress={() => router.push(`/avatar/${encodeURIComponent(id)}` as never)} className="size-32 items-center justify-center self-center">
					<Avatar color={draft.color} shape={draft.shape} size={150} animated={false} />
					<View className="absolute bottom-1 right-1 size-11 items-center justify-center rounded-full border border-border bg-card">
						<PencilIcon size={20} />
					</View>
				</Pressable>
				<SectionLabel>Nome</SectionLabel>
				<TextInput
					accessibilityLabel="Nome do bot"
					value={draft.name}
					onChangeText={(name) => updateDraft(id, { name })}
					maxLength={120}
					autoCapitalize="words"
					placeholderTextColor={themeColor(scheme, "muted-foreground")}
					style={{ fontSize: 17 }}
					className="h-14 rounded-2xl bg-card px-4 text-foreground outline-none"
				/>
				{!nameCheck.ok ? (
					<Text className="px-4 pt-2 text-body text-destructive" accessibilityRole="alert">
						{nameCheck.error}
					</Text>
				) : null}
				<SectionLabel>Aparência</SectionLabel>
				<Pressable role="button" accessibilityLabel="Avatar" onPress={() => router.push(`/avatar/${encodeURIComponent(id)}` as never)} className="min-h-14 flex-row items-center justify-between rounded-2xl bg-card px-4 active:opacity-80">
					<Text className="text-lg">Avatar</Text>
					<ChevronRightIcon />
				</Pressable>
				<SectionLabel>Chamadas de voz</SectionLabel>
				<View className="overflow-hidden rounded-2xl bg-card">
					<VoiceRow label="Voz" value="Em breve" onPress={() => setSoon("Voz")} />
					<VoiceRow label="Velocidade" value="Em breve" onPress={() => setSoon("Velocidade")} />
					<VoiceRow label="Idioma" value={languageLabel(draft.language)} onPress={() => setLanguageOpen(true)} last />
				</View>
				{error ? (
					<Text className="px-4 pt-4 text-control text-destructive" accessibilityRole="alert">
						{error}
					</Text>
				) : null}
			</ScrollView>
			<OptionSheet open={languageOpen} title="Idioma" options={LANGUAGE_OPTIONS} value={draft.language} onPick={(language) => (updateDraft(id, { language }), setLanguageOpen(false))} onClose={() => setLanguageOpen(false)} />
			<SoonSheet open={soon !== null} title={soon ?? ""} onClose={() => setSoon(null)} />
		</SafeAreaView>
	);
}

function VoiceRow({ label, value, onPress, last }: { label: string; value: string; onPress: () => void; last?: boolean }) {
	return (
		<Pressable role="button" accessibilityLabel={`${label}: ${value}`} onPress={onPress} className="min-h-14 flex-row items-center justify-between px-4 active:bg-muted/60">
			<Text className="text-lg">{label}</Text>
			<View className="flex-row items-center gap-1">
				<Text variant="muted" className="text-lg">
					{value}
				</Text>
				<ChevronUpDownIcon />
			</View>
			{last ? null : <View className="absolute bottom-0 left-0 right-0 h-px bg-border" />}
		</Pressable>
	);
}
