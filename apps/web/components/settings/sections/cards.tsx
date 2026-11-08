"use client";

import { CreditCardIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@workspace/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Spinner } from "@workspace/ui/components/spinner";
import { CARD_BRAND_LABELS, type CardBrand, type SavedCardView } from "@workspace/shared";
import { DeletableRow } from "@/components/ui/templates/template-4/chat-context-panel/deletable-row";
import { AtlasApiError, createSavedCard, deleteSavedCard, listSavedCards } from "@/lib/atlas-api";
import { useT } from "@/lib/i18n/provider";
import { emptyCardForm, formatCardNumberInput, formatExpiryInput, validateCardForm, type CardErrorKey, type CardForm, type CardFormErrors } from "../cards-state";
import { SettingsGroup, SettingsStack } from "../setting-row";

const FIELD_LABEL = "text-body font-medium";

function Field({ label, error, htmlFor, children }: { label: string; error?: string; htmlFor?: string; children: ReactNode }) {
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
			) : null}
		</div>
	);
}

const brandLabel = (brand: CardBrand | string): string => CARD_BRAND_LABELS[brand as CardBrand] ?? CARD_BRAND_LABELS.unknown;

export type CardsListViewProps = {
	cards: SavedCardView[];
	configured: boolean;
	loading?: boolean;
	error?: string | null;
	busyId?: string | null;
	onAdd: () => void;
	onDelete: (id: string) => void;
};

/** Lista de cartões: só apelido, bandeira e final. Nunca número, nome, validade nem endereço. */
export function CardsListView({ cards, configured, loading, error, busyId, onAdd, onDelete }: CardsListViewProps) {
	const t = useT();
	return (
		<SettingsStack>
			<section className="flex flex-col gap-3" data-slot="cards-list">
				<div className="flex items-center justify-between gap-2 px-2">
					<h3 className="m-0 text-body font-semibold">{t("payments.cards.title")}</h3>
					<Button disabled={!configured} onClick={onAdd} size="sm" type="button">
						<PlusIcon data-icon="inline-start" />
						{t("payments.cards.add")}
					</Button>
				</div>
				<p className="m-0 px-2 text-body leading-5 text-muted-foreground">{t("payments.cards.intro")}</p>
				{!configured ? (
					<p className="m-0 rounded-xl border border-border/60 px-3 py-2.5 text-xs text-muted-foreground" role="status">
						{t("payments.cards.unavailable")}
					</p>
				) : null}
				{error ? (
					<p className="m-0 text-xs text-destructive" role="alert">
						{error}
					</p>
				) : null}
				{loading && cards.length === 0 ? <Spinner className="mx-2" label={t("common.loading")} /> : null}
				{!loading && configured && cards.length === 0 ? (
					<div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-border/60 px-4 py-8 text-center">
						<CreditCardIcon aria-hidden className="size-5 text-muted-foreground" />
						<p className="m-0 text-body font-medium">{t("payments.cards.empty")}</p>
					</div>
				) : null}
				{cards.length > 0 ? (
					<SettingsGroup>
						<ul className="m-0 flex list-none flex-col gap-2 p-2">
							{cards.map((card) => {
								const name = `${brandLabel(card.brand)} ${t("payments.cards.endsIn", { last4: card.last4 })}`;
								return (
									<DeletableRow
										busy={busyId === card.id}
										cancelLabel={t("payments.cards.removeCancel")}
										confirmBody={t("payments.cards.removeBody", { name })}
										confirmLabel={t("payments.cards.removeConfirm")}
										confirmTitle={t("payments.cards.removeTitle")}
										deleteLabel={t("payments.cards.remove", { name })}
										key={card.id}
										onDelete={() => onDelete(card.id)}
										rowData={{ "data-card-id": card.id }}
										rowId={card.id}
									>
										<div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
											<CreditCardIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="truncate text-body leading-[18px] font-medium">{card.label}</span>
												{name !== card.label ? <span className="truncate text-xs text-muted-foreground">{name}</span> : null}
											</span>
										</div>
									</DeletableRow>
								);
							})}
						</ul>
					</SettingsGroup>
				) : null}
			</section>
		</SettingsStack>
	);
}

export type CardFormViewProps = {
	form: CardForm;
	errors: CardFormErrors;
	saving: boolean;
	saveError: string | null;
	onChange: (patch: Partial<CardForm>) => void;
	onSave: () => void;
	onCancel: () => void;
};

/** Formulário do cartão. Sem campo de CVV de propósito. */
export function CardFormView({ form, errors, saving, saveError, onChange, onSave, onCancel }: CardFormViewProps) {
	const t = useT();
	const id = useId();
	const err = (key: CardErrorKey | undefined) => (key ? t(key) : undefined);
	return (
		<form
			className="flex min-w-0 flex-col gap-3.5"
			data-slot="card-form"
			onSubmit={(event) => {
				event.preventDefault();
				onSave();
			}}
		>
			<Field error={err(errors.number)} htmlFor={`${id}-number`} label={t("payments.cards.number")}>
				<Input autoComplete="cc-number" className="font-mono" id={`${id}-number`} inputMode="numeric" onChange={(event) => onChange({ number: formatCardNumberInput(event.target.value) })} placeholder="0000 0000 0000 0000" spellCheck={false} value={form.number} />
			</Field>
			<Field error={err(errors.holder)} htmlFor={`${id}-holder`} label={t("payments.cards.holder")}>
				<Input autoComplete="cc-name" id={`${id}-holder`} onChange={(event) => onChange({ holder: event.target.value })} value={form.holder} />
			</Field>
			<div className="grid grid-cols-2 gap-3">
				<Field error={err(errors.expiry)} htmlFor={`${id}-expiry`} label={t("payments.cards.expiry")}>
					<Input autoComplete="cc-exp" id={`${id}-expiry`} inputMode="numeric" onChange={(event) => onChange({ expiry: formatExpiryInput(event.target.value) })} placeholder="MM/AA" value={form.expiry} />
				</Field>
				<Field htmlFor={`${id}-label`} label={t("payments.cards.label")}>
					<Input autoComplete="off" id={`${id}-label`} onChange={(event) => onChange({ label: event.target.value })} value={form.label} />
				</Field>
			</div>
			<fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
				<legend className={`${FIELD_LABEL} mb-1.5 p-0`}>{t("payments.cards.billing")}</legend>
				{errors.billing ? (
					<p className="m-0 text-xs text-destructive" role="alert">
						{t(errors.billing)}
					</p>
				) : null}
				<Input aria-label={t("payments.cards.line1")} autoComplete="billing address-line1" onChange={(event) => onChange({ line1: event.target.value })} placeholder={t("payments.cards.line1")} value={form.line1} />
				<Input aria-label={t("payments.cards.line2")} autoComplete="billing address-line2" onChange={(event) => onChange({ line2: event.target.value })} placeholder={t("payments.cards.line2")} value={form.line2} />
				<div className="grid grid-cols-2 gap-3">
					<Input aria-label={t("payments.cards.city")} autoComplete="billing address-level2" onChange={(event) => onChange({ city: event.target.value })} placeholder={t("payments.cards.city")} value={form.city} />
					<Input aria-label={t("payments.cards.state")} autoComplete="billing address-level1" onChange={(event) => onChange({ state: event.target.value })} placeholder={t("payments.cards.state")} value={form.state} />
					<Input aria-label={t("payments.cards.postalCode")} autoComplete="billing postal-code" onChange={(event) => onChange({ postalCode: event.target.value })} placeholder={t("payments.cards.postalCode")} value={form.postalCode} />
					<Input aria-label={t("payments.cards.country")} autoComplete="billing country" maxLength={2} onChange={(event) => onChange({ country: event.target.value.toUpperCase() })} placeholder={t("payments.cards.country")} value={form.country} />
				</div>
			</fieldset>
			{saveError ? (
				<p className="m-0 text-xs text-destructive" role="alert">
					{saveError}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button disabled={saving} onClick={onCancel} type="button" variant="ghost">
					{t("payments.cards.cancel")}
				</Button>
				<Button disabled={saving} type="submit">
					{saving ? t("payments.cards.saving") : t("payments.cards.save")}
				</Button>
			</div>
		</form>
	);
}

type SaveErrorKey = "payments.cards.errorSave" | "payments.cards.errorLimit" | "payments.cards.errorUnavailable";
const SERVER_ERRORS: Record<string, SaveErrorKey> = { card_limit: "payments.cards.errorLimit", card_vault_unavailable: "payments.cards.errorUnavailable" };

function saveErrorKey(cause: unknown): SaveErrorKey {
	const code = cause instanceof AtlasApiError ? (cause.details as { error?: string } | undefined)?.error : undefined;
	return (code && SERVER_ERRORS[code]) || "payments.cards.errorSave";
}

/** Cartões de compra (dentro de Configurações › Cofre). Só o dono; a API devolve apenas apelido, bandeira e final. */
export function CardsSettings({ isVisible }: { isVisible?: (itemId: string) => boolean }) {
	const t = useT();
	const [cards, setCards] = useState<SavedCardView[]>([]);
	const [configured, setConfigured] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [form, setForm] = useState<CardForm | null>(null);
	const [errors, setErrors] = useState<CardFormErrors>({});
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const data = await listSavedCards();
			setCards(data.cards);
			setConfigured(data.configured);
			setError(null);
		} catch {
			setError(t("payments.cards.loadError"));
		} finally {
			setLoading(false);
		}
	}, [t]);
	useEffect(() => {
		void reload();
	}, [reload]);

	// Fechar o formulário apaga o que foi digitado (número e nome não ficam em memória da tela).
	const closeForm = () => {
		setForm(null);
		setErrors({});
		setSaveError(null);
	};

	const save = async () => {
		if (!form) return;
		const checked = validateCardForm(form, new Date());
		if (!checked.ok) {
			setErrors(checked.errors);
			return;
		}
		setErrors({});
		setSaving(true);
		setSaveError(null);
		try {
			await createSavedCard(checked.input);
			closeForm();
			await reload();
		} catch (cause) {
			setSaveError(t(saveErrorKey(cause)));
		} finally {
			setSaving(false);
		}
	};

	const remove = async (id: string) => {
		setBusyId(id);
		try {
			await deleteSavedCard(id);
			await reload();
		} catch {
			setError(t("payments.cards.loadError"));
		} finally {
			setBusyId(null);
		}
	};

	if (isVisible && !isVisible("cartoes.lista")) return null;
	return (
		<>
			<CardsListView busyId={busyId} cards={cards} configured={configured} error={error} loading={loading} onAdd={() => setForm(emptyCardForm())} onDelete={(id) => void remove(id)} />
			<Dialog onOpenChange={(open) => !open && !saving && closeForm()} open={form !== null}>
				<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{t("payments.cards.formTitle")}</DialogTitle>
						<DialogDescription>{t("payments.cards.formBody")}</DialogDescription>
					</DialogHeader>
					{form ? <CardFormView errors={errors} form={form} onCancel={closeForm} onChange={(patch) => setForm((current) => (current ? { ...current, ...patch } : current))} onSave={() => void save()} saveError={saveError} saving={saving} /> : null}
					<DialogFooter className="sr-only" />
				</DialogContent>
			</Dialog>
		</>
	);
}
