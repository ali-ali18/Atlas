import * as React from "react";
import { Image, View } from "react-native";
import { SvgUri } from "react-native-svg";
import type { LoginConnector } from "@workspace/shared";
import { BadgeCheckIcon } from "@/components/icons";
import { ChatCardBadge } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import type { ChatItem } from "@/lib/chat-types";
import { connectorCanAuthorize, connectorNote, connectorOf, initialOf, isSvgUri, loginOutcome, resolveIconUri } from "@/lib/request-cards";
import type { ConnectResultView } from "@/lib/use-request-actions";
import { useAppColorScheme } from "@/lib/use-theme";
import { RequestButton, RequestShell } from "./request-shell";

type Login = Extract<ChatItem, { kind: "login" }>;

const LOGO = 56;

/** Logo grande do conector (SVG ou imagem); sem logo, ou se ela falhar, a inicial do nome. */
function ConnectorLogo({ connector, serverUrl }: { connector: LoginConnector; serverUrl: string | null }) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	const uri = resolveIconUri(connector.icon, serverUrl);
	const [failed, setFailed] = React.useState<string | null>(null);
	const inner = Math.round(LOGO * 0.58);
	return (
		<View className="items-center justify-center rounded-2xl" style={{ width: LOGO, height: LOGO, backgroundColor: chrome.control }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
			{uri && failed !== uri ? (
				isSvgUri(uri) ? (
					<SvgUri uri={uri} width={inner} height={inner} onError={() => setFailed(uri)} />
				) : (
					<Image source={{ uri }} style={{ width: inner, height: inner }} resizeMode="contain" accessibilityIgnoresInvertColors onError={() => setFailed(uri)} />
				)
			) : (
				<Text className="text-2xl font-semibold text-muted-foreground">{initialOf(connector.name)}</Text>
			)}
		</View>
	);
}

/**
 * Pedido de "conectar app" do run. "Autorizar" conecta pelo navegador (o mesmo fluxo da tela Aplicativos: abre o login
 * do provedor e confere a conexão a cada segundo); ao conectar, retoma o run como o "Terminei" do web. Resolvido ou
 * recarregado: o selo "Conectado" no lugar do botão. Nunca recebe credencial.
 */
export function ConnectorCard({ item, botName, serverUrl, onConnect, onDone, onOpenWeb }: { item: Login; botName: string; serverUrl: string | null; onConnect: (connector: LoginConnector, signal: { aborted: boolean }) => Promise<ConnectResultView>; onDone: (item: Login) => void; onOpenWeb: () => void }) {
	const connector = connectorOf(item);
	const [busy, setBusy] = React.useState(false);
	const [message, setMessage] = React.useState<string | null>(null);
	const signal = React.useRef({ aborted: false });
	React.useEffect(() => {
		signal.current.aborted = false;
		const current = signal.current;
		return () => {
			current.aborted = true;
		};
	}, []);
	if (!connector) return null;
	const outcome = loginOutcome(item);
	const native = connector.kind === "native";
	const canAuthorize = connectorCanAuthorize(connector);

	const authorize = async () => {
		if (busy) return;
		setBusy(true);
		setMessage(null);
		const result = await onConnect(connector, signal.current);
		if (signal.current.aborted) return;
		setBusy(false);
		if ("error" in result) setMessage(result.error);
		else if (result.outcome === "connected") onDone(item);
		else if (result.outcome === "closed" || result.outcome === "timeout") setMessage("Não consegui confirmar a conexão. Toque em Autorizar para tentar de novo.");
	};

	return (
		<RequestShell note={connectorNote(botName)} accessibilityLabel={`Conectar ${connector.name}`}>
			<View className="flex-row items-center gap-3">
				<ConnectorLogo connector={connector} serverUrl={serverUrl} />
				<View className="min-w-0 flex-1 gap-0.5">
					<View className="flex-row items-center gap-1.5">
						<Text className="min-w-0 shrink text-base font-semibold" numberOfLines={1}>
							{connector.name}
						</Text>
						{native ? <BadgeCheckIcon size={16} /> : null}
					</View>
					<Text variant="muted" className="text-body" numberOfLines={2}>
						{connector.description || "Deixe o bot usar este aplicativo."}
					</Text>
				</View>
				{outcome ? (
					<ChatCardBadge tone={outcome.tone} label={outcome.label} />
				) : canAuthorize ? (
					<RequestButton label="Autorizar" busy={busy} onPress={() => void authorize()} />
				) : (
					<RequestButton label="Abrir no navegador" variant="secondary" onPress={onOpenWeb} />
				)}
			</View>
			{message ? (
				<Text variant="error" className="text-body" role="alert">
					{message}
				</Text>
			) : null}
		</RequestShell>
	);
}
