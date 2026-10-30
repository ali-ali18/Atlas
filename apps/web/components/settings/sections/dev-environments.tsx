"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeftIcon, BoxesIcon, CheckIcon, PlusIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { DEFAULT_COMMAND_ALLOWLIST, DEFAULT_DEV_APPROVAL_MODE, DEFAULT_EGRESS_ALLOWLIST, normalizeEnvRepo, parseEnvPaste, type DevApprovalMode } from "@workspace/shared";
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
import { useT, useTranslations } from "@/lib/i18n/provider";
import { devVerifierHint, devVerifierLabel } from "@/lib/shared-labels";
import {
	accountApprovalOptions,
	EMPTY_DEV_ENV_FORM,
	addCommandPrefixes,
	approvalHelp,
	approvalOptions,
	showsCommandAllowlist,
	networkHelp,
	networkOptions,
	secretsHelp,
	testCommandHelp,
	tierOptions,
	translateCommandError,
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
	const translator = useTranslations();
	const { t } = translator;
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [showDefaults, setShowDefaults] = useState(false);
	const id = useId();
	function add() {
		if (!text.trim()) return;
		const result = addDomains(domains, text, translator);
		onChange(result.domains);
		setError(result.error);
		if (!result.error) setText("");
	}
	return (
		<div className="flex min-w-0 flex-col gap-2" data-slot="dev-env-domains">
			<div className="flex items-center gap-2">
				<Input
					aria-label={t("settings.dev.addDomainAria")}
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
					placeholder={t("settings.dev.domainPlaceholder")}
					spellCheck={false}
					value={text}
				/>
				<Button disabled={!text.trim()} onClick={add} size="sm" type="button" variant="outline">
					{t("settings.dev.add")}
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
						<Chip key={domain} label={t("settings.dev.removeAria", { item: domain })} onRemove={() => onChange(domains.filter((item) => item !== domain))}>
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
				{showDefaults ? t("settings.dev.hideDefaults", { count: DEFAULT_EGRESS_ALLOWLIST.length }) : t("settings.dev.showDefaults", { count: DEFAULT_EGRESS_ALLOWLIST.length })}
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
	const t = useT();
	return (
		<div className="fixed inset-0 flex flex-col bg-background" data-level={level} data-slot="dev-env-mobile-page" style={{ zIndex: 50 + level }}>
			<header className="grid shrink-0 grid-cols-[3rem_1fr_3rem] items-center px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
				<button aria-label={t("settings.dev.back")} className="flex size-11 items-center justify-center rounded-full text-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30" onClick={onBack} type="button">
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
	const t = useT();
	return (
		<span className="ml-2 inline-flex h-5 items-center rounded-full bg-muted px-2 text-caption text-muted-foreground" data-slot="dev-env-auto-tag">
			{t("settings.dev.autoTag")}
		</span>
	);
}

/** Linha compacta de uma lista longa: rótulo, resumo e "Editar" (a lista completa abre numa folha). */
export function ListSummaryRow({ label, summary, onEdit }: { label: string; summary: string; onEdit: () => void }) {
	const t = useT();
	return (
		<div className="flex min-h-9 items-center gap-2 rounded-3xl bg-input/50 pr-1 pl-3 text-sm" data-slot="dev-env-list-row">
			<span className="min-w-0 flex-1 truncate">
				{label}
				<span className="text-muted-foreground"> · {summary}</span>
			</span>
			<Button onClick={onEdit} size="sm" type="button" variant="ghost">
				{t("settings.dev.edit")}
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
	const translator = useTranslations();
	const { t } = translator;
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	function add() {
		if (!text.trim()) return;
		const result = addCommandPrefixes(commands, text);
		onChange(result.list);
		setError(translateCommandError(result.error, translator));
		if (!result.error) setText("");
	}
	const isDefault = commands.length === DEFAULT_COMMAND_ALLOWLIST.length && DEFAULT_COMMAND_ALLOWLIST.every((item) => commands.includes(item));
	return (
		<div className="flex min-w-0 flex-col gap-2" data-slot="dev-env-commands">
			<div className="flex items-center gap-2">
				<Input
					aria-label={t("settings.dev.addCommandAria")}
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
					{t("settings.dev.add")}
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
						<Chip key={command} label={t("settings.dev.removeAria", { item: command })} onRemove={() => onChange(commands.filter((item) => item !== command))}>
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
					{t("settings.dev.restoreDefaults")}
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
	const translator = useTranslations();
	const { t } = translator;
	const [importError, setImportError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const existingNames = existing.map((secret) => secret.name);
	const overwrites = [...new Set(analyzeSecretsText(text, existingNames, translator).overwrites)];
	const textareaId = useId();

	function importFile(file: File | undefined) {
		if (!file) return;
		setImportError(null);
		if (file.size > MAX_IMPORT_BYTES) {
			setImportError(t("settings.dev.fileTooBig"));
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
								{t("settings.dev.secretDefined")}
							</span>
							{onRemoveExisting ? (
								<Button
									aria-label={t("settings.dev.deleteSecretAria", { name: secret.name })}
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
						aria-label={t("settings.dev.secretsAria")}
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
							{t("settings.dev.importEnv")}
						</button>
						<input
							accept=".env,text/plain,application/octet-stream"
							aria-label={t("settings.dev.envFileAria")}
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
							{translator.tn("settings.dev.overwrites", overwrites.length, { names: overwrites.join(", ") })}
						</p>
					) : null}
					{savedCount !== null ? (
						<p className="flex items-center gap-1 text-xs text-muted-foreground" data-slot="dev-env-secrets-saved" role="status">
							<CheckIcon aria-hidden className="size-3.5" />
							{savedSecretsLabel(savedCount, translator)}
						</p>
					) : null}
				</>
			) : (
				<p className="text-xs text-destructive" role="alert">
					{t("settings.dev.vaultMissing")}
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
	const translator = useTranslations();
	const { t } = translator;
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
		const checked = validateEnvForm(form, others, editing?.id ?? null, translator);
		setErrors(checked.ok ? {} : checked.errors);
		setSaveError(null);
		setJustSaved(false);
		const secrets = analyzeSecretsText(form.secretsText, (editing?.secrets ?? []).map((secret) => secret.name), translator);
		setSecretErrors(secrets.errors);
		setSavedCount(null);
		const limit = secretLimitError(secrets.entries.map((entry) => entry.name), (editing?.secrets ?? []).map((secret) => secret.name), translator);
		if (limit) {
			setSaveError(limit);
			return;
		}
		if (!checked.ok) return;
		if (secrets.errors.length > 0) {
			// No celular os segredos ficam numa subpágina: o motivo também aparece aqui, não só lá.
			setSaveError(secrets.errors.length > 1 ? t("settings.dev.err.secretsHaveErrorsMore", { first: secrets.errors[0]!, more: secrets.errors.length - 1 }) : t("settings.dev.err.secretsHaveErrors", { first: secrets.errors[0]! }));
			return;
		}
		setSaving(true);
		const error = await onSave(form).catch((cause: unknown) => envErrorMessage(cause, translator));
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
	const secretsSummary = [existingSecrets.length ? translator.tn("settings.dev.definedCount", existingSecrets.length) : null, form.secretsText.trim() ? t("settings.dev.newToSave") : null].filter(Boolean).join(" · ") || t("settings.dev.none");
	const formNode = (
	<form
		className="flex min-w-0 flex-col gap-4"
		noValidate
		onSubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<Field error={errors.repo} help={editing ? undefined : prefilled ? t("settings.dev.repoPrefilled") : t("settings.dev.repoHelp")} htmlFor={`${ids}-repo`} label={t("settings.dev.repo")}>
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
					placeholder={t("settings.dev.repoPlaceholder")}
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

		<Field help={t("settings.dev.installHelp")} htmlFor={`${ids}-install`} label={t("settings.dev.install")}>
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

		<Field help={t("settings.dev.startHelp")} htmlFor={`${ids}-start`} label={t("settings.dev.start")}>
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

		<Field help={testCommandHelp(translator)} htmlFor={`${ids}-test`} label={t("settings.dev.testCommand")}>
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
			<Field label={t("settings.dev.resources")}>
				<SettingsPicker
					aria-label={t("settings.dev.resources")}
					className="w-full"
					onChange={(tier) => {
						touch("tier");
						setForm({ ...form, tier });
					}}
					options={tierOptions(translator)}
					value={form.tier}
				/>
			</Field>
			<Field label={t("settings.dev.internet")}>
				<SettingsPicker
					aria-label={t("settings.dev.internet")}
					className="w-full"
					onChange={(network) => setForm({ ...form, network })}
					options={networkOptions(translator)}
					value={form.network}
				/>
			</Field>
		</div>
		<p className={cn(HELP_CLASS, "-mt-2")}>{networkHelp(form.network, translator)}</p>

		{form.network !== "full" ? (
			<ListSummaryRow label={t("settings.dev.allowedDomains")} onEdit={() => openList("domains")} summary={form.domains.length ? t("settings.dev.domainsSummaryExtra", { count: DEFAULT_EGRESS_ALLOWLIST.length, extra: form.domains.length }) : t("settings.dev.domainsSummary", { count: DEFAULT_EGRESS_ALLOWLIST.length })} />
		) : null}

		<Field help={approvalHelp(form.approvalMode, accountApproval, translator)} label={t("settings.dev.approval")}>
			<SettingsPicker
				aria-label={t("settings.dev.approval")}
				className="w-full"
				onChange={(approvalMode) => setForm({ ...form, approvalMode })}
				options={approvalOptions(accountApproval, translator)}
				value={form.approvalMode}
			/>
		</Field>

		{showsCommandAllowlist(form.approvalMode, accountApproval) ? (
			<ListSummaryRow label={t("settings.dev.allowedCommands")} onEdit={() => openList("commands")} summary={String(form.commandAllowlist.length)} />
		) : null}

		{isMobile ? (
			<ListSummaryRow label={t("settings.dev.secrets")} onEdit={() => openMobilePage("secrets")} summary={secretsSummary} />
		) : (
		<Field help={secretsHelp(translator)} label={t("settings.dev.secrets")}>
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
				{t("settings.dev.saved")}
			</p>
		) : null}

		{!isMobile ? (
		<DialogFooter className="items-center sm:justify-between">
			{editing && onDelete ? (
				<div className="flex gap-1 sm:mr-auto">
					<Button onClick={onDelete} type="button" variant="ghost">
						{t("settings.dev.deleteEnv")}
					</Button>
					{onClearCache ? (
						<Button data-slot="dev-env-clear-cache" onClick={onClearCache} type="button" variant="ghost">
							{t("settings.dev.clearCache")}
						</Button>
					) : null}
				</div>
			) : (
				<span />
			)}
			<div className="flex flex-col-reverse gap-2 sm:flex-row">
				<Button onClick={onClose} type="button" variant="outline">
					{t("settings.dev.cancel")}
				</Button>
				<Button disabled={saving || (Boolean(editing) && !dirty)} type="submit">
					{saving ? t("settings.dev.saving") : t("settings.dev.save")}
				</Button>
			</div>
		</DialogFooter>
		) : null}
	</form>
	);

	if (isMobile) {
		if (!open) return null;
		const subTitle = mobilePage === "domains" ? t("settings.dev.allowedDomains") : mobilePage === "commands" ? t("settings.dev.allowedCommands") : t("settings.dev.secrets");
		return (
			<>
				<MobilePage
					footer={
						<Button className="w-full" disabled={saving || (Boolean(editing) && !dirty)} form={formId} type="submit">
							{saving ? t("settings.dev.saving") : t("settings.dev.save")}
						</Button>
					}
					onBack={backMobile}
					title={editing ? t("settings.dev.editEnv") : t("settings.dev.newEnv")}
				>
					{editing?.source === "auto" ? <p className={cn(HELP_CLASS, "mb-3")}>{t("settings.dev.autoDetectedNote")}</p> : null}
					{formNode}
					{editing && onClearCache ? (
						<Button className="mt-4 w-full" data-slot="dev-env-clear-cache" onClick={onClearCache} type="button" variant="ghost">
							{t("settings.dev.clearCache")}
						</Button>
					) : null}
					{editing && onDelete ? (
						<Button className="mt-2 w-full" onClick={onDelete} type="button" variant="ghost">
							{t("settings.dev.deleteEnv")}
						</Button>
					) : null}
				</MobilePage>
				{mobilePage ? (
					<MobilePage footer={<Button className="w-full" onClick={backMobile} type="button">{t("settings.dev.done")}</Button>} level={2} onBack={backMobile} title={subTitle}>
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
								<p className={cn(HELP_CLASS, "mb-3")}>{secretsHelp(translator)}</p>
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
					<DialogTitle className="text-base font-semibold">{editing ? t("settings.dev.editEnv") : t("settings.dev.newEnv")}</DialogTitle>
					<DialogDescription>{editing?.source === "auto" ? t("settings.dev.autoDetectedNote") : t("settings.dev.appliesToRepo")}</DialogDescription>
				</DialogHeader>
				{formNode}
				<ListSheet description={t("settings.dev.domainsSheetBody")} onOpenChange={(open) => !open && setListSheet(null)} open={listSheet === "domains"} title={t("settings.dev.allowedDomains")}>
					<DomainsEditor domains={form.domains} onChange={(domains) => setForm({ ...form, domains })} />
				</ListSheet>
				<ListSheet description={t("settings.dev.commandsSheetBody")} onOpenChange={(open) => !open && setListSheet(null)} open={listSheet === "commands"} title={t("settings.dev.allowedCommands")}>
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
	const translator = useTranslations();
	const { t } = translator;
	return (
		<SettingsGroup title={t("settings.dev.group")}>
			{onChangeDefaultApproval ? (
				<SettingRow
					description={t("settings.dev.defaultApprovalHint")}
					icon={ShieldCheckIcon}
					label={t("settings.dev.approval")}
				>
					<SettingsPicker
						aria-label={t("settings.dev.defaultApprovalAria")}
						onChange={onChangeDefaultApproval}
						options={accountApprovalOptions(translator)}
						value={defaultApprovalMode ?? DEFAULT_DEV_APPROVAL_MODE}
					/>
				</SettingRow>
			) : null}
			{onChangeVerifier ? (
				<SettingRow control="inline" description={devVerifierHint(translator)} htmlFor="dev-verifier" icon={ShieldCheckIcon} label={devVerifierLabel(translator)}>
					<Switch aria-label={devVerifierLabel(translator)} checked={verifierEnabled} id="dev-verifier" onCheckedChange={onChangeVerifier} />
				</SettingRow>
			) : null}
			{notice ? (
				<SettingRow caption={<p data-slot="dev-env-notice" role="status">{t("settings.dev.noticeSaved")}</p>} control="inline" icon={CheckIcon} label={notice} />
			) : null}
			{error ? (
				<SettingRow caption={<p className="text-destructive">{error}</p>} control="inline" icon={BoxesIcon} label={t("settings.dev.loadError")} />
			) : loading && environments.length === 0 ? (
				<SettingRow caption={t("common.loading")} icon={BoxesIcon} label={t("settings.dev.group")} />
			) : null}
			{environments.map((env) => (
				<SettingRow
					caption={
						<>
							{envSummary(env, translator)}
							{env.source === "auto" ? <AutoTag /> : null}
						</>
					}
					control="inline"
					description={t("settings.dev.rowHint")}
					icon={BoxesIcon}
					key={env.id}
					label={env.repo}
				>
					<Button onClick={() => onEdit(env)} size="sm" variant="ghost">
						{t("settings.dev.edit")}
					</Button>
				</SettingRow>
			))}
			{!loading && !error && environments.length === 0 ? (
				<SettingRow
					caption={t("settings.dev.autoCreatedBody")}
					icon={BoxesIcon}
					label={t("settings.dev.autoCreated")}
				/>
			) : null}
			<SettingRow control="inline" description={t("settings.dev.addManuallyHint")} icon={PlusIcon} label={t("settings.dev.addManually")}>
				<Button onClick={onAdd} size="sm" variant="ghost">
					{t("settings.dev.add")}
				</Button>
			</SettingRow>
		</SettingsGroup>
	);
}

/** Ambientes de código por repositório: lista + diálogo de edição. */
export function DevEnvironmentsSettings() {
	const t = useT();
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
					setNotice(t("settings.dev.saved"));
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
						<AlertDialogTitle>{t("settings.dev.clearTitle", { repo: confirmClear?.repo ?? "" })}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings.dev.clearBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("settings.dev.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								const target = confirmClear;
								setConfirmClear(null);
								if (!target) return;
								void data.clearCache(target.id).then((result) => {
									setDeleteError(result.error ?? null);
									if (!result.error) setNotice(result.cleared ? t("settings.dev.cacheCleared") : t("settings.dev.cacheNone"));
								});
							}}
						>
							{t("settings.dev.clearConfirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog onOpenChange={(open) => !open && setConfirmDelete(null)} open={confirmDelete !== null}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings.dev.deleteTitle", { repo: confirmDelete?.repo ?? "" })}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings.dev.deleteBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("settings.dev.cancel")}</AlertDialogCancel>
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
							{t("settings.dev.deleteConfirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
