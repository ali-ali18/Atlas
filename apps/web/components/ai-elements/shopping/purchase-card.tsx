"use client";

import { ExternalLinkIcon, ReceiptTextIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import { ChatCard, ChatCardActions, ChatCardHeader } from "@workspace/ui/components/chat-card";
import type { PurchaseItem } from "@workspace/shared";

import { useFormat } from "@/lib/use-format";
import { useTranslations } from "@/lib/i18n/provider";

import { safeHttpUrl } from "./safe-image";

export type PurchaseCardData = {
	merchant: string;
	items: readonly PurchaseItem[];
	total: number;
	currency: string;
	purchasedAt: string;
	orderNumber?: string;
	trackingCode?: string;
	trackingUrl?: string;
};

const ITEMS_SHOWN = 4;

/** Compra registrada: o que o bot guardou (loja, itens, total pago, pedido, rastreio). Só mostra, não age. */
export function PurchaseCard({ merchant, items, total, currency, purchasedAt, orderNumber, trackingCode, trackingUrl }: PurchaseCardData) {
	const t = useTranslations();
	const f = useFormat();
	const href = safeHttpUrl(trackingUrl);
	const shown = items.slice(0, ITEMS_SHOWN);
	const hidden = items.length - shown.length;
	return (
		<ChatCard data-testid="purchase-card" variant="card">
			<ChatCardHeader badge={{ tone: "success", label: t.t("shopping.purchase.title") }} leading={<ReceiptTextIcon />} title={merchant} />
			<ul className="m-0 flex list-none flex-col gap-1 p-0 text-body">
				{shown.map((item, index) => (
					<li className="flex min-w-0 items-baseline gap-2" key={`${index}-${item.name}`}>
						<span className="shrink-0 text-muted-foreground tabular-nums">{t.t("shopping.purchase.quantity", { count: item.quantity })}</span>
						<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.name}</span>
						{item.unitPrice !== undefined ? <span className="shrink-0 text-muted-foreground tabular-nums">{f.currency(item.unitPrice, currency)}</span> : null}
					</li>
				))}
				{hidden > 0 ? <li className="text-caption text-muted-foreground">{t.t("shopping.purchase.itemsMore", { count: hidden })}</li> : null}
			</ul>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<span className="text-caption text-muted-foreground">{f.date(purchasedAt)}</span>
				<span className="text-lg leading-6 font-semibold tabular-nums" data-testid="purchase-total">{f.currency(total, currency)}</span>
			</div>
			{orderNumber || trackingCode ? (
				<p className="m-0 flex flex-wrap gap-x-3 text-caption text-muted-foreground">
					{orderNumber ? <span>{t.t("shopping.purchase.order", { number: orderNumber })}</span> : null}
					{trackingCode ? <span>{t.t("shopping.purchase.tracking", { code: trackingCode })}</span> : null}
				</p>
			) : null}
			{href ? (
				<ChatCardActions>
					<Button nativeButton={false} render={<a href={href} rel="noopener noreferrer" target="_blank" />} size="sm" variant="secondary">
						{t.t("shopping.purchase.trackOrder")}
						<ExternalLinkIcon aria-hidden />
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
}
