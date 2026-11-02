import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { View } from "react-native";
import { ComputerView } from "@/components/computer/computer-view";
import { KeyboardBar } from "@/components/computer/keyboard-bar";
import { ViewerWebView } from "@/components/computer/viewer-webview";
import { ActionSheet } from "@/components/ui/action-sheet";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { computerErrorText, sendKey, sendText, type ComputerKey } from "@/lib/computer-api";
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
	const [busy, setBusy] = React.useState(false);
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
	// Envia e devolve se deu certo (a barra só limpa o campo no sucesso).
	const send = async (run: () => Promise<void>): Promise<boolean> => {
		if (busy) return false;
		setBusy(true);
		setNotice(null);
		try {
			await run();
			return true;
		} catch (error) {
			showNotice(computerErrorText(error));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const sessionId = computer.sessionId;
	const paste = async () => {
		if (!sessionId) return;
		let text = "";
		try {
			text = await Clipboard.getStringAsync();
		} catch {
			return showNotice("Não foi possível enviar para a VM.");
		}
		await send(() => sendText(apiFetch, sessionId, text));
	};

	if (!bot) {
		return (
			<View className="flex-1 items-center justify-center bg-black px-8">
				<Text className="text-center text-control" style={{ color: "#a1a1aa" }}>
					Não encontrei este bot.
				</Text>
			</View>
		);
	}

	const extra =
		sessionId && (keyboardOpen || notice) ? (
			<View className="gap-2">
				{keyboardOpen ? <KeyboardBar busy={busy} error={notice} onSend={(text) => send(() => sendText(apiFetch, sessionId, text))} onKey={(key: ComputerKey) => void send(() => sendKey(apiFetch, sessionId, key))} /> : null}
				{!keyboardOpen && notice ? (
					<Text className="px-2 text-center text-caption" style={{ color: "#fca5a5" }} accessibilityLiveRegion="polite">
						{notice}
					</Text>
				) : null}
			</View>
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
				{computer.uri ? <ViewerWebView uri={computer.uri} reloadKey={computer.linkKey} controlling={controlling} onDrop={computer.reportDrop} /> : null}
			</ComputerView>
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
