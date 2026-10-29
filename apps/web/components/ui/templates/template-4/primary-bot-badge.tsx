"use client";

import type { CSSProperties, ReactNode } from "react";

import { cn } from "@workspace/ui/lib/utils";

import { useT } from "@/lib/i18n/provider";

/** Medidas da bolinha: avatares pequenos (< 44px) usam 12px; os demais, 16px. Nunca proporcional. */
export function primaryBadgeMetrics(avatarSize: number) {
	return avatarSize < 44
		? { badge: 12, glyph: 6, gap: 2 }
		: { badge: 16, glyph: 8, gap: 2.7 };
}

/** Máscara que abre um recorte circular no canto de baixo do avatar, onde fica a bolinha. */
export function primaryBadgeMask(avatarSize: number): CSSProperties {
	const { badge, gap } = primaryBadgeMetrics(avatarSize);
	const r = badge / 2;
	const mask = `radial-gradient(circle at calc(100% - ${r}px) calc(100% - ${r}px), transparent ${r + gap}px, #000 ${r + gap + 0.5}px)`;
	return { WebkitMaskImage: mask, maskImage: mask };
}

/**
 * Bolinha laranja com estrela no canto do avatar do "Bot principal" (sidebar, fixados,
 * lista mobile e modais). O canto de baixo fica livre do ponto de notificação, que mora em cima.
 */
export function PrimaryBotBadge({
	show,
	size,
	className,
	children,
}: {
	show?: boolean;
	/** Tamanho do avatar em px. */
	size: number;
	className?: string;
	children: ReactNode;
}) {
	const t = useT();
	if (!show) return <>{children}</>;
	const { badge, glyph } = primaryBadgeMetrics(size);
	return (
		<span className={cn("relative inline-flex shrink-0", className)}>
			<span className="inline-flex" style={primaryBadgeMask(size)}>
				{children}
			</span>
			<span
				aria-label={t("groups.primary.badge")}
				className="absolute right-0 bottom-0 grid place-items-center rounded-full bg-[#ff9800] text-[#fcfcfc] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.08)]"
				role="img"
				style={{ height: badge, width: badge }}
				title={t("groups.primary.badge")}
			>
				<svg aria-hidden="true" fill="currentColor" height={glyph} viewBox="0 0 24 24" width={glyph}>
					<path d="M12 17.27l4.15 2.51c.76.46 1.69-.22 1.49-1.08l-1.1-4.72 3.67-3.18c.67-.58.31-1.68-.57-1.75l-4.83-.41-1.89-4.46c-.34-.81-1.5-.81-1.84 0L9.19 8.63l-4.83.41c-.88.07-1.24 1.17-.57 1.75l3.67 3.18-1.1 4.72c-.2.86.73 1.54 1.49 1.08L12 17.27z" />
				</svg>
			</span>
		</span>
	);
}
