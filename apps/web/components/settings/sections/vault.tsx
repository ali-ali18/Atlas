"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, LockKeyholeIcon, PencilIcon, PlusIcon, QrCodeIcon, RefreshCwIcon, SearchIcon, ShieldCheckIcon, Trash2Icon, XIcon } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@workspace/ui/components/input-group";
import { Switch } from "@workspace/ui/components/switch";
import { Textarea } from "@workspace/ui/components/textarea";
import { useIsMobile } from "@workspace/ui/hooks/use-mobile";
import { cn } from "@workspace/ui/lib/utils";
import { SettingsPage } from "@/components/ui/templates/template-4/settings-list";
import { CustomMcpIcon } from "@/components/ai-elements/connectors/custom-mcp-icon";
import { VAULT_NEW_LOGIN_PARAM } from "@/components/settings/settings-url";
import { suggestLoginName } from "@workspace/shared";
import {
	createVaultItem,
	deleteVaultItem,
	getVaultItem,
	getVaultTotp,
	listVault,
	previewTotp,
	recordVaultCopy,
	revealVaultItem,
	updateVaultItem,
	type VaultAuditEntry,
	type VaultItemKind,
	type VaultItemView,
	type VaultPayloadView,
} from "@/lib/atlas-api";
import { SettingsGroup, SettingsStack } from "../setting-row";
import {
	VAULT_UNAVAILABLE,
	auditLabel,
	emptyVaultForm,
	filterVaultItems,
	formFromItem,
	formToInput,
	formatVaultDate,
	normalizeSiteUrl,
	generatePassword,
	itemSubtitle,
	itemTitle,
	passwordStrength,
	validateVaultForm,
	withSuggestedName,
	type VaultFilter,
	type VaultForm,
	type VaultFormErrors,
} from "../vault-state";

// ----- peças visuais -----

export function VaultLogo({ item, className }: { item: Pick<VaultItemView, "kind" | "label" | "name" | "siteUrl">; className?: string }) {
	if (item.kind === "login" && item.siteUrl) {
		return <CustomMcpIcon className={cn("size-9 rounded-lg bg-muted/60 p-1.5", className)} name={itemTitle(item)} url={item.siteUrl} />;
	}
	return (
		<span aria-hidden className={cn("grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground", className)}>
			<KeyRoundIcon className="size-4" />
		</span>
	);
}

const FIELD_LABEL = "text-xs font-medium text-muted-foreground";

function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor?: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<label className={FIELD_LABEL} htmlFor={htmlFor}>
				{label}
			</label>
			{children}
			{error ? (
				<p className="m-0 text-xs text-destructive" role="alert">
					{error}
				</p>
			) : hint ? (
				<p className="m-0 text-xs text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}

// ----- lista -----

export type VaultListViewProps = {
	items: VaultItemView[];
	available: boolean;
	loading?: boolean;
	error?: string | null;
	query: string;
	filter: VaultFilter;
	onQuery: (query: string) => void;
	onFilter: (filter: VaultFilter) => void;
	onAdd: (kind: VaultItemKind) => void;
	onOpen: (id: string) => void;
};

const FILTERS: Array<{ id: VaultFilter; label: string }> = [
	{ id: "all", label: "Tudo" },
	{ id: "login", label: "Logins" },
	{ id: "secret", label: "Segredos" },
];

export function VaultListView({ items, available, loading, error, query, filter, onQuery, onFilter, onAdd, onOpen }: VaultListViewProps) {
	const visible = useMemo(() => filterVaultItems(items, query, filter), [items, query, filter]);
	return (
		<SettingsStack>
			<section className="flex flex-col gap-3" data-slot="vault-list">
				<p className="m-0 px-2 text-body leading-5 text-muted-foreground">
					Senhas e chaves ficam criptografadas só para você. O bot vê apenas nomes e sites, e usa os valores sem nunca lê-los.
				</p>
				{!available ? (
					<p className="m-0 rounded-xl border border-border/60 px-3 py-2.5 text-xs text-muted-foreground" role="status">
						{VAULT_UNAVAILABLE}
					</p>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-[10rem] flex-1">
						<SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input aria-label="Buscar no cofre" className="pl-9" onChange={(event) => onQuery(event.target.value)} placeholder="Buscar" value={query} />
					</div>
					<Button disabled={!available} onClick={() => onAdd("login")} size="sm" type="button">
						<PlusIcon data-icon="inline-start" />
						Login de site
					</Button>
					<Button disabled={!available} onClick={() => onAdd("secret")} size="sm" type="button" variant="outline">
						<PlusIcon data-icon="inline-start" />
						Segredo
					</Button>
				</div>
				<div className="flex gap-1.5" role="tablist">
					{FILTERS.map((option) => (
						<button
							aria-selected={filter === option.id}
							className={cn(
								"rounded-full border px-3 py-1 text-xs transition-colors",
								filter === option.id ? "border-foreground/30 bg-muted text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground",
							)}
							key={option.id}
							onClick={() => onFilter(option.id)}
							role="tab"
							type="button"
						>
							{option.label}
						</button>
					))}
				</div>
				{error ? (
					<p className="m-0 text-xs text-destructive" role="alert">
						{error}
					</p>
				) : null}
				{loading && items.length === 0 ? <p className="m-0 px-2 text-xs text-muted-foreground">Carregando…</p> : null}
				{!loading && available && items.length === 0 ? (
					<div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-border/60 px-4 py-8 text-center">
						<LockKeyholeIcon aria-hidden className="size-5 text-muted-foreground" />
						<p className="m-0 text-body font-medium">O cofre está vazio</p>
						<p className="m-0 max-w-xs text-xs text-muted-foreground">Guarde um login de site ou uma chave de API. Quando o bot precisar de algo, ele pede aqui.</p>
					</div>
				) : null}
				{items.length > 0 && visible.length === 0 ? <p className="m-0 px-2 text-xs text-muted-foreground">Nada encontrado para "{query}".</p> : null}
				{visible.length > 0 ? (
					<SettingsGroup>
						<ul className="m-0 flex list-none flex-col p-0">
							{visible.map((item) => (
								<li key={item.id}>
									<button
										className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
										data-vault-item={item.id}
										onClick={() => onOpen(item.id)}
										type="button"
									>
										<VaultLogo item={item} />
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate text-body leading-[18px] font-medium">{itemTitle(item)}</span>
											<span className="truncate text-xs text-muted-foreground">{itemSubtitle(item)}</span>
										</span>
										<span className="hidden shrink-0 text-caption text-muted-foreground sm:block">{item.lastUsedAt ? `Usado ${formatVaultDate(item.lastUsedAt)}` : "Nunca usado"}</span>
									</button>
								</li>
							))}
						</ul>
					</SettingsGroup>
				) : null}
			</section>
		</SettingsStack>
	);
}

// ----- detalhe -----

export type VaultDetailViewProps = {
	item: VaultItemView;
	audit: VaultAuditEntry[];
	/** Conteúdo já revelado (some ao fechar). */
	revealed: VaultPayloadView | null;
	totp: { code: string; expiresInSec: number } | null;
	copied: string | null;
	busy?: boolean;
	error?: string | null;
	onReveal: () => void;
	onHide: () => void;
	onCopy: (what: "username" | "password" | "value" | "totp" | string) => void;
	onEdit: () => void;
	onDelete: () => void;
	/** Ausente = sem botão de fechar (página no celular tem ←). */
	onClose?: () => void;
};

function CopyButton({ label, done, onClick }: { label: string; done: boolean; onClick: () => void }) {
	return (
		<InputGroupButton aria-label={`Copiar ${label}`} onClick={onClick} size="icon-xs" title={`Copiar ${label}`}>
			{done ? <CheckIcon /> : <CopyIcon />}
		</InputGroupButton>
	);
}

/** Campo somente leitura: o valor num input, com os botões (olho, copiar) DENTRO, à direita. */
function ReadonlyField({ label, value, mono, children, id }: { label: string; value: string; mono?: boolean; children?: ReactNode; id?: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<span className={FIELD_LABEL}>{label}</span>
			<InputGroup>
				<InputGroupInput aria-label={label} className={cn(mono && "font-mono")} id={id} readOnly tabIndex={-1} value={value} />
				{children ? <InputGroupAddon align="inline-end">{children}</InputGroupAddon> : null}
			</InputGroup>
		</div>
	);
}

/** Anel pequeno com os segundos que faltam para o código mudar. */
export function CountdownRing({ seconds, period = 30 }: { seconds: number; period?: number }) {
	const r = 9;
	const c = 2 * Math.PI * r;
	const fraction = Math.max(0, Math.min(1, seconds / period));
	return (
		<span aria-label={`Muda em ${seconds}s`} className="relative grid size-6 shrink-0 place-items-center text-[9px] tabular-nums text-muted-foreground" data-slot="vault-countdown" role="img">
			<svg aria-hidden className="absolute inset-0 -rotate-90" viewBox="0 0 24 24">
				<circle cx="12" cy="12" fill="none" r={r} stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
				<circle cx="12" cy="12" fill="none" r={r} stroke="currentColor" strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} strokeLinecap="round" strokeWidth="2" />
			</svg>
			{seconds}
		</span>
	);
}

/** "123456" -> "123 456". */
export function spacedCode(code: string): string {
	return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

const MASK = "••••••••••••";

export function VaultDetailView({ item, audit, revealed, totp, copied, busy, error, onReveal, onHide, onCopy, onEdit, onDelete, onClose }: VaultDetailViewProps) {
	const isLogin = item.kind === "login";
	const shown = revealed !== null;
	const secretValue = isLogin ? revealed?.password : revealed?.value;
	return (
		<div className="flex min-w-0 flex-col gap-4" data-slot="vault-detail">
			<div className="flex min-w-0 items-center gap-3">
				<VaultLogo className="size-11" item={item} />
				<div className="flex min-w-0 flex-1 flex-col">
					<h3 className="m-0 truncate text-[15px] leading-5 font-semibold">{itemTitle(item)}</h3>
					<p className="m-0 truncate text-xs text-muted-foreground">
						{isLogin ? item.domain : item.description || "Segredo"} · <code className="font-mono">{isLogin ? `{{login:${item.name}.password}}` : `{{secret:${item.name}}}`}</code>
					</p>
				</div>
				{onClose ? (
					<Button aria-label="Fechar" onClick={onClose} size="icon-sm" type="button" variant="ghost">
						<XIcon />
					</Button>
				) : null}
			</div>

			<div className="flex flex-col gap-3.5" data-slot="vault-fields">
				{isLogin && item.siteUrl ? (
					<div className="flex min-w-0 flex-col gap-1.5">
						<span className={FIELD_LABEL}>Site</span>
						<a className="text-body underline-offset-2 [overflow-wrap:anywhere] hover:underline" href={item.siteUrl} rel="noreferrer noopener" target="_blank">
							{item.siteUrl}
						</a>
					</div>
				) : null}
				{isLogin ? (
					<ReadonlyField label="Usuário ou e-mail" value={item.username || "—"}>
						{item.username ? <CopyButton done={copied === "username"} label="usuário" onClick={() => onCopy("username")} /> : null}
					</ReadonlyField>
				) : null}
				<ReadonlyField label={isLogin ? "Senha" : "Valor"} mono value={shown ? (secretValue ?? "—") : MASK}>
					<InputGroupButton aria-label={shown ? "Ocultar" : "Revelar"} disabled={busy} onClick={shown ? onHide : onReveal} size="icon-xs" title={shown ? "Ocultar" : "Revelar (fica no histórico)"}>
						{shown ? <EyeOffIcon /> : <EyeIcon />}
					</InputGroupButton>
					<CopyButton done={copied === (isLogin ? "password" : "value")} label={isLogin ? "senha" : "valor"} onClick={() => onCopy(isLogin ? "password" : "value")} />
				</ReadonlyField>
				{isLogin && totp ? (
					<ReadonlyField label="Código 2FA" mono value={spacedCode(totp.code)}>
						<CountdownRing seconds={totp.expiresInSec} />
						<CopyButton done={copied === "totp"} label="código 2FA" onClick={() => onCopy("totp")} />
					</ReadonlyField>
				) : null}
				{shown && revealed?.notes ? (
					<div className="flex min-w-0 flex-col gap-1.5">
						<span className={FIELD_LABEL}>Observações</span>
						<span className="whitespace-pre-wrap text-body [overflow-wrap:anywhere]">{revealed.notes}</span>
					</div>
				) : null}
				{shown ? (revealed?.extras ?? []).map((extra) => <ReadonlyField key={extra.name} label={extra.name} mono={extra.secret} value={extra.value} />) : null}
				{!shown && isLogin ? <p className="m-0 text-xs text-muted-foreground">Observações e campos extras aparecem ao revelar.</p> : null}
			</div>

			{error ? (
				<p className="m-0 text-xs text-destructive" role="alert">
					{error}
				</p>
			) : null}

			<div>
				<h4 className="m-0 mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<ShieldCheckIcon aria-hidden className="size-3.5" />
					Histórico
				</h4>
				{audit.length === 0 ? (
					<p className="m-0 text-xs text-muted-foreground">Sem registros ainda.</p>
				) : (
					<ul className="m-0 flex max-h-40 list-none flex-col gap-1 overflow-y-auto p-0" data-slot="vault-audit">
						{audit.map((entry) => (
							<li className="flex items-baseline justify-between gap-3 text-xs" key={entry.id}>
								<span className="min-w-0 [overflow-wrap:anywhere]">{auditLabel(entry)}</span>
								<span className="shrink-0 text-muted-foreground">{formatVaultDate(entry.createdAt)}</span>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<Button onClick={onDelete} size="sm" type="button" variant="ghost">
					<Trash2Icon data-icon="inline-start" />
					Apagar
				</Button>
				<Button onClick={onEdit} size="sm" type="button" variant="outline">
					<PencilIcon data-icon="inline-start" />
					Editar
				</Button>
			</div>
		</div>
	);
}

// ----- formulário -----

export type VaultFormViewProps = {
	form: VaultForm;
	editing: boolean;
	errors: VaultFormErrors;
	saving?: boolean;
	saveError?: string | null;
	totpCheck?: { ok: boolean; message: string } | null;
	qrSupported?: boolean;
	onChange: (patch: Partial<VaultForm>) => void;
	onGenerate: () => void;
	onCheckTotp: () => void;
	onQr: (file: File) => void;
	onSave: () => void;
	onCancel: () => void;
};

export function VaultFormView({ form, editing, errors, saving, saveError, totpCheck, qrSupported, onChange, onGenerate, onCheckTotp, onQr, onSave, onCancel }: VaultFormViewProps) {
	const id = useId();
	const [showPassword, setShowPassword] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const isLogin = form.kind === "login";
	const strength = passwordStrength(isLogin ? form.password : form.value);
	return (
		<div className="flex min-w-0 flex-col gap-3.5" data-slot="vault-form">
			{isLogin ? (
				<>
					<div className="flex items-end gap-3">
						<VaultLogo className="size-10 shrink-0" item={{ kind: "login", label: form.label, name: form.name, siteUrl: form.siteUrl ? normalizeSiteUrl(form.siteUrl) : null }} />
						<div className="min-w-0 flex-1">
							<Field error={errors.siteUrl} htmlFor={`${id}-site`} label="Link do site">
								<Input autoComplete="off" id={`${id}-site`} inputMode="url" onChange={(event) => onChange({ siteUrl: event.target.value })} placeholder="github.com" spellCheck={false} value={form.siteUrl} />
							</Field>
						</div>
					</div>
					<Field htmlFor={`${id}-label`} label="Nome de exibição">
						<Input autoComplete="off" id={`${id}-label`} onChange={(event) => onChange({ label: event.target.value })} placeholder="GitHub" value={form.label} />
					</Field>
					<Field htmlFor={`${id}-user`} label="Usuário ou e-mail">
						<Input autoCapitalize="off" autoComplete="off" id={`${id}-user`} onChange={(event) => onChange({ username: event.target.value })} spellCheck={false} value={form.username} />
					</Field>
					<Field error={errors.password} hint={editing ? "Deixe em branco para manter a senha atual." : undefined} htmlFor={`${id}-pass`} label="Senha">
						<InputGroup>
							<InputGroupInput
								aria-invalid={errors.password ? true : undefined}
								autoComplete="new-password"
								className="font-mono"
								id={`${id}-pass`}
								onChange={(event) => onChange({ password: event.target.value })}
								spellCheck={false}
								type={showPassword ? "text" : "password"}
								value={form.password}
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupButton aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"} onClick={() => setShowPassword((v) => !v)} size="icon-xs">
									{showPassword ? <EyeOffIcon /> : <EyeIcon />}
								</InputGroupButton>
								<InputGroupButton
									onClick={() => {
										onGenerate();
										setShowPassword(true);
									}}
									size="xs"
									variant="outline"
								>
									<RefreshCwIcon data-icon="inline-start" />
									Gerar
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
						{form.password ? (
							<div className="mt-1 flex items-center gap-2" data-slot="vault-strength">
								<div className="flex flex-1 gap-1" aria-hidden>
									{[1, 2, 3, 4].map((step) => (
										<span className={cn("h-1 flex-1 rounded-full bg-muted", strength.score >= step && (strength.score >= 3 ? "bg-success" : strength.score === 2 ? "bg-warning" : "bg-destructive"))} key={step} />
									))}
								</div>
								<span className="w-14 text-right text-caption text-muted-foreground">{strength.label}</span>
							</div>
						) : null}
					</Field>
					<Field hint="Cole a chave (base32) ou o link otpauth:// do app autenticador. O código é gerado na hora." htmlFor={`${id}-totp`} label="Código 2FA (opcional)">
						<InputGroup>
							<InputGroupInput autoComplete="off" className="font-mono" id={`${id}-totp`} onChange={(event) => onChange({ totp: event.target.value })} placeholder={editing ? "Deixe em branco para manter" : "JBSWY3DPEHPK3PXP"} spellCheck={false} type="password" value={form.totp} />
							<InputGroupAddon align="inline-end">
								<InputGroupButton disabled={!form.totp.trim()} onClick={onCheckTotp} size="xs" variant="outline">
									Testar
								</InputGroupButton>
								{qrSupported ? (
									<>
										<input accept="image/*" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) onQr(file); event.target.value = ""; }} ref={fileRef} tabIndex={-1} type="file" />
										<InputGroupButton aria-label="Ler QR de uma imagem" onClick={() => fileRef.current?.click()} size="icon-xs" title="Ler QR de uma imagem">
											<QrCodeIcon />
										</InputGroupButton>
									</>
								) : null}
							</InputGroupAddon>
						</InputGroup>
						{totpCheck ? (
							<p className={cn("m-0 text-xs", totpCheck.ok ? "text-success" : "text-destructive")} role="status">
								{totpCheck.message}
							</p>
						) : null}
					</Field>
					<Field htmlFor={`${id}-notes`} label="Observações">
						<Textarea id={`${id}-notes`} onChange={(event) => onChange({ notes: event.target.value })} placeholder={editing ? "Deixe em branco para manter" : undefined} rows={2} value={form.notes} />
					</Field>
					<div className="flex flex-col gap-2">
						<span className={FIELD_LABEL}>Campos extras</span>
						{form.extras.map((extra, index) => (
							<div className="flex items-center gap-1.5" key={index}>
								<Input aria-label="Nome do campo" className="w-[32%]" onChange={(event) => onChange({ extras: form.extras.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)) })} placeholder="Nome" value={extra.name} />
								<Input aria-label="Valor do campo" className="min-w-0 flex-1" onChange={(event) => onChange({ extras: form.extras.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)) })} placeholder="Valor" type={extra.secret ? "password" : "text"} value={extra.value} />
								<Switch aria-label="Campo secreto" checked={extra.secret} onCheckedChange={(checked) => onChange({ extras: form.extras.map((item, i) => (i === index ? { ...item, secret: checked } : item)) })} title="Secreto" />
								<Button aria-label="Remover campo" onClick={() => onChange({ extras: form.extras.filter((_, i) => i !== index) })} size="icon-sm" type="button" variant="ghost">
									<XIcon />
								</Button>
							</div>
						))}
						{errors.extras ? (
							<p className="m-0 text-xs text-destructive" role="alert">
								{errors.extras}
							</p>
						) : null}
						<div>
							<Button onClick={() => onChange({ extras: [...form.extras, { name: "", value: "", secret: false }] })} size="sm" type="button" variant="ghost">
								<PlusIcon data-icon="inline-start" />
								Adicionar campo
							</Button>
						</div>
					</div>
				</>
			) : (
				<>
					<Field error={errors.value} htmlFor={`${id}-value`} hint={editing ? "Deixe em branco para manter o valor atual." : undefined} label="Valor">
						<InputGroup>
							<InputGroupInput aria-invalid={errors.value ? true : undefined} autoComplete="off" className="font-mono" id={`${id}-value`} onChange={(event) => onChange({ value: event.target.value })} spellCheck={false} type={showPassword ? "text" : "password"} value={form.value} />
							<InputGroupAddon align="inline-end">
								<InputGroupButton aria-label={showPassword ? "Ocultar valor" : "Mostrar valor"} onClick={() => setShowPassword((v) => !v)} size="icon-xs">
									{showPassword ? <EyeOffIcon /> : <EyeIcon />}
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
					</Field>
					<Field htmlFor={`${id}-desc`} label="Descrição">
						<Input autoComplete="off" id={`${id}-desc`} onChange={(event) => onChange({ description: event.target.value })} placeholder="Para que serve" value={form.description} />
					</Field>
				</>
			)}
			<Field error={errors.name} hint={`O bot usa ${isLogin ? `{{login:${form.name || "nome"}.password}}` : `{{secret:${form.name || "nome"}}}`}`} htmlFor={`${id}-name`} label="Nome para o bot">
				<Input aria-invalid={errors.name ? true : undefined} autoCapitalize="off" autoComplete="off" className="font-mono" id={`${id}-name`} onChange={(event) => onChange({ name: event.target.value })} spellCheck={false} value={form.name} />
			</Field>
			{saveError ? (
				<p className="m-0 text-xs text-destructive" role="alert">
					{saveError}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button disabled={saving} onClick={onCancel} size="sm" type="button" variant="ghost">
					Cancelar
				</Button>
				<Button disabled={saving} onClick={onSave} size="sm" type="button">
					{saving ? "Salvando…" : "Salvar"}
				</Button>
			</div>
		</div>
	);
}

// ----- container -----

type QrDetector = { detect: (image: ImageBitmap) => Promise<Array<{ rawValue: string }>> };
function qrDetector(): QrDetector | null {
	const Ctor = (globalThis as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => QrDetector }).BarcodeDetector;
	try {
		return Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
	} catch {
		return null;
	}
}

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

function errorText(cause: unknown): string {
	return cause instanceof Error && cause.message ? cause.message : "Não foi possível concluir. Tente novamente.";
}

export function VaultSettings({ isVisible }: { isVisible?: (itemId: string) => boolean }) {
	const isMobile = useIsMobile();
	const [items, setItems] = useState<VaultItemView[]>([]);
	const [available, setAvailable] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<VaultFilter>("all");

	const [detailId, setDetailId] = useState<string | null>(null);
	const [detail, setDetail] = useState<{ item: VaultItemView; audit: VaultAuditEntry[] } | null>(null);
	const [revealed, setRevealed] = useState<VaultPayloadView | null>(null);
	const [totp, setTotp] = useState<{ code: string; expiresInSec: number } | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirmReveal, setConfirmReveal] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const [formState, setFormState] = useState<{ form: VaultForm; editingId: string | null } | null>(null);
	const [formErrors, setFormErrors] = useState<VaultFormErrors>({});
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [totpCheck, setTotpCheck] = useState<{ ok: boolean; message: string } | null>(null);
	const qrSupported = useMemo(() => (typeof window === "undefined" ? false : qrDetector() !== null), []);

	const reload = useCallback(async () => {
		try {
			const data = await listVault();
			setItems(data.items);
			setAvailable(data.available);
			setError(null);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);

	const openDetail = useCallback(async (id: string) => {
		setDetailId(id);
		setDetail(null);
		setRevealed(null);
		setTotp(null);
		setDetailError(null);
		try {
			setDetail(await getVaultItem(id));
		} catch (cause) {
			setDetailError(errorText(cause));
		}
	}, []);

	const closeDetail = () => {
		setDetailId(null);
		setDetail(null);
		setRevealed(null);
		setTotp(null);
		void reload();
	};

	// Código 2FA vivo: busca e renova quando expira.
	useEffect(() => {
		if (!detail || detail.item.kind !== "login") return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = async () => {
			try {
				const next = await getVaultTotp(detail.item.id);
				if (cancelled) return;
				setTotp(next);
				timer = setTimeout(() => void tick(), Math.max(1, next.expiresInSec) * 1000);
			} catch {
				if (!cancelled) setTotp(null);
			}
		};
		void tick();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [detail]);

	// Contagem regressiva do código sem nova chamada.
	useEffect(() => {
		if (!totp) return;
		const interval = setInterval(() => setTotp((current) => (current ? { ...current, expiresInSec: Math.max(0, current.expiresInSec - 1) } : current)), 1000);
		return () => clearInterval(interval);
	}, [totp?.code]);

	async function reveal() {
		if (!detail) return;
		setBusy(true);
		setDetailError(null);
		try {
			setRevealed(await revealVaultItem(detail.item.id));
			setDetail(await getVaultItem(detail.item.id));
		} catch (cause) {
			setDetailError(errorText(cause));
		} finally {
			setBusy(false);
		}
	}

	async function copy(what: string) {
		if (!detail) return;
		setDetailError(null);
		try {
			let text: string | undefined;
			if (what === "username") {
				text = detail.item.username ?? undefined;
				void recordVaultCopy(detail.item.id, "usuário");
			} else if (what === "totp") {
				text = (await getVaultTotp(detail.item.id)).code;
				void recordVaultCopy(detail.item.id, "código 2FA");
			} else {
				const payload = await revealVaultItem(detail.item.id, what === "password" ? "senha" : "valor");
				text = what === "password" ? payload.password : payload.value;
			}
			if (text && (await copyText(text))) {
				setCopied(what);
				setTimeout(() => setCopied((current) => (current === what ? null : current)), 1800);
			} else {
				setDetailError("Não consegui copiar. Revele e copie à mão.");
			}
		} catch (cause) {
			setDetailError(errorText(cause));
		}
	}

	// Atalho do card de login ("Salvar um login no Cofre"): abre o formulário com o site já preenchido.
	useEffect(() => {
		try {
			const url = new URL(window.location.href);
			const site = url.searchParams.get(VAULT_NEW_LOGIN_PARAM);
			if (!site) return;
			url.searchParams.delete(VAULT_NEW_LOGIN_PARAM);
			window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
			setFormState({ form: { ...emptyVaultForm("login"), siteUrl: site, name: suggestLoginName(site) }, editingId: null });
		} catch {
			// sem URL: abre vazio pelo botão normal
		}
	}, []);

	function startForm(kind: VaultItemKind) {
		setFormState({ form: emptyVaultForm(kind), editingId: null });
		setFormErrors({});
		setSaveError(null);
		setTotpCheck(null);
	}

	function startEdit() {
		if (!detail) return;
		setFormState({ form: formFromItem(detail.item), editingId: detail.item.id });
		setFormErrors({});
		setSaveError(null);
		setTotpCheck(null);
	}

	async function save() {
		if (!formState) return;
		const editing = formState.editingId !== null;
		const checked = validateVaultForm(formState.form, editing);
		setFormErrors(checked.ok ? {} : checked.errors);
		setSaveError(null);
		if (!checked.ok) return;
		setSaving(true);
		try {
			const input = formToInput(formState.form, editing);
			const saved = editing ? await updateVaultItem(formState.editingId!, input) : await createVaultItem(input);
			setFormState(null);
			await reload();
			if (editing) await openDetail(saved.id);
		} catch (cause) {
			setSaveError(errorText(cause));
		} finally {
			setSaving(false);
		}
	}

	async function checkTotp() {
		const result = await previewTotp(formState?.form.totp ?? "");
		setTotpCheck(result.ok ? { ok: true, message: `Funciona. Código agora: ${result.code}` } : { ok: false, message: result.error ?? "Chave inválida." });
	}

	async function readQr(file: File) {
		const detector = qrDetector();
		if (!detector) return;
		try {
			const bitmap = await createImageBitmap(file);
			const [found] = await detector.detect(bitmap);
			if (found?.rawValue) {
				setFormState((state) => (state ? { ...state, form: { ...state.form, totp: found.rawValue } } : state));
				setTotpCheck({ ok: true, message: "QR lido. Toque em Testar para conferir." });
			} else {
				setTotpCheck({ ok: false, message: "Não achei um QR nessa imagem." });
			}
		} catch {
			setTotpCheck({ ok: false, message: "Não consegui ler a imagem." });
		}
	}

	async function remove() {
		if (!detail) return;
		setConfirmDelete(false);
		try {
			await deleteVaultItem(detail.item.id);
			closeDetail();
		} catch (cause) {
			setDetailError(errorText(cause));
		}
	}

	if (isVisible && !isVisible("cofre.lista")) return null;

	const detailNode = detail ? (
		<VaultDetailView
			audit={detail.audit}
			busy={busy}
			copied={copied}
			error={detailError}
			item={detail.item}
			onClose={isMobile ? undefined : closeDetail}
			onCopy={(what) => void copy(what)}
			onDelete={() => setConfirmDelete(true)}
			onEdit={startEdit}
			onHide={() => setRevealed(null)}
			onReveal={() => setConfirmReveal(true)}
			revealed={revealed}
			totp={totp}
		/>
	) : (
		<p className="m-0 text-xs text-muted-foreground" role={detailError ? "alert" : "status"}>
			{detailError ?? "Carregando…"}
		</p>
	);
	const formNode = formState ? (
		<VaultFormView
			editing={formState.editingId !== null}
			errors={formErrors}
			form={formState.form}
			onCancel={() => setFormState(null)}
			onChange={(patch) => setFormState((state) => (state ? { ...state, form: withSuggestedName(state.form, patch) } : state))}
			onCheckTotp={() => void checkTotp()}
			onGenerate={() => setFormState((state) => (state ? { ...state, form: { ...state.form, password: generatePassword() } } : state))}
			onQr={(file) => void readQr(file)}
			onSave={() => void save()}
			qrSupported={qrSupported}
			saveError={saveError}
			saving={saving}
			totpCheck={totpCheck}
		/>
	) : null;
	const formTitle = formState?.editingId ? "Editar" : formState?.form.kind === "login" ? "Novo login de site" : "Novo segredo";

	// No celular, detalhe e formulário são páginas internas (← e título como as outras subpáginas), não diálogos.
	const dialogs = (
		<>
			<AlertDialog onOpenChange={setConfirmReveal} open={confirmReveal}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Mostrar o valor?</AlertDialogTitle>
						<AlertDialogDescription>Fica registrado no histórico do item. Revele só se ninguém estiver olhando a sua tela.</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancelar</AlertDialogCancel>
						<AlertDialogAction onClick={() => void reveal()}>Mostrar</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog onOpenChange={setConfirmDelete} open={confirmDelete}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Apagar do cofre?</AlertDialogTitle>
						<AlertDialogDescription>O valor é apagado e não dá para recuperar. Bots que usam {detail ? itemTitle(detail.item) : "este item"} vão precisar pedir de novo.</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancelar</AlertDialogCancel>
						<AlertDialogAction onClick={() => void remove()} variant="destructive">
							Apagar
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);

	if (isMobile && (formState !== null || detailId !== null)) {
		const inForm = formState !== null;
		return (
			<>
				<div className="fixed inset-0 z-50 bg-background" data-slot="vault-page">
					<SettingsPage
						backLabel={inForm ? "Voltar" : "Voltar ao cofre"}
						onBack={() => (inForm ? setFormState(null) : closeDetail())}
						title={inForm ? formTitle : detail ? itemTitle(detail.item) : "Cofre"}
					>
						{inForm ? <div className="pb-6">{formNode}</div> : <div className="pb-6">{detailNode}</div>}
					</SettingsPage>
				</div>
				{dialogs}
			</>
		);
	}


	return (
		<>
			<VaultListView
				available={available}
				error={error}
				filter={filter}
				items={items}
				loading={loading}
				onAdd={startForm}
				onFilter={setFilter}
				onOpen={(id) => void openDetail(id)}
				onQuery={setQuery}
				query={query}
			/>

			<Dialog onOpenChange={(open) => !open && closeDetail()} open={!isMobile && detailId !== null && formState === null}>
				<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" showCloseButton={false}>
					<DialogHeader className="sr-only">
						<DialogTitle>Item do cofre</DialogTitle>
						<DialogDescription>Detalhes, histórico e ações do item.</DialogDescription>
					</DialogHeader>
					{detailNode}
				</DialogContent>
			</Dialog>

			<Dialog onOpenChange={(open) => !open && !saving && setFormState(null)} open={!isMobile && formState !== null}>
				<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{formTitle}</DialogTitle>
						<DialogDescription>Criptografado só para você. O bot nunca vê o valor.</DialogDescription>
					</DialogHeader>
					{formNode}
					<DialogFooter className="sr-only" />
				</DialogContent>
			</Dialog>

			{dialogs}
		</>
	);
}
