"use client";

import { ShoppingCartIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { CvvField, type CvvFieldHandle } from "@workspace/ui/components/cvv-field";
import { RequestCard } from "@workspace/ui/components/request-card";
import { AtlasApiError, respondAgentV4Request } from "@/lib/atlas-api";
import { useTranslations } from "@/lib/i18n/provider";
import { formatMoney, purchaseSendErrorKey, type PurchaseFacts, type PurchaseRequest } from "./purchase-facts";

export type PurchaseStatus = "pending" | "sending" | "approved" | "dismissed" | "expired";

export type PurchaseApprovalCardViewProps = {
	facts: PurchaseFacts;
	inputOnly?: boolean;
	status?: PurchaseStatus;
	error?: string | null;
	/** Chamado com o CVV lido do campo; o campo já foi apagado quando isto roda. */
	onApprove: (cvv: string) => void;
	onDismiss: () => void;
	/** Teste e prévia: começa com o campo preenchido? Nunca (o valor não vem por prop). */
	cvvHandleRef?: React.Ref<CvvFieldHandle>;
};

/**
 * Cartão de aprovação de COMPRA: loja, itens, frete, total e o final do cartão, com o campo de CVV (componente seguro, o
 * valor nunca passa por estado). Com mandato (`inputOnly`) o cartão só pede o código. É o cartão mínimo desta frente; ver
 * `docs/features/compras.md` para encaixá-lo no cartão de aprovação geral do v4.
 */
export function PurchaseApprovalCardView({ facts, inputOnly = false, status = "pending", error, onApprove, onDismiss, cvvHandleRef }: PurchaseApprovalCardViewProps) {
	const { t, locale } = useTranslations();
	const handle = useRef<CvvFieldHandle>(null);
	const [valid, setValid] = useState(false);
	const [touched, setTouched] = useState(false);
	const resolved = status !== "pending" && status !== "sending";
	const sending = status === "sending";
	const total = formatMoney(facts.amount, facts.currency, locale);

	const submit = () => {
		const cvv = handle.current?.read() ?? "";
		if (cvv.length !== 3 && cvv.length !== 4) {
			setTouched(true);
			return;
		}
		setTouched(false);
		// O campo é apagado ANTES de enviar: o valor só existe nesta variável local, durante a chamada.
		handle.current?.clear();
		onApprove(cvv);
	};

	const badge =
		status === "approved" ? { tone: "success" as const, label: t("payments.purchase.badgeApproved") }
		: status === "dismissed" ? { tone: "muted" as const, label: t("payments.purchase.badgeDismissed") }
		: status === "expired" ? { tone: "muted" as const, label: t("payments.purchase.badgeExpired") }
		: { tone: "pending" as const, label: t("payments.purchase.badgePending") };
	const note = status === "approved" ? t("payments.purchase.noteApproved") : status === "dismissed" ? t("payments.purchase.noteDismissed") : status === "expired" ? t("payments.purchase.noteExpired") : undefined;

	return (
		<RequestCard
			actions={
				<Button disabled={sending || !valid} onClick={submit} size="sm" type="button">
					{sending ? t("payments.purchase.sending") : inputOnly ? t("payments.purchase.approveCvvOnly") : t("payments.purchase.approve", { total })}
				</Button>
			}
			badge={badge}
			data-purchase-card={facts.store}
			description={inputOnly ? t("payments.purchase.descriptionCvvOnly") : t("payments.purchase.description", { store: facts.store })}
			detailsLabel={t("payments.purchase.items")}
			error={error ?? undefined}
			leading={<ShoppingCartIcon aria-hidden className="size-4" />}
			note={note}
			resolved={resolved}
			title={inputOnly ? t("payments.purchase.titleCvvOnly") : t("payments.purchase.title")}
			trailing={
				<Button disabled={sending} onClick={onDismiss} size="sm" type="button" variant="ghost">
					{t("payments.purchase.dismiss")}
				</Button>
			}
		>
			<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body" data-slot="purchase-facts">
				{facts.items.length > 0 ? (
					<>
						<dt className="text-muted-foreground">{t("payments.purchase.items")}</dt>
						<dd className="m-0 min-w-0">
							<ul className="m-0 list-none p-0">
								{facts.items.map((item) => (
									<li className="[overflow-wrap:anywhere]" key={item}>
										{item}
									</li>
								))}
							</ul>
						</dd>
					</>
				) : null}
				{facts.shipping !== null ? (
					<>
						<dt className="text-muted-foreground">{t("payments.purchase.shipping")}</dt>
						<dd className="m-0">{facts.shipping === 0 ? t("payments.purchase.free") : formatMoney(facts.shipping, facts.currency, locale)}</dd>
					</>
				) : null}
				<dt className="font-medium">{t("payments.purchase.total")}</dt>
				<dd className="m-0 font-semibold" data-purchase-total>
					{total}
				</dd>
				{facts.card ? (
					<>
						<dt className="text-muted-foreground">{t("payments.purchase.card")}</dt>
						<dd className="m-0">{facts.card}</dd>
					</>
				) : null}
			</dl>
			{!resolved ? (
				<CvvField
					disabled={sending}
					error={touched && !valid ? t("payments.purchase.cvvInvalid") : undefined}
					handleRef={(node) => {
						handle.current = node;
						if (typeof cvvHandleRef === "function") cvvHandleRef(node);
						else if (cvvHandleRef) (cvvHandleRef as React.MutableRefObject<CvvFieldHandle | null>).current = node;
					}}
					hint={t("payments.purchase.cvvHint")}
					label={t("payments.purchase.cvvLabel")}
					onSubmit={submit}
					onValidityChange={setValid}
				/>
			) : null}
		</RequestCard>
	);
}

/** Cartão de compra ligado à API: aprova com o CVV (só no corpo da chamada) ou dispensa. */
export function PurchaseApprovalCard({ request, initialStatus = "pending" }: { request: PurchaseRequest; initialStatus?: PurchaseStatus }) {
	const { t } = useTranslations();
	const [status, setStatus] = useState<PurchaseStatus>(initialStatus);
	const [error, setError] = useState<string | null>(null);

	const send = async (decision: "approve" | "deny", cvv?: string) => {
		setStatus("sending");
		setError(null);
		try {
			await respondAgentV4Request({ runId: request.runId, key: request.requestId, decision, ...(cvv !== undefined && { cvv }) });
			setStatus(decision === "approve" ? "approved" : "dismissed");
		} catch (cause) {
			if (cause instanceof AtlasApiError && cause.status === 410) setStatus("expired");
			else {
				setStatus("pending");
				setError(t(purchaseSendErrorKey(cause)));
			}
		}
	};

	return <PurchaseApprovalCardView error={error} facts={request.facts} inputOnly={request.inputOnly} onApprove={(cvv) => void send("approve", cvv)} onDismiss={() => void send("deny")} status={status} />;
}
