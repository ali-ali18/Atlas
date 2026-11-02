import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { View } from "react-native";
import { ComputerView } from "@/components/computer/computer-view";
import { TypingInput } from "@/components/computer/typing-input";
import { ViewerWebView, type ViewerHandle } from "@/components/computer/viewer-webview";
import { ActionSheet } from "@/components/ui/action-sheet";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { createTypingController } from "@/lib/computer-typing";
import { KEY_BACKSPACE, KEY_RETURN, clipPasteText, pasteTruncatedNotice, textToKeysyms } from "@/lib/vm-keys";
import { useComputer } from "@/lib/use-computer";
import { useHomeData } from "@/lib/home-data";

const HELP_TEXT = "Pinça com dois dedos para ampliar. Em Assumir o controle, toque e digite como no computador; o bot continua trabalhando enquanto isso.";
const NOTICE_MS = 4_000;

/**
 * Computador do bot (`/computer/<botId>`): a tela da VM em tempo real (noVNC numa WebView) com zoom por pinça.
 * "Assumir o controle" e "Soltar" só alternam o modo NA TELA: não pausam nem avisam o bot, que segue trabalhando.
 */
export default function ComputerScreen() {
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { snapshot } = useHomeData();
	const { apiFetch, serverUrl } = useAtlasSession();
	const bot = snapshot?.bots.find((item) => item.id === id);
	const computer = useComputer({ apiFetch, serverUrl, conversationId: bot?.conversationId ?? null });
	const [controlling, setControlling] = React.useState(false);
	const [keyboardOpen, setKeyboardOpen] = React.useState(false);
	// "Modo trackpad": só o estado e a marca no menu por enquanto (ver docs); o toque ainda vai direto no ponto tocado.
	const [trackpad, setTrackpad] = React.useState(false);
	const [helpOpen, setHelpOpen] = React.useState(false);
	const [notice, setNotice] = React.useState<string | null>(null);
	const noticeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	React.useEffect(() => () => clearTimeout(noticeTimer.current), []);
	// Soltar o controle = sair da tela (voltar, gesto ou botão). Não pausa o bot.
	const goBack = () => {
		release();
		if (router.canGoBack()) router.back();
		else router.replace("/");
	};

	const showNotice = (text: string) => {
		setNotice(text);
		clearTimeout(noticeTimer.current);
		noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
	};
	function release() {
		setControlling(false);
		setKeyboardOpen(false);
		setNotice(null);
	}
	const viewer = React.useRef<ViewerHandle>(null);
	const connected = computer.status === "ready";
	const liveRef = React.useRef({ connected, showNotice });
	liveRef.current = { connected, showNotice };
	// Digita na VM pela página (noVNC): só no modo controle e com a conexão aberta; senão avisa em vez de perder a tecla.
	const typeKeys = (keys: number[]) => {
		if (!liveRef.current.connected || !viewer.current) throw new Error("sem conexão");
		viewer.current.typeKeys(keys);
	};
	// Cola o texto da área de transferência na VM, tecla por tecla (até 2000 caracteres; o resto é cortado com aviso).
	const paste = async () => {
		try {
			const { text, truncated } = clipPasteText(await Clipboard.getStringAsync());
			const keys = textToKeysyms(text);
			if (keys.length === 0) return showNotice("Não há nada para colar.");
			typeKeys(keys);
			if (truncated) showNotice(pasteTruncatedNotice());
			else setNotice(null);
		} catch {
			showNotice("Não foi possível enviar para a VM.");
		}
	};
	// Digitação ao vivo: o teclado do aparelho escreve num campo invisível e cada mudança vai à VM, em ordem.
	const typing = React.useMemo(
		() =>
			createTypingController({
				sendText: async (text) => typeKeys(textToKeysyms(text)),
				sendKey: async (key) => typeKeys([key === "Return" ? KEY_RETURN : KEY_BACKSPACE]),
				onError: () => liveRef.current.showNotice("Não foi possível enviar para a VM."),
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	if (!bot) {
		return (
			<View className="flex-1 items-center justify-center bg-black px-8">
				<Text className="text-center text-control" style={{ color: "#a1a1aa" }}>
					Não encontrei este bot.
				</Text>
			</View>
		);
	}

	const extra = notice ? (
		<Text className="px-2 text-center text-caption" style={{ color: "#fca5a5" }} accessibilityLiveRegion="polite">
			{notice}
		</Text>
	) : null;

	return (
		<>
			<ComputerView
				bot={bot}
				status={computer.status}
				errorText={computer.error}
				controlling={controlling}
				controlExtra={extra}
				onBack={goBack}
				onHelp={() => setHelpOpen(true)}
				onTakeControl={() => setControlling(true)}
				trackpad={trackpad}
				onToggleTrackpad={() => setTrackpad((on) => !on)}
				onPaste={() => void paste()}
				onKeyboard={() => setKeyboardOpen((open) => !open)}
				onRetry={computer.retry}
				onStart={computer.start}
			>
				{computer.mounted && serverUrl ? <ViewerWebView ref={viewer} serverUrl={serverUrl} socketUrl={computer.socketUrl} socketKey={computer.socketKey} controlling={controlling} onEvent={computer.onBridgeEvent} /> : null}
			</ComputerView>
			{controlling && connected ? <TypingInput active={keyboardOpen} controller={typing} onClose={() => setKeyboardOpen(false)} /> : null}
			<ActionSheet
				visible={helpOpen}
				onClose={() => setHelpOpen(false)}
				groups={[]}
				header={
					<View className="gap-1 pb-2">
						<Text variant="heading">Computador do bot</Text>
						<Text variant="muted">{HELP_TEXT}</Text>
					</View>
				}
			/>
		</>
	);
}
