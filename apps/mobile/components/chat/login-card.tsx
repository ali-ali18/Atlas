import * as React from "react";
import { Pressable, TextInput, View } from "react-native";
import { EyeIcon, EyeOffIcon, GlobeIcon, ShieldCheckIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";
import type { ResumeOptions } from "@/lib/chat-api";
import { chatChrome, routineSurface } from "@/lib/chat-surface";
import type { ChatItem } from "@/lib/chat-types";
import { cleanLoginCode, concludeAction, drawerFields, drawerSave, loginOutcome, siteDomains, siteName } from "@/lib/request-cards";
import { themeColor } from "@/lib/theme";
import type { ActionResult } from "@/lib/use-request-actions";
import { useAppColorScheme } from "@/lib/use-theme";
import { RequestButton, RequestShell } from "./request-shell";

type Login = Extract<ChatItem, { kind: "login" }>;

/** Campo da gaveta: mesmo fundo dos controles do chat. Senha com olho para mostrar/ocultar. */
function SheetField({ label, secure = false, ...props }: { label: string; secure?: boolean } & React.ComponentProps<typeof TextInput>) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	const [shown, setShown] = React.useState(false);
	return (
		<View className="gap-1.5">
			<Text variant="muted" className="px-1 text-body font-medium">
				{label}
			</Text>
			<View className="h-12 flex-row items-center rounded-2xl px-4" style={{ backgroundColor: chrome.control }}>
				<TextInput
					accessibilityLabel={label}
					placeholderTextColor={themeColor(scheme, "muted-foreground")}
					secureTextEntry={secure && !shown}
					autoCapitalize="none"
					autoCorrect={false}
					spellCheck={false}
					className="min-w-0 flex-1 text-control text-foreground"
					{...props}
				/>
				{secure ? (
					<Pressable role="button" accessibilityLabel={shown ? "Ocultar senha" : "Mostrar senha"} onPress={() => setShown((value) => !value)} hitSlop={8} className="pl-2 active:opacity-60">
						{shown ? <EyeOffIcon /> : <EyeIcon />}
					</Pressable>
				) : null}
			</View>
		</View>
	);
}

/**
 * Gaveta do login (Cancelar · Entrar no {site} · Concluído). Só oferece o que o contrato aceita:
 * - código (`codeField`): vai selado ao runtime pelo "retomar" (nunca ao modelo);
 * - login do Cofre que já casa com o site: "Entrar" retoma usando o cofre, sem digitar nada;
 * - sem login no Cofre: usuário e senha do site são guardados no Cofre (`POST /v1/vault`) para as próximas vezes;
 * - "Abrir a tela" abre o computador do bot (hoje, o web) para entrar à mão; "Concluído" retoma o run.
 * Usuário, senha e código ficam só nos campos desta gaveta e somem ao fechar.
 */
function LoginSheet({ item, botName, visible, onClose, onResume, onSaveLogin, onOpenScreen }: { item: Login; botName: string; visible: boolean; onClose: () => void; onResume: (options: ResumeOptions) => void; onSaveLogin: (username: string, password: string) => Promise<ActionResult>; onOpenScreen: () => void }) {
	const scheme = useAppColorScheme();
	const chrome = chatChrome(scheme);
	const blue = routineSurface(scheme).link;
	const fields = drawerFields(item);
	const [code, setCode] = React.useState("");
	const [username, setUsername] = React.useState("");
	const [password, setPassword] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	// Guardado no Cofre nesta gaveta: o Salvar fica desativado (não guarda duas vezes) até mexer nos campos.
	const [saved, setSaved] = React.useState(false);
	const [feedback, setFeedback] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const site = siteName(item);
	const domains = siteDomains(item).join(", ");
	const save = drawerSave(fields, { code, username, password });
	const edit = (set: (value: string) => void) => (value: string) => {
		set(value);
		setSaved(false);
	};

	const close = () => {
		setCode("");
		setUsername("");
		setPassword("");
		setFeedback(null);
		setSaved(false);
		onClose();
	};
	const resume = (options: ResumeOptions) => {
		close();
		onResume(options);
	};
	// Guarda usuário e senha no Cofre; `true` se deu certo. A senha sai do estado na hora.
	const storeLogin = async (): Promise<boolean> => {
		setBusy(true);
		setFeedback(null);
		const result = await onSaveLogin(username, password);
		setBusy(false);
		if (!result.ok) {
			setFeedback({ tone: "error", text: result.error });
			return false;
		}
		setUsername("");
		setPassword("");
		setSaved(true);
		setFeedback({ tone: "ok", text: "Salvo no Cofre. Da próxima vez eu entro sozinho." });
		return true;
	};
	const conclude = async () => {
		if (busy) return;
		const action = concludeAction(fields, { code, username, password });
		if (action.kind === "block") return setFeedback({ tone: "error", text: action.message });
		if (action.kind === "save-then-resume" && !(await storeLogin())) return;
		resume(action.kind === "resume" ? action.options : {});
	};
	const submit = async () => {
		if (!save.enabled || busy || saved) return;
		if (save.kind === "vault") return resume({ via: "vault" });
		if (save.kind === "code") return resume({ via: "code", code: cleanLoginCode(code) });
		if (save.kind !== "credentials") return;
		await storeLogin();
	};
	const saveLabel = save.kind === "vault" ? "Entrar" : saved ? "Salvo no Cofre" : "Salvar";
	const saveOff = !save.enabled || busy || saved;

	return (
		<DraggableSheet
			visible={visible}
			onClose={close}
			backgroundColor={chrome.fill}
			header={
				<View className="min-h-11 flex-row items-center gap-2">
					<View className="min-w-24 items-start">
						<Button size="sm" variant="secondary" accessibilityLabel="Cancelar" onPress={close}>
							<Text>Cancelar</Text>
						</Button>
					</View>
					<Text className="min-w-0 flex-1 text-center text-base font-semibold" numberOfLines={1}>
						Entrar no {site}
					</Text>
					<View className="min-w-24 items-end">
						{/* Mesmo azul preenchido do Salvar; mesma altura do Cancelar. */}
						<Pressable role="button" accessibilityLabel="Concluído" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void conclude()} style={{ backgroundColor: blue }} className="h-9 flex-row items-center justify-center rounded-full px-4 active:opacity-80">
							<Text className="text-control font-semibold" style={{ color: themeColor(scheme, scheme === "dark" ? "foreground" : "info-foreground") }}>
								Concluído
							</Text>
						</Pressable>
					</View>
				</View>
			}
		>
			{fields.captcha ? (
				<Text variant="muted" className="text-control">
					O site pediu uma verificação para confirmar que é você. Abra a tela, resolva e toque em Concluído.
				</Text>
			) : null}
			{fields.vault ? (
				<View className="gap-1 rounded-2xl p-4" style={{ backgroundColor: chrome.control }}>
					<Text className="text-control font-semibold">{fields.vault.label || fields.vault.name}</Text>
					<Text variant="muted" className="text-body">
						{fields.vault.username ? `${fields.vault.username} · ` : ""}
						{fields.vault.emailCode ? `Busco o código no ${fields.vault.emailCode}.` : "Já está guardado no seu Cofre."}
					</Text>
				</View>
			) : null}
			{item.vaultTried ? (
				<Text variant="muted" className="text-control">
					O login do Cofre já foi usado e o site pediu mais um passo. Abra a tela para terminar.
				</Text>
			) : null}
			{fields.code ? <SheetField label="Código recebido" value={code} onChangeText={edit(setCode)} placeholder="000000" keyboardType="number-pad" maxLength={12} autoComplete="one-time-code" textContentType="oneTimeCode" /> : null}
			{fields.credentials ? (
				<>
					<SheetField label="Email ou usuário" value={username} onChangeText={edit(setUsername)} autoComplete="username" textContentType="username" keyboardType="email-address" />
					<SheetField label="Senha" secure value={password} onChangeText={edit(setPassword)} autoComplete="current-password" textContentType="password" />
					<View className="flex-row items-start gap-1.5 px-1">
						<View className="pt-px">
							<ShieldCheckIcon size={14} />
						</View>
						<Text variant="caption" className="min-w-0 flex-1 text-caption">
							Preenchido apenas em {domains}. Nunca é mostrado ao {botName}.
						</Text>
					</View>
				</>
			) : null}
			{feedback ? (
				<Text variant={feedback.tone === "error" ? "error" : "muted"} className="px-1 text-body" role={feedback.tone === "error" ? "alert" : undefined}>
					{feedback.text}
				</Text>
			) : null}
			<View className="gap-2.5">
				{save.kind !== "none" ? (
					<Pressable role="button" accessibilityLabel={saveLabel} accessibilityState={{ disabled: saveOff, busy }} disabled={saveOff} onPress={() => void submit()} style={{ backgroundColor: blue, opacity: saveOff && !busy ? 0.4 : 1 }} className="h-12 items-center justify-center rounded-full active:opacity-80">
						<Text className="text-control font-semibold" style={{ color: themeColor(scheme, scheme === "dark" ? "foreground" : "info-foreground") }}>
							{busy ? "Salvando…" : saveLabel}
						</Text>
					</Pressable>
				) : null}
				<Pressable role="button" accessibilityLabel="Abrir a tela" onPress={onOpenScreen} style={{ backgroundColor: chrome.control }} className="h-12 items-center justify-center rounded-full active:opacity-80">
					<Text className="text-control font-semibold">Abrir a tela</Text>
				</Pressable>
			</View>
		</DraggableSheet>
	);
}

/**
 * Login de página (sem conector): cartão "Formulário" com o site e "Continuar", que abre a gaveta. Nunca carrega
 * credencial. Resolvido: um selo com o desfecho no lugar do botão.
 */
export function LoginCard({ item, botName, onResume, onSaveLogin, onOpenScreen, initialOpen = false }: { item: Login; botName: string; onResume: (item: Login, options: ResumeOptions) => void; onSaveLogin: (item: Login, username: string, password: string) => Promise<ActionResult>; onOpenScreen: () => void; initialOpen?: boolean }) {
	const [open, setOpen] = React.useState(initialOpen);
	const captcha = item.reason === "captcha";
	const site = siteName(item);
	const outcome = loginOutcome(item);
	const domains = siteDomains(item).join(", ");
	return (
		<>
			<RequestShell icon={<GlobeIcon />} label={captcha ? "Verificação" : "Formulário"} badge={outcome ?? undefined} groupLabel={`Entrar no ${site}`}>
				<View className="gap-1">
					<Text className="text-base font-semibold">{captcha ? `Verificação em ${site}` : `Entrar no ${site}`}</Text>
					<Text variant="muted" className="text-body">
						{captcha ? "O site pediu uma verificação para confirmar que é você." : `Nunca é mostrado ao seu Bot. Preenchido apenas em ${domains}.`}
					</Text>
				</View>
				{outcome ? null : (
					<View className="flex-row justify-end">
						<RequestButton label="Continuar" onPress={() => setOpen(true)} />
					</View>
				)}
			</RequestShell>
			{outcome ? null : <LoginSheet item={item} botName={botName} visible={open} onClose={() => setOpen(false)} onResume={(options) => onResume(item, options)} onSaveLogin={(username, password) => onSaveLogin(item, username, password)} onOpenScreen={onOpenScreen} />}
		</>
	);
}
