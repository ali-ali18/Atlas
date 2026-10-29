"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeftIcon, BoxesIcon, CheckIcon, PlusIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { DEFAULT_COMMAND_ALLOWLIST, DEFAULT_DEV_APPROVAL_MODE, DEFAULT_EGRESS_ALLOWLIST, DEV_VERIFIER_HINT, DEV_VERIFIER_LABEL, normalizeEnvRepo, parseEnvPaste, type DevApprovalMode } from "@workspace/shared";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";
import { Button } from "@workspace/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@workspace/ui/components/sheet";
import { Switch } from "@workspace/ui/components/switch";
import { Textarea } from "@workspace/ui/components/textarea";
import { useIsMobile } from "@workspace/ui/hooks/use-mobile";
import { cn } from "@workspace/ui/lib/utils";
import { SettingsPicker } from "@/components/ui/templates/template-4/settings-picker";
import { useDevEnvironments } from "@/hooks/use-dev-environments";
import { detectDevEnvironmentFromRepo, listGithubRepos, type DevEnvironmentView, type GithubRepoOption } from "@/lib/atlas-api";
import { SettingRow, SettingsGroup } from "../setting-row";
import {
	ACCOUNT_APPROVAL_OPTIONS,
	EMPTY_DEV_ENV_FORM,
	addCommandPrefixes,
	approvalHelp,
	approvalOptions,
	showsCommandAllowlist,
	NETWORK_HELP,
	NETWORK_OPTIONS,
	SECRETS_HELP,
	TEST_COMMAND_HELP,
	TIER_OPTIONS,
	addDomains,
	applySuggestion,
	analyzeSecretsText,
	savedSecretsLabel,
	secretLimitError,
	type SuggestionTouched,
	envSummary,
	envErrorMessage,
	formFromEnvironment,
	isEnvFormDirty,
	suggestRepos,
	validateEnvForm,
	type DevEnvForm,
	type DevEnvFormErrors,
} from "../dev-environments-state";

const LABEL_CLASS = "text-body leading-[18px] font-medium";
const HELP_CLASS = "text-xs leading-4 text-muted-foreground";
const CODE_CLASS = "min-h-[4.5rem] font-mono text-body leading-5";

function Field({ label, htmlFor, help, error, children }: { label: string; htmlFor?: string; help?: ReactNode; error?: string; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<label className={LABEL_CLASS} htmlFor={htmlFor}>
				{label}
			</label>
			{children}
			{error ? (
				<p className="text-xs text-destructive" role="alert">
					{error}
				</p>
			) : help ? (
				<p className={HELP_CLASS}>{help}</p>
			) : null}
		</div>
	);
}

function Chip({ children, onRemove, label }: { children: ReactNode; onRemove?: () => void; label?: string }) {
	return (
		<span className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-muted px-2.5 font-mono text-caption text-foreground">
			<span className="truncate">{children}</span>
			{onRemove ? (
				<button
					aria-label={label}
					className="-mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={onRemove}
					type="button"
				>
					<XIcon aria-hidden className="size-3" />
				</button>
			) : null}
		</span>
	);
}

function DomainsEditor({ domains, onChange }: { domains: string[]; onChange: (domains: string[]) => void }) {
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [showDefaults, setShowDefaults] = useState(false);
	const id = useId();
	function add() {
		if (!text.trim()) return;
		const result = addDomains(domains, text);
		onChange(result.domains);
		setError(result.error);
		if (!result.error) setText("");
	}
	return (
		<div className="flex min-w-0 flex-col gap-2" data-slot="dev-env-domains">
			<div className="flex items-center gap-2">
				<Input
					aria-label="Adicionar domínio liberado"
					autoComplete="off"
					className="font-mono text-body"
					id={id}
					onChange={(event) => {
						setText(event.target.value);
						setError(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}}
					placeholder="registro.empresa.com"
					spellCheck={false}
					value={text}
				/>
				<Button disabled={!text.trim()} onClick={add} size="sm" type="button" variant="outline">
					Adicionar
				</Button>
			</div>
			{error ? (
				<p className="text-xs text-destructive" role="alert">
					{error}
				</p>
			) : null}
			{domains.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{domains.map((domain) => (
						<Chip key={domain} label={`Remover ${domain}`} onRemove={() => onChange(domains.filter((item) => item !== domain))}>
							{domain}
						</Chip>
					))}
				</div>
			) : null}
			<button
				aria-expanded={showDefaults}
				className="w-fit text-xs text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
				onClick={() => setShowDefaults((open) => !open)}
				type="button"
			>
				{showDefaults ? "Ocultar" : "Ver"} os {DEFAULT_EGRESS_ALLOWLIST.length} domínios padrão
			</button>
			{showDefaults ? (
				<div className="flex flex-wrap gap-1.5 opacity-80">
					{DEFAULT_EGRESS_ALLOWLIST.map((domain) => (
						<Chip key={domain}>{domain}</Chip>
					))}
				</div>
			) : null}
		</div>
	);
}

/** Página cheia do celular (cabeçalho com voltar, conteúdo rolável, ação principal embaixo com área segura). */
export function MobilePage({ title, onBack, footer, children, level = 1 }: { title: string; onBack: () => void; footer?: ReactNode; children: ReactNode; level?: number }) {
	return (
		<div className="fixed inset-0 flex flex-col bg-background" data-level={level} data-slot="dev-env-mobile-page" style={{ zIndex: 50 + level }}>
			<header className="grid shrink-0 grid-cols-[3rem_1fr_3rem] items-center px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
				<button aria-label="Voltar" className="flex size-11 items-center justify-center rounded-full text-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30" onClick={onBack} type="button">
					<ArrowLeftIcon aria-hidden className="size-6" />
				</button>
				<h2 className="m-0 truncate text-center font-heading text-base font-semibold">{title}</h2>
				<span />
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-4">{children}</div>
			{footer ? <div className="shrink-0 border-t border-border/60 bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div> : null}
		</div>
	);
}

/** Selo discreto dos ambientes criados pela detecção automática. */
export function AutoTag() {
	return (
		<span className="ml-2 inline-flex h-5 items-center rounded-full bg-muted px-2 text-caption text-muted-foreground" data-slot="dev-env-auto-tag">
			detectado automaticamente
		</span>
	);
}

/** Linha compacta de uma lista longa: rótulo, resumo e "Editar" (a lista completa abre numa folha). */
export function ListSummaryRow({ label, summary, onEdit }: { label: string; summary: string; onEdit: () => void }) {
	return (
		<div className="flex min-h-9 items-center gap-2 rounded-3xl bg-input/50 pr-1 pl-3 text-sm" data-slot="dev-env-list-row">
			<span className="min-w-0 flex-1 truncate">
				{label}
				<span className="text-muted-foreground"> · {summary}</span>
			</span>
			<Button onClick={onEdit} size="sm" type="button" variant="ghost">
				Editar
			</Button>
		</div>
	);
}

function ListSheet({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode }) {
	return (
		<Sheet onOpenChange={onOpenChange} open={open}>
			<SheetContent className="gap-0 sm:max-w-md" data-slot="dev-env-list-sheet" side="right">
				<SheetHeader>
					<SheetTitle>{title}</SheetTitle>
					<SheetDescription>{description}</SheetDescription>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
			</SheetContent>
		</Sheet>
	);
}

export function CommandsEditor({ commands, onChange }: { commands: string[]; onChange: (commands: string[]) => void }) {
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	function add() {
		if (!text.trim()) return;
		const result = addCommandPrefixes(commands, text);
		onChange(result.list);
		setError(result.error);
		if (!result.error) setText("");
	}
	const isDefault = commands.length === DEFAULT_COMMAND_ALLOWLIST.length && DEFAULT_COMMAND_ALLOWLIST.every((item) => commands.includes(item));
	return (
		<div className="flex min-w-0 flex-col gap-2" data-slot="dev-env-commands">
			<div className="flex items-center gap-2">
				<Input
					aria-label="Adicionar comando liberado"
					autoComplete="off"
					className="font-mono text-body"
					onChange={(event) => {
						setText(event.target.value);
						setError(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}}
					placeholder="make build"
					spellCheck={false}
					value={text}
				/>
				<Button disabled={!text.trim()} onClick={add} size="sm" type="button" variant="outline">
					Adicionar
				</Button>
			</div>
			{error ? (
				<p className="text-xs text-destructive" role="alert">
					{error}
				</p>
			) : null}
			{commands.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{commands.map((command) => (
						<Chip key={command} label={`Remover ${command}`} onRemove={() => onChange(commands.filter((item) => item !== command))}>
							{command}
						</Chip>
					))}
				</div>
			) : null}
			{!isDefault ? (
				<button
					className="w-fit text-xs text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
					onClick={() => onChange([...DEFAULT_COMMAND_ALLOWLIST])}
					type="button"
				>
					Restaurar os padrões
				</button>
			) : null}
		</div>
	);
}

const MAX_IMPORT_BYTES = 64 * 1024;
const SECRETS_PLACEHOLDER = ["API_KEY=...", "DATABASE_URL=..."].join(String.fromCharCode(10));

/**
 * Segredos: um textarea monoespaçado para colar/digitar "CHAVE=valor" por linha
 * (formato .env). Os já salvos aparecem por nome ("definido"); valores nunca voltam.
 */
export function SecretsEditor({
	existing,
	text,
	onTextChange,
	errors,
	savedCount,
	available,
	onRemoveExisting,
	busyName,
}: {
	existing: DevEnvironmentView["secrets"];
	text: string;
	onTextChange: (text: string) => void;
	/** Erros por linha, mostrados depois de tentar salvar. */
	errors: string[];
	/** Quantos segredos acabaram de ser salvos (null = nenhum aviso). */
	savedCount: number | null;
	available: boolean;
	onRemoveExisting?: (name: string) => void;
	busyName: string | null;
}) {
	const [importError, setImportError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const existingNames = existing.map((secret) => secret.name);
	const overwrites = [...new Set(analyzeSecretsText(text, existingNames).overwrites)];
	const textareaId = useId();

	function importFile(file: File | undefined) {
		if (!file) return;
		setImportError(null);
		if (file.size > MAX_IMPORT_BYTES) {
			setImportError("O arquivo é grande demais para um .env (máximo 64 KB).");
			return;
		}
		void file.text().then((content) => {
			const sep = text && !text.endsWith(String.fromCharCode(10)) ? String.fromCharCode(10) : "";
			onTextChange(`${text}${sep}${content}`);
		});
	}

	return (
		<div className="flex min-w-0 flex-col gap-2" data-slot="dev-env-secrets">
			{existing.length > 0 ? (
				<ul className="flex flex-col gap-1">
					{existing.map((secret) => (
						<li className="flex min-h-9 items-center gap-2 rounded-2xl bg-muted/40 px-3 text-body" key={secret.name}>
							<span className="min-w-0 flex-1 truncate font-mono">{secret.name}</span>
							<span className="flex items-center gap-1 text-xs text-muted-foreground">
								<CheckIcon aria-hidden className="size-3.5" />
								definido
							</span>
							{onRemoveExisting ? (
								<Button
									aria-label={`Apagar o segredo ${secret.name}`}
									disabled={busyName === secret.name}
									onClick={() => onRemoveExisting(secret.name)}
									size="icon-xs"
									type="button"
									variant="ghost"
								>
									<XIcon aria-hidden />
								</Button>
							) : null}
						</li>
					))}
				</ul>
			) : null}
			{available ? (
				<>
					<Textarea
						aria-invalid={errors.length > 0 ? true : undefined}
						aria-label="Segredos (CHAVE=valor, um por linha)"
						autoCapitalize="off"
						autoComplete="off"
						className="min-h-[7rem] font-mono text-body leading-5"
						id={textareaId}
						onChange={(event) => onTextChange(event.target.value)}
						placeholder={SECRETS_PLACEHOLDER}
						rows={5}
						spellCheck={false}
						value={text}
					/>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
						<button
							className="w-fit text-xs text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
							onClick={() => fileRef.current?.click()}
							type="button"
						>
							Importar .env
						</button>
						<input
							accept=".env,text/plain,application/octet-stream"
							aria-label="Arquivo .env"
							className="hidden"
							onChange={(event) => {
								importFile(event.target.files?.[0]);
								event.target.value = "";
							}}
							ref={fileRef}
							type="file"
						/>
					</div>
					{errors.length > 0 || importError ? (
						<div className="flex flex-col gap-0.5" data-slot="dev-env-secrets-errors">
							{[...errors, ...(importError ? [importError] : [])].map((message) => (
								<p className="text-xs text-destructive" key={message} role="alert">
									{message}
								</p>
							))}
						</div>
					) : null}
					{overwrites.length > 0 ? (
						<p className={HELP_CLASS} data-slot="dev-env-secrets-overwrite">
							{overwrites.join(", ")} {overwrites.length === 1 ? "substitui" : "substituem"} o valor já definido.
						</p>
					) : null}
					{savedCount !== null ? (
						<p className="flex items-center gap-1 text-xs text-muted-foreground" data-slot="dev-env-secrets-saved" role="status">
							<CheckIcon aria-hidden className="size-3.5" />
							{savedSecretsLabel(savedCount)}
						</p>
					) : null}
				</>
			) : (
				<p className="text-xs text-destructive" role="alert">
					Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker para guardar segredos.
				</p>
			)}
		</div>
	);
}

export type EnvironmentDialogProps = {
	open: boolean;
	editing: DevEnvironmentView | null;
	others: readonly DevEnvironmentView[];
	secretsAvailable: boolean;
	/** Padrão da conta (para o rótulo "Padrão da conta (…)"). */
	accountApproval?: DevApprovalMode | null;
	onClose: () => void;
	onSave: (form: DevEnvForm) => Promise<string | null>;
	onDelete?: () => void;
	/** "Limpar cache do ambiente": o pai pede a confirmação e apaga as dependências guardadas. */
	onClearCache?: () => void;
	onRemoveSecret?: (name: string) => Promise<string | null>;
};

/** Formulário de um ambiente: repositório, comandos, recursos, internet e segredos. */
export function EnvironmentDialog({ open, editing, others, secretsAvailable, accountApproval, onClose, onSave, onDelete, onClearCache, onRemoveSecret }: EnvironmentDialogProps) {
	const initial = editing ? formFromEnvironment(editing) : EMPTY_DEV_ENV_FORM;
	const [form, setForm] = useState<DevEnvForm>(initial);
	const [secretErrors, setSecretErrors] = useState<string[]>([]);
	const [savedCount, setSavedCount] = useState<number | null>(null);
	const [prefilled, setPrefilled] = useState(false);
	const touched = useRef(new Set<"installCommand" | "startCommand" | "testCommand" | "tier" | "commandAllowlist">());
	const detectedRepo = useRef<string | null>(null);
	const [errors, setErrors] = useState<DevEnvFormErrors>({});
	const [saveError, setSaveError] = useState<string | null>(null);
	const [justSaved, setJustSaved] = useState(false);
	const [saving, setSaving] = useState(false);
	const [busySecret, setBusySecret] = useState<string | null>(null);
	const [repoOptions, setRepoOptions] = useState<GithubRepoOption[]>([]);
	const [suggestOpen, setSuggestOpen] = useState(false);
	const [listSheet, setListSheet] = useState<"domains" | "commands" | null>(null);
	const loadedRepos = useRef(false);
	const ids = useId();
	const isMobile = useIsMobile();
	const formId = `${ids}-form`;
	const [mobilePage, setMobilePage] = useState<"domains" | "commands" | "secrets" | null>(null);
	const openList = (target: "domains" | "commands") => (isMobile ? openMobilePage(target) : setListSheet(target));

	useEffect(() => {
		if (!open) setSavedCount(null);
	}, [open]);

	// Reabrir com outro ambiente recomeça do zero.
	const key = open ? (editing?.id ?? "novo") : "fechado";
	const lastKey = useRef(key);
	useEffect(() => {
		if (lastKey.current === key) return;
		lastKey.current = key;
		const fresh = editing ? formFromEnvironment(editing) : EMPTY_DEV_ENV_FORM;
		setForm(fresh);
		setSecretErrors([]);
		setPrefilled(false);
		touched.current.clear();
		detectedRepo.current = null;
		setErrors({});
		setSaveError(null);
		loadedRepos.current = false;
	}, [key, editing]);

	// Repositório informado (novo ambiente): lê o repositório e preenche o que o usuário ainda não mexeu.
	const repoKey = editing || !open ? null : normalizeEnvRepo(form.repo);
	useEffect(() => {
		if (!repoKey || detectedRepo.current === repoKey) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			detectedRepo.current = repoKey;
			detectDevEnvironmentFromRepo(repoKey)
				.then((suggestion) => {
					if (cancelled) return;
					setForm((current) => {
						const result = applySuggestion(current, suggestion, touched.current);
						if (result.filled) setPrefilled(true);
						return result.form;
					});
				})
				.catch(() => undefined);
		}, 500);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [repoKey]);

	// Celular: o formulário é uma página (e cada editor, outra) na pilha de navegação: o voltar do aparelho fecha uma por vez.
	useEffect(() => {
		if (!isMobile || !open) return;
		window.history.pushState({ ...(window.history.state ?? {}), atlasEnvDepth: 1 }, "");
		function onPop(event: PopStateEvent) {
			const depth = (event.state as { atlasEnvDepth?: number } | null)?.atlasEnvDepth ?? 0;
			if (depth >= 2) return;
			if (depth === 1) setMobilePage(null);
			else onClose();
		}
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
		// biome-ignore lint/correctness/useExhaustiveDependencies: só ao abrir/fechar.
	}, [isMobile, open]);

	function openMobilePage(target: "domains" | "commands" | "secrets") {
		window.history.pushState({ ...(window.history.state ?? {}), atlasEnvDepth: 2 }, "");
		setMobilePage(target);
	}
	function backMobile() {
		if ((window.history.state as { atlasEnvDepth?: number } | null)?.atlasEnvDepth) window.history.back();
		else if (mobilePage) setMobilePage(null);
		else onClose();
	}

	function touch(field: "installCommand" | "startCommand" | "testCommand" | "tier" | "commandAllowlist") {
		touched.current.add(field);
	}

	function loadRepos() {
		if (loadedRepos.current || editing) return;
		loadedRepos.current = true;
		listGithubRepos()
			.then(setRepoOptions)
			.catch(() => setRepoOptions([]));
	}

	const dirty = isEnvFormDirty(initial, form);
	const taken = others.filter((env) => env.id !== editing?.id).map((env) => env.repo);
	const suggestions = editing ? [] : suggestRepos(repoOptions, form.repo, taken);

	async function submit() {
		const checked = validateEnvForm(form, others, editing?.id ?? null);
		setErrors(checked.ok ? {} : checked.errors);
		setSaveError(null);
		setJustSaved(false);
		const secrets = analyzeSecretsText(form.secretsText, (editing?.secrets ?? []).map((secret) => secret.name));
		setSecretErrors(secrets.errors);
		setSavedCount(null);
		const limit = secretLimitError(secrets.entries.map((entry) => entry.name), (editing?.secrets ?? []).map((secret) => secret.name));
		if (limit) {
			setSaveError(limit);
			return;
		}
		if (!checked.ok) return;
		if (secrets.errors.length > 0) {
			// No celular os segredos ficam numa subpágina: o motivo também aparece aqui, não só lá.
			setSaveError(`Os segredos têm erros: ${secrets.errors[0]}${secrets.errors.length > 1 ? ` (+${secrets.errors.length - 1})` : ""}`);
			return;
		}
		setSaving(true);
		const error = await onSave(form).catch((cause: unknown) => envErrorMessage(cause));
		setSaving(false);
		if (error) setSaveError(error);
		else setJustSaved(true);
		if (!error && secrets.entries.length > 0) {
			// o texto é limpo ao trocar para o ambiente salvo; o aviso fica
			setForm((current) => ({ ...current, secretsText: "" }));
			setSavedCount(secrets.entries.length);
		}
	}

	const existingSecrets = editing?.secrets ?? [];
	const secretsSummary = [existingSecrets.length ? `${existingSecrets.length} definido${existingSecrets.length === 1 ? "" : "s"}` : null, form.secretsText.trim() ? "novos para salvar" : null].filter(Boolean).join(" · ") || "nenhum";
	const formNode = (
	<form
		className="flex min-w-0 flex-col gap-4"
		noValidate
		onSubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<Field error={errors.repo} help={editing ? undefined : prefilled ? "Preenchido a partir do repositório. Edite o que quiser." : "Escolha da sua conta do GitHub ou digite dono/nome."} htmlFor={`${ids}-repo`} label="Repositório">
			<div className="relative">
				<Input
					aria-invalid={errors.repo ? true : undefined}
					autoComplete="off"
					className="font-mono text-body"
					disabled={Boolean(editing)}
					id={`${ids}-repo`}
					onBlur={() => setTimeout(() => setSuggestOpen(false), 120)}
					onChange={(event) => {
						setForm({ ...form, repo: event.target.value });
						setSuggestOpen(true);
					}}
					onFocus={() => {
						loadRepos();
						setSuggestOpen(true);
					}}
					placeholder="acme/site"
					spellCheck={false}
					value={form.repo}
				/>
				{suggestOpen && suggestions.length > 0 ? (
					<ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-44 overflow-auto rounded-2xl bg-popover p-1 shadow-lg ring-1 ring-foreground/10" role="listbox">
						{suggestions.map((name) => (
							<li key={name} role="option">
								<button
									className="flex h-8 w-full items-center rounded-xl px-2.5 text-left font-mono text-body outline-none hover:bg-muted focus-visible:bg-muted"
									onMouseDown={(event) => {
										event.preventDefault();
										setForm({ ...form, repo: name });
										setSuggestOpen(false);
									}}
									type="button"
								>
									<span className="truncate">{name}</span>
								</button>
							</li>
						))}
					</ul>
				) : null}
			</div>
		</Field>

		<Field help="Roda depois do clone e quando o comando mudar." htmlFor={`${ids}-install`} label="Instalação">
			<Textarea
				className={CODE_CLASS}
				id={`${ids}-install`}
				onChange={(event) => {
					touch("installCommand");
					setForm({ ...form, installCommand: event.target.value });
				}}
				placeholder="pnpm install --frozen-lockfile"
				rows={3}
				spellCheck={false}
				value={form.installCommand}
			/>
		</Field>

		<Field help="Sobe em segundo plano ao iniciar a sessão." htmlFor={`${ids}-start`} label="Inicialização">
			<Textarea
				className={CODE_CLASS}
				id={`${ids}-start`}
				onChange={(event) => {
					touch("startCommand");
					setForm({ ...form, startCommand: event.target.value });
				}}
				placeholder="pnpm dev"
				rows={2}
				spellCheck={false}
				value={form.startCommand}
			/>
		</Field>

		<Field help={TEST_COMMAND_HELP} htmlFor={`${ids}-test`} label="Comando de teste rápido">
			<Textarea
				className={CODE_CLASS}
				id={`${ids}-test`}
				onChange={(event) => {
					touch("testCommand");
					setForm({ ...form, testCommand: event.target.value });
				}}
				placeholder="pnpm --filter @app/api test"
				rows={2}
				spellCheck={false}
				value={form.testCommand}
			/>
		</Field>

		<div className="grid gap-4 sm:grid-cols-2">
			<Field label="Recursos">
				<SettingsPicker
					aria-label="Recursos"
					className="w-full"
					onChange={(tier) => {
						touch("tier");
						setForm({ ...form, tier });
					}}
					options={TIER_OPTIONS}
					value={form.tier}
				/>
			</Field>
			<Field label="Internet">
				<SettingsPicker
					aria-label="Internet"
					className="w-full"
					onChange={(network) => setForm({ ...form, network })}
					options={NETWORK_OPTIONS}
					value={form.network}
				/>
			</Field>
		</div>
		<p className={cn(HELP_CLASS, "-mt-2")}>{NETWORK_HELP[form.network]}</p>

		{form.network !== "full" ? (
			<ListSummaryRow label="Domínios liberados" onEdit={() => openList("domains")} summary={`${DEFAULT_EGRESS_ALLOWLIST.length} padrão${form.domains.length ? ` + ${form.domains.length}` : ""}`} />
		) : null}

		<Field help={approvalHelp(form.approvalMode, accountApproval)} label="Aprovação de comandos">
			<SettingsPicker
				aria-label="Aprovação de comandos"
				className="w-full"
				onChange={(approvalMode) => setForm({ ...form, approvalMode })}
				options={approvalOptions(accountApproval)}
				value={form.approvalMode}
			/>
		</Field>

		{showsCommandAllowlist(form.approvalMode, accountApproval) ? (
			<ListSummaryRow label="Comandos liberados" onEdit={() => openList("commands")} summary={String(form.commandAllowlist.length)} />
		) : null}

		{isMobile ? (
			<ListSummaryRow label="Segredos" onEdit={() => openMobilePage("secrets")} summary={secretsSummary} />
		) : (
		<Field help={SECRETS_HELP} label="Segredos">
			<SecretsEditor
				available={secretsAvailable}
				busyName={busySecret}
				errors={secretErrors}
				existing={editing?.secrets ?? []}
				onRemoveExisting={
					onRemoveSecret
						? (name) => {
								setBusySecret(name);
								void onRemoveSecret(name).then((error) => {
									setBusySecret(null);
									if (error) setSaveError(error);
								});
							}
						: undefined
				}
				onTextChange={(secretsText) => {
					setSecretErrors([]);
					setSavedCount(null);
					setForm({ ...form, secretsText });
				}}
				savedCount={savedCount}
				text={form.secretsText}
			/>
		</Field>
		)}

		{saveError ? (
			<p className="text-xs text-destructive" data-slot="dev-env-save-error" role="alert">
				{saveError}
			</p>
		) : null}
		{justSaved && !saveError && dirty === false ? (
			<p className="flex items-center gap-1 text-xs text-muted-foreground" data-slot="dev-env-saved" role="status">
				<CheckIcon aria-hidden className="size-3.5" />
				Salvo
			</p>
		) : null}

		{!isMobile ? (
		<DialogFooter className="items-center sm:justify-between">
			{editing && onDelete ? (
				<div className="flex gap-1 sm:mr-auto">
					<Button onClick={onDelete} type="button" variant="ghost">
						Excluir ambiente
					</Button>
					{onClearCache ? (
						<Button data-slot="dev-env-clear-cache" onClick={onClearCache} type="button" variant="ghost">
							Limpar cache do ambiente
						</Button>
					) : null}
				</div>
			) : (
				<span />
			)}
			<div className="flex flex-col-reverse gap-2 sm:flex-row">
				<Button onClick={onClose} type="button" variant="outline">
					Cancelar
				</Button>
				<Button disabled={saving || (Boolean(editing) && !dirty)} type="submit">
					{saving ? "Salvando…" : "Salvar"}
				</Button>
			</div>
		</DialogFooter>
		) : null}
	</form>
	);

	if (isMobile) {
		if (!open) return null;
		const subTitle = mobilePage === "domains" ? "Domínios liberados" : mobilePage === "commands" ? "Comandos liberados" : "Segredos";
		return (
			<>
				<MobilePage
					footer={
						<Button className="w-full" disabled={saving || (Boolean(editing) && !dirty)} form={formId} type="submit">
							{saving ? "Salvando…" : "Salvar"}
						</Button>
					}
					onBack={backMobile}
					title={editing ? "Editar ambiente" : "Novo ambiente"}
				>
					{editing?.source === "auto" ? <p className={cn(HELP_CLASS, "mb-3")}>Detectado automaticamente a partir do repositório. O que você mudar aqui o agente mantém.</p> : null}
					{formNode}
					{editing && onClearCache ? (
						<Button className="mt-4 w-full" data-slot="dev-env-clear-cache" onClick={onClearCache} type="button" variant="ghost">
							Limpar cache do ambiente
						</Button>
					) : null}
					{editing && onDelete ? (
						<Button className="mt-2 w-full" onClick={onDelete} type="button" variant="ghost">
							Excluir ambiente
						</Button>
					) : null}
				</MobilePage>
				{mobilePage ? (
					<MobilePage footer={<Button className="w-full" onClick={backMobile} type="button">Pronto</Button>} level={2} onBack={backMobile} title={subTitle}>
						{mobilePage === "domains" ? <DomainsEditor domains={form.domains} onChange={(domains) => setForm({ ...form, domains })} /> : null}
						{mobilePage === "commands" ? (
							<CommandsEditor
								commands={form.commandAllowlist}
								onChange={(commandAllowlist) => {
									touch("commandAllowlist");
									setForm({ ...form, commandAllowlist });
								}}
							/>
						) : null}
						{mobilePage === "secrets" ? (
							<>
								<p className={cn(HELP_CLASS, "mb-3")}>{SECRETS_HELP}</p>
								<SecretsEditor
				available={secretsAvailable}
				busyName={busySecret}
				errors={secretErrors}
				existing={editing?.secrets ?? []}
				onRemoveExisting={
					onRemoveSecret
						? (name) => {
								setBusySecret(name);
								void onRemoveSecret(name).then((error) => {
									setBusySecret(null);
									if (error) setSaveError(error);
								});
							}
						: undefined
				}
				onTextChange={(secretsText) => {
					setSecretErrors([]);
					setSavedCount(null);
					setForm({ ...form, secretsText });
				}}
				savedCount={savedCount}
				text={form.secretsText}
			/>
							</>
						) : null}
					</MobilePage>
				) : null}
			</>
		);
	}

	return (
		<Dialog onOpenChange={(next) => !next && !saving && onClose()} open={open}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-5 sm:max-w-xl sm:p-6" data-slot="dev-env-dialog">
				<DialogHeader>
					<DialogTitle className="text-base font-semibold">{editing ? "Editar ambiente" : "Novo ambiente"}</DialogTitle>
					<DialogDescription>{editing?.source === "auto" ? "Detectado automaticamente a partir do repositório. O que você mudar aqui o agente mantém." : "Vale para as sessões de código deste repositório."}</DialogDescription>
				</DialogHeader>
				{formNode}
				<ListSheet description="Só esses domínios saem pelo proxy, além dos padrão." onOpenChange={(open) => !open && setListSheet(null)} open={listSheet === "domains"} title="Domínios liberados">
					<DomainsEditor domains={form.domains} onChange={(domains) => setForm({ ...form, domains })} />
				</ListSheet>
				<ListSheet description="Comandos que começam assim rodam sem perguntar (também no modo Automático). Aqui entram os de “Sempre neste repositório”; remova para voltar a perguntar. Leituras já são liberadas." onOpenChange={(open) => !open && setListSheet(null)} open={listSheet === "commands"} title="Comandos liberados">
					<CommandsEditor
						commands={form.commandAllowlist}
						onChange={(commandAllowlist) => {
							touch("commandAllowlist");
							setForm({ ...form, commandAllowlist });
						}}
					/>
				</ListSheet>
			</DialogContent>
		</Dialog>
	);
}

export type DevEnvironmentsListProps = {
	environments: readonly DevEnvironmentView[];
	loading: boolean;
	error: string | null;
	onAdd: () => void;
	onEdit: (env: DevEnvironmentView) => void;
	/** Padrão da conta para aprovação de comandos. */
	defaultApprovalMode?: DevApprovalMode | null;
	onChangeDefaultApproval?: (mode: DevApprovalMode) => void;
	/** Verificador inteligente da conta (aparece ao lado do seletor de aprovação). */
	verifierEnabled?: boolean;
	onChangeVerifier?: (enabled: boolean) => void;
	/** Confirmação curta depois de salvar ("Salvo"). */
	notice?: string | null;
};

/** Linhas do grupo "Ambientes de código" (só apresentação). */
export function DevEnvironmentsListView({ environments, loading, error, onAdd, onEdit, defaultApprovalMode, onChangeDefaultApproval, verifierEnabled = true, onChangeVerifier, notice }: DevEnvironmentsListProps) {
	return (
		<SettingsGroup title="Ambientes de código">
			{onChangeDefaultApproval ? (
				<SettingRow
					description="Vale para os repositórios que não definem o próprio modo."
					icon={ShieldCheckIcon}
					label="Aprovação de comandos"
				>
					<SettingsPicker
						aria-label="Aprovação de comandos (padrão da conta)"
						onChange={onChangeDefaultApproval}
						options={ACCOUNT_APPROVAL_OPTIONS}
						value={defaultApprovalMode ?? DEFAULT_DEV_APPROVAL_MODE}
					/>
				</SettingRow>
			) : null}
			{onChangeVerifier ? (
				<SettingRow control="inline" description={DEV_VERIFIER_HINT} htmlFor="dev-verifier" icon={ShieldCheckIcon} label={DEV_VERIFIER_LABEL}>
					<Switch aria-label={DEV_VERIFIER_LABEL} checked={verifierEnabled} id="dev-verifier" onCheckedChange={onChangeVerifier} />
				</SettingRow>
			) : null}
			{notice ? (
				<SettingRow caption={<p data-slot="dev-env-notice" role="status">Alterações do ambiente salvas.</p>} control="inline" icon={CheckIcon} label={notice} />
			) : null}
			{error ? (
				<SettingRow caption={<p className="text-destructive">{error}</p>} control="inline" icon={BoxesIcon} label="Não foi possível carregar" />
			) : loading && environments.length === 0 ? (
				<SettingRow caption="Carregando…" icon={BoxesIcon} label="Ambientes de código" />
			) : null}
			{environments.map((env) => (
				<SettingRow
					caption={
						<>
							{envSummary(env)}
							{env.source === "auto" ? <AutoTag /> : null}
						</>
					}
					control="inline"
					description="Instalação, internet e segredos das sessões de código deste repositório."
					icon={BoxesIcon}
					key={env.id}
					label={env.repo}
				>
					<Button onClick={() => onEdit(env)} size="sm" variant="ghost">
						Editar
					</Button>
				</SettingRow>
			))}
			{!loading && !error && environments.length === 0 ? (
				<SettingRow
					caption="Quando o agente trabalha num repositório, o ambiente é detectado e aparece aqui. Edite só se quiser mudar algo."
					icon={BoxesIcon}
					label="Criados automaticamente"
				/>
			) : null}
			<SettingRow control="inline" description="Opcional: configure um repositório antes de usá-lo." icon={PlusIcon} label="Adicionar manualmente">
				<Button onClick={onAdd} size="sm" variant="ghost">
					Adicionar
				</Button>
			</SettingRow>
		</SettingsGroup>
	);
}

/** Ambientes de código por repositório: lista + diálogo de edição. */
export function DevEnvironmentsSettings() {
	const data = useDevEnvironments();
	const [dialog, setDialog] = useState<{ editing: DevEnvironmentView | null } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<DevEnvironmentView | null>(null);
	const [confirmClear, setConfirmClear] = useState<DevEnvironmentView | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const current = dialog?.editing ? (data.environments.find((env) => env.id === dialog.editing!.id) ?? dialog.editing) : null;

	return (
		<>
			<DevEnvironmentsListView
				environments={data.environments}
				error={data.error ?? deleteError}
				loading={data.loading}
				notice={notice}
				onAdd={() => {
					setNotice(null);
					setDialog({ editing: null });
				}}
				onEdit={(env) => {
					setNotice(null);
					setDialog({ editing: env });
				}}
				defaultApprovalMode={data.defaultApprovalMode}
				onChangeDefaultApproval={(mode) => {
					void data.changeDefaultApproval(mode).then((failure) => setDeleteError(failure));
				}}
				onChangeVerifier={(enabled) => {
					void data.changeVerifier(enabled).then((failure) => setDeleteError(failure));
				}}
				verifierEnabled={data.verifierEnabled}
			/>
			<EnvironmentDialog
				accountApproval={data.defaultApprovalMode}
				editing={current}
				onClose={() => setDialog(null)}
				onDelete={current ? () => setConfirmDelete(current) : undefined}
				onClearCache={current ? () => setConfirmClear(current) : undefined}
				onRemoveSecret={
					current
						? async (name) => {
								const result = await data.removeSecret(current.id, name);
								return result.error ?? null;
							}
						: undefined
				}
				onSave={async (form) => {
					const result = await data.save(current?.id ?? null, form);
					if (!result.ok) {
						setNotice(null);
						return result.error;
					}
					setNotice("Salvo");
					// Com segredos salvos, o diálogo fica aberto (já no ambiente salvo) para mostrar "N segredos salvos".
					setDialog(parseEnvPaste(form.secretsText).entries.length > 0 ? { editing: result.environment } : null);
					return null;
				}}
				open={dialog !== null}
				others={data.environments}
				secretsAvailable={data.secretsAvailable}
			/>
			<AlertDialog onOpenChange={(open) => !open && setConfirmClear(null)} open={confirmClear !== null}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Limpar o cache do ambiente de {confirmClear?.repo}?</AlertDialogTitle>
						<AlertDialogDescription>
							As dependências guardadas serão apagadas. A próxima sessão de código deste repositório instala tudo do zero, o que leva mais tempo. Comandos e segredos não mudam.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancelar</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								const target = confirmClear;
								setConfirmClear(null);
								if (!target) return;
								void data.clearCache(target.id).then((result) => {
									setDeleteError(result.error ?? null);
									if (!result.error) setNotice(result.cleared ? "Cache do ambiente limpo" : "Não havia cache para limpar");
								});
							}}
						>
							Limpar cache
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog onOpenChange={(open) => !open && setConfirmDelete(null)} open={confirmDelete !== null}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Excluir o ambiente de {confirmDelete?.repo}?</AlertDialogTitle>
						<AlertDialogDescription>
							Os comandos e os segredos salvos serão apagados. As sessões de código deste repositório continuam funcionando, só sem este ambiente.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancelar</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								const target = confirmDelete;
								setConfirmDelete(null);
								if (!target) return;
								void data.remove(target.id).then((error) => {
									setDeleteError(error);
									if (!error) setDialog(null);
								});
							}}
						>
							Excluir
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
