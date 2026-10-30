"use client";

import type { CSSProperties, ReactNode } from "react";

import { cn } from "@workspace/ui/lib/utils";

import { useBotWorking } from "@/lib/bot-activity";
import { useTranslations } from "@/lib/i18n/provider";

import { PrimaryBotBadge } from "./primary-bot-badge";

export type AvatarStatusKind = "working" | "unread" | "primary" | "none";

/** Precedência do canto de baixo do avatar: trabalhando > não lida > estrela do bot principal. */
export function resolveAvatarStatus({
	working,
	unread,
	primary,
}: {
	working?: boolean;
	unread?: boolean;
	primary?: boolean;
}): AvatarStatusKind {
	if (working) return "working";
	if (unread) return "unread";
	if (primary) return "primary";
	return "none";
}

export const AVATAR_STATUS_COLORS = {
	working: "#22c55e",
	unread: "#2496e8",
} as const;

/** Bolinha proporcional ao avatar (10px nos pequenos, até 16px nos fixados do celular). */
export function avatarDotMetrics(avatarSize: number) {
	const dot = Math.min(16, Math.max(10, Math.round(avatarSize * 0.26)));
	return { dot, gap: 2 };
}

/** Recorte circular no canto de baixo à direita do avatar, onde a bolinha encaixa. */
export function avatarDotMask(avatarSize: number): CSSProperties {
	const { dot, gap } = avatarDotMetrics(avatarSize);
	const r = dot / 2;
	const mask = `radial-gradient(circle at calc(100% - ${r}px) calc(100% - ${r}px), transparent ${r + gap}px, #000 ${r + gap + 0.5}px)`;
	return { WebkitMaskImage: mask, maskImage: mask };
}

/**
 * Moldura de status do avatar: bolinha no canto de baixo à direita (verde = trabalhando,
 * azul = não lida) com recorte no avatar; a estrela do bot principal só aparece sem bolinha.
 * Não troca o avatar, só o sobrepõe, então o `LiveAgentAvatar` segue animando.
 * Com `botId`, "trabalhando" vem do mapa de runs ativos (lib/bot-activity).
 */
export function AvatarStatus({
	size,
	unread,
	primary,
	working,
	botId,
	label,
	className,
	children,
}: {
	/** Tamanho do avatar em px. */
	size: number;
	unread?: boolean;
	primary?: boolean;
	/** Força o estado; sem isso, lê de `botId`. */
	working?: boolean;
	botId?: string;
	/** Prefixo do rótulo acessível (ex.: "Grupo"). */
	label?: string;
	className?: string;
	children: ReactNode;
}) {
	const { t, locale } = useTranslations();
	const live = useBotWorking(botId);
	const kind = resolveAvatarStatus({ working: working ?? live, unread, primary });
	if (kind === "primary") {
		return (
			<PrimaryBotBadge show size={size} className={className}>
				{children}
			</PrimaryBotBadge>
		);
	}
	if (kind === "none") return <>{children}</>;
	const { dot } = avatarDotMetrics(size);
	const text = t(kind === "working" ? "botActions.avatar.working" : "botActions.avatar.unread");
	return (
		<span className={cn("relative inline-flex shrink-0", className)} data-avatar-status={kind}>
			<span className="inline-flex" style={avatarDotMask(size)}>
				{children}
			</span>
			<span
				aria-label={label ? t("botActions.avatar.labeled", { label, status: text.toLocaleLowerCase(locale) }) : text}
				className="absolute right-0 bottom-0 rounded-full motion-safe:animate-in motion-safe:duration-200 motion-safe:ease-out motion-safe:zoom-in-0"
				data-avatar-dot={kind}
				role="img"
				style={{ height: dot, width: dot, backgroundColor: AVATAR_STATUS_COLORS[kind] }}
			/>
		</span>
	);
}
