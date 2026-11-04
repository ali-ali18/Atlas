import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { Image, KeyboardAvoidingView, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RoundButton, TOP_BAR_CONTROL, TOP_BAR_SIDE } from "@/components/chat/chat-top-bar";
import { ChevronLeftIcon, ClipboardPasteIcon, DotsIcon, HelpIcon, KeyboardIcon, MonitorIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { BotLoader } from "@/components/ui/bot-loader";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { ComputerMenu } from "@/components/computer/computer-menu";
import { Zoomable, type ZoomableHandle } from "@/components/computer/zoomable";
import { isZoomed } from "@/lib/pinch-zoom";
import type { MobileAvatarState } from "@/lib/avatar-activity";
import type { HomeBot } from "@/lib/home-types";
import { themeVars } from "@/lib/theme";
import { ForcedColorScheme } from "@/lib/use-theme";

/** Estado da tela: carregando a sessão, pronta (mostra o computador), computador desligado ou erro ao conectar. */
export type ComputerStatus = "loading" | "ready" | "off" | "error";

/** A tela do Computador é sempre escura (como no Grok), qualquer que seja o tema do app. */
const SCREEN = "#000000";
const PILL_FILL = "#2c2c2e";
const PILL_EDGE = "#4b4b4d";
const SIDE = TOP_BAR_SIDE;

export type ComputerViewProps = {
	bot: Pick<HomeBot, "id" | "name" | "color" | "shape">;
	avatarState?: MobileAvatarState;
	status: ComputerStatus;
	/** Imagem do desktop remoto (uri). Alternativa: `children` com o conteúdo remoto. */
	source?: { uri: string };
	children?: React.ReactNode;
	/** Proporção do quadro remoto (largura / altura). Padrão 16:9. */
	aspectRatio?: number;
	/** O usuário está no controle: o topo ganha o "…" (Modo trackpad) e o rodapé troca a pílula pelos botões redondos Colar e Teclado. Soltar = sair da tela. */
	controlling?: boolean;
	/** "Modo trackpad" ligado (marca no menu). */
	trackpad?: boolean;
	onBack: () => void;
	onHelp?: () => void;
	onTakeControl?: () => void;
	onToggleTrackpad?: () => void;
	onPaste?: () => void;
	onKeyboard?: () => void;
	onRetry?: () => void;
	/** Liga o computador desligado (status "off"). Sem isto o estado "desligado" fica só com o texto. */
	onStart?: () => void;
	/** Frase do erro (status "error"); sem ela vale o texto padrão. */
	errorText?: string | null;
	/** Extras do controle acima das ações (barra do teclado, aviso de erro ao colar); só aparecem enquanto o usuário controla. */
	controlExtra?: React.ReactNode;
};

/** Botão redondo do canto de baixo no controle (Colar à esquerda, Teclado à direita), sem rótulo na tela. */
function RoundAction({ label, onPress, children }: { label: string; onPress?: () => void; children: React.ReactNode }) {
	return (
		<Pressable role="button" accessibilityLabel={label} onPress={onPress} style={{ width: 48, height: 48, backgroundColor: PILL_FILL, borderColor: PILL_EDGE }} className="items-center justify-center rounded-full border active:opacity-70">
			{children}
		</Pressable>
	);
}

/** Cor da esfera da tela "Conectando": cinza claro, que combina com o fundo preto e com os olhos escuros. */
const SPHERE = "#e4e4e7";
/** O bot girando da tela "Conectando" (a peça comum `BotLoader`, com a esfera cinza clara que combina com o fundo preto). */
function SpinningSphere() {
	return <BotLoader size={72} label="Conectando ao computador" color={SPHERE} eyeColor={SCREEN} />;
}

/** "1x": volta ao tamanho normal. Só aparece com a tela ampliada (no controle não há outro jeito de desfazer o zoom com um dedo). */
function ResetZoomButton({ onPress }: { onPress: () => void }) {
	return (
		<RoundAction label="Voltar ao tamanho normal" onPress={onPress}>
			<Text className="text-control font-semibold" style={{ color: "#ffffff" }}>
				1x
			</Text>
		</RoundAction>
	);
}

function Placeholder({ status, onRetry, onStart, errorText }: { status: Exclude<ComputerStatus, "ready">; onRetry?: () => void; onStart?: () => void; errorText?: string | null }) {
	if (status === "loading") {
		return (
			<View className="flex-1 items-center justify-center gap-4">
				<SpinningSphere />
				<Text className="text-control" style={{ color: "#a1a1aa" }}>
					Conectando ao computador…
				</Text>
			</View>
		);
	}
	const off = status === "off";
	return (
		<View className="flex-1 items-center justify-center gap-2 px-10">
			<MonitorIcon size={40} tone="muted-foreground" />
			<Text className="mt-2 text-center text-lg font-semibold" style={{ color: "#ffffff" }}>
				{off ? "O computador do bot está desligado." : "Não deu para conectar ao computador."}
			</Text>
			<Text className="text-center text-control" style={{ color: "#a1a1aa" }}>
				{off ? "Peça ao bot uma tarefa que use o computador e ele liga sozinho." : (errorText ?? "Confira sua conexão e tente de novo.")}
			</Text>
			{off ? (
				onStart ? (
					<Button variant="secondary" className="mt-4 rounded-full px-6" onPress={onStart}>
						<Text>Ligar o computador</Text>
					</Button>
				) : null
			) : (
				<Button variant="secondary" className="mt-4 rounded-full px-6" onPress={onRetry}>
					<Text>Tentar de novo</Text>
				</Button>
			)}
		</View>
	);
}

/**
 * Tela do Computador do bot (padrão do Grok, sempre escura): topo com voltar, avatar e nome do bot e "?"; a imagem do
 * desktop remoto no meio, com zoom por pinça; "Assumir o controle" embaixo à direita (só em "somente ver"). No controle
 * o topo ganha o "…" (menu com "Modo trackpad") e o rodapé mostra só dois botões redondos: Colar (esquerda) e Teclado
 * (direita). Soltar o controle é sair da tela. Só apresentação: quem usa liga os callbacks (sem lógica de VM).
 */
export function ComputerView({ bot, avatarState = "idle", status, source, children, aspectRatio = 16 / 9, controlling = false, trackpad = false, onBack, onHelp, onTakeControl, onToggleTrackpad, onPaste, onKeyboard, onRetry, onStart, errorText, controlExtra }: ComputerViewProps) {
	const insets = useSafeAreaInsets();
	const ready = status === "ready";
	// Com a tela (`children`/`source`) montada o palco existe também enquanto conecta, coberto pela esfera.
	const stage = ready || (status === "loading" && Boolean(children || source));
	const [menuOpen, setMenuOpen] = React.useState(false);
	const zoomRef = React.useRef<ZoomableHandle>(null);
	const [zoomed, setZoomed] = React.useState(false);
	// Saiu do controle: o menu não fica aberto.
	React.useEffect(() => {
		if (!controlling) setMenuOpen(false);
	}, [controlling]);
	return (
		<ForcedColorScheme value="dark">
		<KeyboardAvoidingView behavior="padding" className="flex-1" style={[{ backgroundColor: SCREEN }, themeVars("dark")]}>
			<View style={{ paddingTop: insets.top + 6, paddingHorizontal: SIDE, height: insets.top + 6 + TOP_BAR_CONTROL }} className="flex-row items-center gap-3">
				<RoundButton label="Voltar" onPress={onBack}>
					<ChevronLeftIcon />
				</RoundButton>
				<View className="min-w-0 shrink flex-row items-center gap-2">
					<Avatar color={resolveColor(bot.color, bot.id)} shape={resolveShape(bot.shape, bot.id)} size={32} animated look state={avatarState} eyeColor={SCREEN} />
					<Text numberOfLines={1} className="min-w-0 shrink text-control font-semibold" style={{ color: "#ffffff" }}>
						{bot.name}
					</Text>
				</View>
				<View className="flex-1" />
				<RoundButton label="Ajuda" onPress={onHelp ?? (() => undefined)}>
					<HelpIcon />
				</RoundButton>
				{ready && controlling ? (
					<RoundButton label="Mais opções" onPress={() => setMenuOpen(true)}>
						<DotsIcon />
					</RoundButton>
				) : null}
			</View>
			<ComputerMenu open={menuOpen} trackpad={trackpad} onClose={() => setMenuOpen(false)} onToggleTrackpad={onToggleTrackpad ?? (() => undefined)} />

			{stage ? (
				<View className="flex-1">
					<Zoomable ref={zoomRef} aspectRatio={aspectRatio} mode={!ready ? "off" : controlling ? "control" : "view"} onZoomChange={(scale) => setZoomed(isZoomed(scale))}>
						{source ? <Image source={source} resizeMode="contain" accessibilityLabel={`Tela do computador de ${bot.name}`} style={{ width: "100%", height: "100%" }} /> : children}
					</Zoomable>
					{/* Conectando: o palco (e a WebView dentro dele) já existe, mas fica coberto pela esfera até a primeira imagem. */}
					{ready ? null : (
						<View style={[StyleSheet.absoluteFill, { backgroundColor: SCREEN }]}>
							<Placeholder status="loading" onRetry={onRetry} onStart={onStart} errorText={errorText} />
						</View>
					)}
				</View>
			) : (
				<Placeholder status={status as Exclude<ComputerStatus, "ready">} onRetry={onRetry} onStart={onStart} errorText={errorText} />
			)}

			{ready ? (
				<View style={{ paddingBottom: insets.bottom + 16, paddingHorizontal: SIDE }} className="gap-3">
					{controlling && controlExtra ? controlExtra : null}
					{controlling ? (
						<View className="flex-row items-center justify-between">
							<RoundAction label="Colar texto na VM" onPress={onPaste}>
								<ClipboardPasteIcon />
							</RoundAction>
							{zoomed ? <ResetZoomButton onPress={() => zoomRef.current?.reset()} /> : null}
							<RoundAction label="Abrir o teclado" onPress={onKeyboard}>
								<KeyboardIcon />
							</RoundAction>
						</View>
					) : (
						<View className="flex-row items-center justify-between">
							{zoomed ? <ResetZoomButton onPress={() => zoomRef.current?.reset()} /> : <View />}
							<Pressable role="button" accessibilityLabel="Assumir o controle" onPress={onTakeControl} style={{ height: 46, backgroundColor: PILL_FILL, borderColor: PILL_EDGE }} className="items-center justify-center rounded-full border px-5 active:opacity-70">
								<Text className="text-control font-medium" style={{ color: "#ffffff" }}>
									Assumir o controle
								</Text>
							</Pressable>
						</View>
					)}
				</View>
			) : (
				<View style={{ height: insets.bottom + 16 }} />
			)}
		</KeyboardAvoidingView>
		</ForcedColorScheme>
	);
}
