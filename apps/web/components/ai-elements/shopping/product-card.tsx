"use client";

import { ExternalLinkIcon, PackageIcon, StarIcon, StoreIcon } from "lucide-react";
import * as React from "react";

import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { ChatCard, ChatCardActions, ChatCardHeader } from "@workspace/ui/components/chat-card";
import { cn } from "@workspace/ui/lib/utils";
import { discountPercent, type ProductOffer } from "@workspace/shared";

import { useFormat } from "@/lib/use-format";
import { useTranslations } from "@/lib/i18n/provider";

import { SafeImage, safeHttpUrl } from "./safe-image";

export type ProductCardData = { items: readonly ProductOffer[]; cheapestUrl?: string; incomplete?: boolean };

type Translator = ReturnType<typeof useTranslations>;
type Format = ReturnType<typeof useFormat>;

const money = (f: Format, value: number, currency: string | null) => (currency ? f.currency(value, currency) : f.number(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function shippingText(o: ProductOffer, t: Translator, f: Format): string {
	if (o.shipping.kind === "free") return t.t("shopping.product.shippingFree");
	if (o.shipping.kind === "paid") return t.t("shopping.product.shippingPaid", { amount: money(f, o.shipping.amount, o.currency) });
	if (o.shipping.kind === "unavailable") return t.t("shopping.product.shippingUnavailable");
	return t.t("shopping.product.shippingUnknown");
}

function totalText(o: ProductOffer, t: Translator, f: Format): string {
	return o.total === null ? t.t("shopping.product.totalUnknown") : t.t("shopping.product.total", { amount: money(f, o.total, o.currency) });
}

const AVAILABILITY_KEY = { in_stock: "shopping.product.inStock", out_of_stock: "shopping.product.outOfStock", preorder: "shopping.product.preorder", limited: "shopping.product.limited" } as const;

function Rating({ offer, t, f }: { offer: ProductOffer; t: Translator; f: Format }) {
	if (!offer.rating) return null;
	const { value, best, count } = offer.rating;
	return (
		<span className="inline-flex items-center gap-1 text-caption text-muted-foreground" data-testid="product-rating" title={t.t("shopping.product.rating", { value: f.number(value, { maximumFractionDigits: 1 }), best })}>
			<StarIcon aria-hidden className="size-3 fill-current" />
			<span>{f.number(value, { maximumFractionDigits: 1 })}</span>
			{count ? <span>({t.tn("shopping.product.ratingCount", count, { total: f.number(count) })})</span> : null}
		</span>
	);
}

function PriceBlock({ offer, t, f }: { offer: ProductOffer; t: Translator; f: Format }) {
	const discount = discountPercent(offer);
	return (
		<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
			{offer.price === null ? (
				<span className="text-body text-muted-foreground">{t.t("shopping.product.priceMissing")}</span>
			) : (
				<span className="text-lg leading-6 font-semibold tabular-nums" data-testid="product-price">{money(f, offer.price, offer.currency)}</span>
			)}
			{offer.oldPrice !== undefined ? <s className="text-caption text-muted-foreground tabular-nums" data-testid="product-old-price">{t.t("shopping.product.wasPrice", { price: money(f, offer.oldPrice, offer.currency) })}</s> : null}
			{discount !== null ? <Badge variant="success">{t.t("shopping.product.discount", { percent: discount })}</Badge> : null}
		</div>
	);
}

function Gallery({ offer, t }: { offer: ProductOffer; t: Translator }) {
	const [index, setIndex] = React.useState(0);
	const images = offer.images;
	const current = images[Math.min(index, Math.max(images.length - 1, 0))];
	return (
		<div className="flex min-w-0 flex-col gap-1.5" data-testid="product-gallery">
			<SafeImage alt={t.t("shopping.product.photoOf", { name: offer.name })} className="aspect-[4/3] max-h-72 w-full rounded-card bg-foreground/[0.06] object-contain" fallbackLabel={t.t("shopping.product.photoUnavailable")} src={current} />
			{images.length > 1 ? (
				<div className="flex gap-1.5 overflow-x-auto">
					{images.map((src, i) => (
						<button
							aria-current={i === index}
							aria-label={t.t("shopping.product.photoN", { n: i + 1, name: offer.name })}
							className={cn("size-10 shrink-0 overflow-hidden rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/30", i === index ? "ring-2 ring-foreground/40" : "opacity-70 hover:opacity-100")}
							key={src}
							onClick={() => setIndex(i)}
							type="button"
						>
							<SafeImage alt="" className="size-full" fallbackLabel={t.t("shopping.product.photoUnavailable")} src={src} />
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

function StoreLink({ offer, t }: { offer: ProductOffer; t: Translator }) {
	const href = safeHttpUrl(offer.url);
	if (!href) return null;
	return (
		<Button aria-label={t.t("shopping.product.viewInStoreAria", { name: offer.name, store: offer.merchant })} nativeButton={false} render={<a href={href} rel="noopener noreferrer" target="_blank" />} size="sm" variant="secondary">
			{t.t("shopping.product.viewInStore")}
			<ExternalLinkIcon aria-hidden />
		</Button>
	);
}

function SingleProduct({ offer }: { offer: ProductOffer }) {
	const t = useTranslations();
	const f = useFormat();
	const availability = offer.availability === "unknown" ? null : AVAILABILITY_KEY[offer.availability];
	return (
		<ChatCard data-testid="product-card" variant="card">
			<ChatCardHeader leading={<PackageIcon />} title={offer.name} {...(availability ? { badge: { tone: offer.availability === "out_of_stock" ? ("danger" as const) : ("muted" as const), label: t.t(availability) } } : {})} />
			{offer.images.length > 0 ? <Gallery offer={offer} t={t} /> : null}
			<PriceBlock f={f} offer={offer} t={t} />
			<div className="flex flex-col gap-1 text-body">
				<span className="flex items-center gap-1.5 text-muted-foreground" title={t.t("shopping.product.store", { store: offer.merchant })}><StoreIcon aria-hidden className="size-3.5" />{offer.merchant}</span>
				<div className="flex flex-wrap items-center justify-between gap-x-3" data-testid="product-shipping">
					<span className={cn(offer.shipping.kind === "unknown" && "text-warning", offer.shipping.kind === "unavailable" && "text-destructive")}>{shippingText(offer, t, f)}</span>
					<span className={cn("font-medium tabular-nums", offer.total === null && "text-muted-foreground")} data-testid="product-total">{totalText(offer, t, f)}</span>
				</div>
			</div>
			<Rating f={f} offer={offer} t={t} />
			{offer.description ? <p className="m-0 line-clamp-3 text-body text-muted-foreground">{offer.description}</p> : null}
			<ChatCardActions>
				<StoreLink offer={offer} t={t} />
			</ChatCardActions>
		</ChatCard>
	);
}

function CompareRow({ offer, best }: { offer: ProductOffer; best: boolean }) {
	const t = useTranslations();
	const f = useFormat();
	return (
		<li className={cn("flex min-w-0 gap-3 rounded-card p-2", best ? "bg-success/10" : "bg-background/60")} data-best={best ? "true" : "false"} data-testid="product-compare-row">
			<SafeImage alt={t.t("shopping.product.photoOf", { name: offer.name })} className="size-14 shrink-0 rounded-lg" fallbackLabel={t.t("shopping.product.photoUnavailable")} src={offer.images[0]} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-body font-medium">{offer.merchant}</span>
					{best ? <Badge variant="success">{t.t("shopping.product.cheapest")}</Badge> : null}
				</div>
				<span className="truncate text-caption text-muted-foreground">{offer.name}</span>
				<div className="flex flex-wrap items-baseline justify-between gap-x-3 text-body">
					<span className="tabular-nums">{offer.price === null ? t.t("shopping.product.priceMissing") : money(f, offer.price, offer.currency)} · <span className={cn(offer.shipping.kind === "unknown" && "text-warning", offer.shipping.kind === "unavailable" && "text-destructive")}>{shippingText(offer, t, f)}</span></span>
					<span className={cn("font-medium tabular-nums", offer.total === null && "text-muted-foreground")} data-testid="product-total">{totalText(offer, t, f)}</span>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Rating f={f} offer={offer} t={t} />
					<StoreLink offer={offer} t={t} />
				</div>
			</div>
		</li>
	);
}

/** Um produto (foto, preço, loja, frete, total, link) ou vários (comparar pelo TOTAL, frete desconhecido dito). */
export function ProductCard({ items, cheapestUrl, incomplete }: ProductCardData) {
	const t = useTranslations();
	if (items.length === 0) return null;
	if (items.length === 1) return <SingleProduct offer={items[0]!} />;
	const mixed = new Set(items.filter((i) => i.total !== null).map((i) => i.currency)).size > 1;
	return (
		<ChatCard data-testid="product-card" variant="card">
			<ChatCardHeader leading={<StoreIcon />} title={t.t("shopping.product.compare")} />
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{items.map((offer) => (
					<CompareRow best={cheapestUrl === offer.url} key={offer.url} offer={offer} />
				))}
			</ul>
			{incomplete ? <p className="m-0 text-caption text-warning" data-testid="product-incomplete">{t.t("shopping.product.incomplete")}</p> : null}
			{mixed ? <p className="m-0 text-caption text-muted-foreground">{t.t("shopping.product.mixedCurrency")}</p> : null}
		</ChatCard>
	);
}
