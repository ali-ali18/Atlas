import * as React from "react";
import * as Linking from "expo-linking";
import { View } from "react-native";
import { AtSignIcon, GoogleIcon } from "@/components/icons";
import { AuthColumn, AuthDivider, AuthHeader } from "@/components/auth-layout";
import { Screen } from "@/components/screen";
import { SharedProof } from "@/components/shared-proof";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import {
	CODE_LENGTH,
	canResend,
	friendlyAuthError,
	initialLoginState,
	isCodeComplete,
	loginReducer,
	resendSecondsLeft,
} from "@/lib/login-flow";
import { checkServer } from "@/lib/server-check";
import type { BridgeOutcome } from "@/lib/google-bridge";
import { createGoogleLogin } from "@/lib/google-login";

// Textos de apps/web/lib/i18n/messages/pt-BR/login.ts (login.title, subtitle, google, or, emailLabel,
// emailPlaceholder). Aqui o e-mail recebe um código de 6 números em vez de um link, porque o link do e-mail
// abre no navegador e não volta para o app dentro do Expo Go.
export default function LoginScreen() {
	const { client, serverUrl, changeServer, markSignedIn } = useAtlasSession();
	const [state, dispatch] = React.useReducer(loginReducer, initialLoginState);
	const [googleAvailable, setGoogleAvailable] = React.useState(false);
	const [now, setNow] = React.useState(() => Date.now());
	const busy = state.busy !== null;

	// O botão do Google só aparece se o servidor oferece o provedor (GET /api/auth/providers).
	React.useEffect(() => {
		if (!serverUrl) return;
		let cancelled = false;
		void checkServer(serverUrl).then((result) => {
			if (!cancelled) setGoogleAvailable(result.ok && result.providers.google);
		});
		return () => {
			cancelled = true;
		};
	}, [serverUrl]);

	React.useEffect(() => {
		if (state.step !== "code") return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [state.step]);

	const sendCode = React.useCallback(
		async (email: string) => {
			if (!client) return;
			try {
				const result = await client.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
				if (result.error) dispatch({ type: "sendFailed", message: friendlyAuthError(result.error, "send") });
				else dispatch({ type: "sendSucceeded", now: Date.now() });
			} catch {
				dispatch({ type: "sendFailed", message: friendlyAuthError(null, "send") });
			}
		},
		[client],
	);

	function submitEmail() {
		if (busy) return;
		const next = loginReducer(state, { type: "sendRequested" });
		dispatch({ type: "sendRequested" });
		if (next.busy === "send") void sendCode(next.email);
	}

	function resend() {
		if (!canResend(state, Date.now())) return;
		dispatch({ type: "sendRequested" });
		// `sendRequested` só vale no passo do e-mail; no passo do código pedimos direto e mantemos a tela.
		void sendCode(state.email);
	}

	const verify = React.useCallback(
		async (email: string, code: string) => {
			if (!client) return;
			dispatch({ type: "verifyRequested" });
			try {
				const result = await client.signIn.emailOtp({ email, otp: code });
				if (result.error) dispatch({ type: "verifyFailed", message: friendlyAuthError(result.error, "verify") });
				else markSignedIn();
			} catch {
				dispatch({ type: "verifyFailed", message: friendlyAuthError(null, "verify") });
			}
		},
		[client, markSignedIn],
	);

	// Com os 6 números digitados (ou colados) entra sozinho, sem exigir o toque no botão.
	React.useEffect(() => {
		if (state.step === "code" && state.busy === null && isCodeComplete(state.code)) void verify(state.email, state.code);
	}, [state.step, state.busy, state.code, state.email, verify]);

	// Login com Google pela ponte do servidor (lib/google-bridge.ts). Null quando o retorno não é um deep link do app
	// (prévia no navegador): o botão avisa em vez de abrir um login que não volta.
	const googleLogin = React.useMemo(() => {
		if (!client || !serverUrl) return null;
		try {
			return createGoogleLogin(client, serverUrl);
		} catch {
			return null;
		}
	}, [client, serverUrl]);

	const finishGoogle = React.useCallback(
		(outcome: BridgeOutcome) => {
			if (outcome === "ignored") return;
			if (outcome === "signed-in") markSignedIn();
			dispatch({ type: "googleFinished", message: outcome === "failed" ? friendlyAuthError(null, "google") : null });
		},
		[markSignedIn],
	);

	// O link de volta chega pelo resultado do navegador e, no Expo Go, às vezes só pelo listener (ou reabrindo o app):
	// os três caminhos passam por `handleLink`, que usa cada tentativa uma vez só.
	React.useEffect(() => {
		if (!googleLogin) return;
		let active = true;
		const apply = (outcome: BridgeOutcome) => {
			if (active) finishGoogle(outcome);
		};
		void Linking.getInitialURL()
			.then((url) => (url ? googleLogin.handleLink(url) : "ignored"))
			.then(apply, () => undefined);
		const subscription = Linking.addEventListener("url", ({ url }) => void googleLogin.handleLink(url).then(apply, () => apply("failed")));
		return () => {
			active = false;
			subscription.remove();
		};
	}, [googleLogin, finishGoogle]);

	async function google() {
		if (busy) return;
		dispatch({ type: "googleRequested" });
		if (!googleLogin) return finishGoogle("failed");
		finishGoogle(await googleLogin.begin().catch((): BridgeOutcome => "failed"));
	}

	const resendLeft = resendSecondsLeft(state, now);
	const inCode = state.step === "code";

	return (
		<Screen className="justify-center">
			<AuthColumn>
				<AuthHeader
					title={inCode ? "Confira o seu e-mail" : "Entrar no Atlas"}
					subtitle={inCode ? `Enviamos um código de ${CODE_LENGTH} números para ${state.email}.` : "Seu agente pessoal no seu servidor."}
				/>
				{inCode ? (
					<View className="gap-3">
						<InputOTP
							value={state.code}
							onChange={(value) => dispatch({ type: "codeChanged", value })}
							maxLength={CODE_LENGTH}
							editable={!busy}
							invalid={Boolean(state.error)}
							autoFocus
							accessibilityLabel="Código de 6 números"
						>
							<InputOTPGroup>
								<InputOTPSlot index={0} />
								<InputOTPSlot index={1} />
								<InputOTPSlot index={2} />
							</InputOTPGroup>
							<InputOTPSeparator />
							<InputOTPGroup>
								<InputOTPSlot index={3} />
								<InputOTPSlot index={4} />
								<InputOTPSlot index={5} />
							</InputOTPGroup>
						</InputOTP>
						<Button size="lg" className="w-full" onPress={() => void verify(state.email, state.code)} disabled={busy || !isCodeComplete(state.code)}>
							{state.busy === "verify" ? <Spinner tone="primary-foreground" /> : null}
							<Text>{state.busy === "verify" ? "Entrando…" : "Entrar"}</Text>
						</Button>
						<View className="flex-row items-center justify-center gap-2">
							<Button variant="ghost" size="sm" onPress={resend} disabled={busy || resendLeft > 0}>
								<Text>{resendLeft > 0 ? `Reenviar em ${resendLeft}s` : "Reenviar"}</Text>
							</Button>
							<Button variant="ghost" size="sm" onPress={() => dispatch({ type: "changeEmail" })} disabled={busy}>
								<Text>Trocar e-mail</Text>
							</Button>
						</View>
					</View>
				) : (
					<>
						{googleAvailable ? (
							<>
								<View className="gap-3">
									<Button size="lg" variant="outline" className="w-full" onPress={google} disabled={busy}>
										{state.busy === "google" ? <Spinner tone="foreground" /> : <GoogleIcon />}
										<Text>Continuar com Google</Text>
									</Button>
								</View>
								<AuthDivider>ou</AuthDivider>
							</>
						) : null}
						<View className="gap-3">
							<InputGroup invalid={Boolean(state.error)}>
								<InputGroupAddon>
									<AtSignIcon />
								</InputGroupAddon>
								<InputGroupInput
									value={state.email}
									onChangeText={(value) => dispatch({ type: "emailChanged", value })}
									accessibilityLabel="E-mail"
									placeholder="voce@exemplo.com"
									autoCapitalize="none"
									autoCorrect={false}
									keyboardType="email-address"
									inputMode="email"
									textContentType="emailAddress"
									autoComplete="email"
									returnKeyType="send"
									onSubmitEditing={submitEmail}
									editable={!busy}
								/>
							</InputGroup>
							<Button size="lg" className="w-full" onPress={submitEmail} disabled={busy || !state.email.trim()}>
								{state.busy === "send" ? <Spinner tone="primary-foreground" /> : null}
								<Text>{state.busy === "send" ? "Enviando…" : "Enviar código"}</Text>
							</Button>
						</View>
					</>
				)}
				{state.error ? (
					<Text accessibilityRole="alert" variant="error" className="text-center text-sm">
						{state.error}
					</Text>
				) : null}
				{/* Só no passo do e-mail: no passo do código ficam "Reenviar" e "Trocar e-mail". */}
				{inCode ? null : (
					<Button variant="ghost" size="sm" className="self-center" onPress={() => void changeServer()} disabled={busy}>
						<Text>Trocar servidor</Text>
					</Button>
				)}
				{/* Só em desenvolvimento: prova do shared da etapa 0, não é para o usuário. */}
				{__DEV__ ? <SharedProof /> : null}
			</AuthColumn>
		</Screen>
	);
}
