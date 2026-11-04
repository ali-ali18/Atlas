import * as React from "react";
import { BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { CatalogDetail } from "@/lib/catalog";
import { cn } from "@/lib/cn";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";
import { cronSentence } from "@/lib/routine-summary";
import { buildInstallBody, CATALOG_NAME_MAX, type InstallInput } from "@/lib/catalog-install";

export type DetailLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; detail: CatalogDetail };
export type DetailDone = { botId: string; name: string; warnings: string[] };

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
	return (
		<View className="mt-6 gap-2">
			<Text accessibilityRole="header" className="px-1 text-lg font-semibold">
				{title}
			</Text>
			{note ? (
				<Text variant="muted" className="px-1 text-control">
					{note}
				</Text>
			) : null}
			<View className="overflow-hidden rounded-2xl bg-secondary">{children}</View>
		</View>
	);
}

const Divider = () => <View className="ml-4 h-px bg-border" />;

/**
 * Detalhe do bot do catálogo: avatar grande, nome e descrição, habilidades, rotinas sugeridas (interruptor para
 * escolher), "Usar o modelo sugerido" (só com o nome de exibição), nome editável e "Instalar" em largura total.
 * Instalado com avisos, a tela fica no resultado ("Bot instalado" + avisos + "Abrir conversa").
 */
export function CatalogDetailView({ load, modelName, alreadyInstalled, busy, error, done, locked = false, onInstall, onOpenChat, onBack, onRetry }: { load: DetailLoad; modelName: string | null; alreadyInstalled: boolean; busy: boolean; error: string | null; done: DetailDone | null; locked?: boolean; onInstall: (input: InstallInput) => void; onOpenChat: () => void; onBack: () => void; onRetry: () => void }) {
	const scheme = useAppColorScheme();
	const detail = load.status === "ready" ? load.detail : null;
	const [name, setName] = React.useState("");
	const [picked, setPicked] = React.useState<readonly number[]>([]);
	const [useModel, setUseModel] = React.useState(false);
	// O nome começa o do catálogo, uma vez, quando o detalhe chega.
	const seeded = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (detail && seeded.current !== detail.slug) {
			seeded.current = detail.slug;
			setName(detail.name);
			setPicked([]);
			setUseModel(false);
		}
	}, [detail]);
	// Instalando: voltar no meio deixaria o bot nascer sem a pessoa ver.
	React.useEffect(() => {
		if (!busy || Platform.OS !== "android") return;
		const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
		return () => subscription.remove();
	}, [busy]);

	const toggleRoutine = (index: number) => setPicked((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]));
	const input: InstallInput = { name, useSuggestedModel: useModel && modelName !== null, routines: picked };
	const valid = buildInstallBody(input).ok && !locked;

	let body: React.ReactNode;
	if (load.status === "loading") {
		body = (
			<View className="items-center pt-32">
				<Spinner size="large" label="Carregando o bot" />
			</View>
		);
	} else if (load.status === "error") {
		body = (
			<View className="items-center gap-4 px-8 pt-32">
				<Text variant="muted" className="text-center text-control">
					{load.message}
				</Text>
				<Button variant="secondary" onPress={onRetry}>
					<Text>Tentar de novo</Text>
				</Button>
			</View>
		);
	} else if (done) {
		body = (
			<View className="items-center gap-4 px-6 pt-10">
				<Avatar color={load.detail.color} shape={load.detail.shape} size={150} animated={false} />
				<Text variant="title" className="text-center">
					Bot instalado
				</Text>
				<Text variant="muted" className="text-center text-base">
					{done.name || load.detail.name} já está na sua lista.
				</Text>
				<View accessibilityRole="alert" className="w-full gap-2 rounded-2xl bg-warning/10 p-4">
					{done.warnings.map((warning, index) => (
						<Text key={`${index}:${warning}`} className="text-control text-warning">
							{warning}
						</Text>
					))}
				</View>
			</View>
		);
	} else {
		const current = load.detail;
		body = (
			<View className="px-5 pb-6 pt-2">
				<View className="items-center gap-2 pt-2">
					<Avatar color={current.color} shape={current.shape} size={150} animated={false} />
					<Text variant="title" className="text-center">
						{current.name}
					</Text>
					{current.description ? (
						<Text variant="muted" className="text-center text-base">
							{current.description}
						</Text>
					) : null}
					{alreadyInstalled ? (
						<Text variant="caption" className="text-center">
							Você já tem este bot. Instalar de novo cria outro.
						</Text>
					) : null}
				</View>

				<Section title="Nome">
					<TextInput accessibilityLabel="Nome do bot" value={name} onChangeText={setName} maxLength={CATALOG_NAME_MAX} editable={!busy} returnKeyType="done" placeholder="Dê um nome ao seu Bot" placeholderTextColor={themeColor(scheme, "muted-foreground")} className="h-14 px-4 text-lg text-foreground outline-none" />
				</Section>

				{current.skills.length > 0 ? (
					<Section title="Habilidades" note="Elas não liberam nenhuma ferramenta nova.">
						{current.skills.map((skill, position) => (
							<React.Fragment key={skill.slug}>
								{position > 0 ? <Divider /> : null}
								<View className="gap-0.5 px-4 py-3">
									<Text numberOfLines={1} className="text-base font-medium">
										{skill.name}
									</Text>
									{skill.unavailable ? (
										<Text className="text-control text-warning">Não consegui carregar esta habilidade agora. Tento instalá-la mesmo assim.</Text>
									) : skill.blocked ? (
										<Text className="text-control text-warning">Não será instalada.</Text>
									) : skill.description ? (
										<Text numberOfLines={2} variant="muted" className="text-control">
											{skill.description}
										</Text>
									) : null}
								</View>
							</React.Fragment>
						))}
					</Section>
				) : null}

				{current.routines.length > 0 ? (
					<Section title="Rotinas sugeridas" note="Desligadas por padrão. Só as ligadas são criadas, e você pode pausar depois.">
						{current.routines.map((routine, position) => (
							<React.Fragment key={routine.index}>
								{position > 0 ? <Divider /> : null}
								<View className="flex-row items-center gap-3 px-4 py-3">
									<View className="min-w-0 flex-1 gap-0.5">
										<Text numberOfLines={2} className="text-base font-medium">
											{routine.name}
										</Text>
										<Text variant="muted" className="text-control">
											{cronSentence(routine.cron)}
										</Text>
									</View>
									<ToggleSwitch accessibilityLabel={`Criar a rotina ${routine.name}`} value={picked.includes(routine.index)} disabled={busy} onValueChange={() => toggleRoutine(routine.index)} color={current.color} />
								</View>
							</React.Fragment>
						))}
					</Section>
				) : null}

				{modelName ? (
					<Section title="Modelo">
						<View className="flex-row items-center gap-3 px-4 py-3">
							<View className="min-w-0 flex-1 gap-0.5">
								<Text className="text-base font-medium">Usar o modelo sugerido</Text>
								<Text numberOfLines={1} variant="muted" className="text-control">
									{modelName}
								</Text>
							</View>
							<ToggleSwitch accessibilityLabel="Usar o modelo sugerido" value={useModel} disabled={busy} onValueChange={setUseModel} color={current.color} />
						</View>
					</Section>
				) : null}
			</View>
		);
	}

	const ready = load.status === "ready";
	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView behavior="padding" className="flex-1">
				<ScreenHeader title="Bot pronto" onBack={busy ? () => undefined : onBack} />
				<ScrollView className="flex-1" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
					{body}
				</ScrollView>
				{ready ? (
					<View className="gap-2 px-4 pb-3 pt-2">
						{error ? (
							<Text accessibilityRole="alert" className="text-center text-control text-destructive">
								{error}
							</Text>
						) : null}
						{done ? (
							<Pressable role="button" accessibilityLabel="Abrir conversa" onPress={onOpenChat} className="h-14 w-full items-center justify-center rounded-full bg-primary active:opacity-80">
								<Text className="text-lg font-semibold text-primary-foreground">Abrir conversa</Text>
							</Pressable>
						) : (
							<Pressable role="button" accessibilityLabel={busy ? "Instalando o bot" : "Instalar"} accessibilityState={{ disabled: !valid || busy, busy }} disabled={!valid || busy} onPress={() => onInstall(input)} className={cn("h-14 w-full flex-row items-center justify-center gap-2 rounded-full", valid ? "bg-primary active:opacity-80" : "bg-muted")}>
								{busy ? <Spinner tone="primary-foreground" label="Instalando" /> : null}
								<Text className={cn("text-lg font-semibold", valid ? "text-primary-foreground" : "text-muted-foreground")}>{busy ? "Instalando…" : "Instalar"}</Text>
							</Pressable>
						)}
					</View>
				) : null}
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
