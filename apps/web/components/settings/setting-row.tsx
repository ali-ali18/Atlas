"use client";

import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@workspace/ui/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { SettingsIcon } from "@/components/ui/templates/template-4/settings-picker";
import type { SaveStatus } from "./account-settings-state";

/** Dentro de um grupo com título, os `SettingsGroup` internos viram só as linhas (um cartão só). */
const InsideGroup = createContext(false);

/**
 * Grupo de linhas no estilo cartão: título pequeno acima (12px, secundário, 8px de
 * recuo), cartão de cantos 12 com borda fina, sem fundo e sem divisórias entre as linhas.
 * Com `title`, os grupos aninhados (os das telas reaproveitadas) não desenham outro cartão.
 */
export function SettingsGroup({
	className,
	children,
	title,
}: {
	className?: string;
	children: ReactNode;
	/** Título do grupo, acima do cartão. */
	title?: string;
}) {
	const inside = useContext(InsideGroup);
	if (inside && !title) return <>{children}</>;
	return (
		<section className="flex w-full flex-col gap-2" data-slot="settings-group-section">
			{title ? (
				<h3 className="px-2 text-xs leading-4 font-normal text-muted-foreground" data-slot="settings-group-title">
					{title}
				</h3>
			) : null}
			<div
				className={cn("flex w-full flex-col overflow-clip rounded-card border border-border/60 py-2", className)}
				data-slot="settings-group"
			>
				<InsideGroup.Provider value>{children}</InsideGroup.Provider>
			</div>
		</section>
	);
}

/** Painel de uma seção: grupos separados por 28px. */
export function SettingsStack({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col gap-7" data-slot="settings-stack">
			{children}
		</div>
	);
}

const TITLE_CLASS = "text-body leading-[18px] font-normal";

/**
 * A linha padrão de TODA seção: rótulo à esquerda e um controle à direita. A
 * descrição NÃO aparece sob o rótulo (vira dica ao passar o mouse e alimenta a
 * busca); só a legenda de estado/erro (`caption`) fica visível, logo abaixo do rótulo.
 * `control="field"` deixa o seletor com a largura do valor; `"inline"` mantém o
 * tamanho natural de switch e botões.
 */
export function SettingRow({
	label,
	icon: Icon,
	htmlFor,
	description,
	caption,
	control = "field",
	wrap = false,
	children,
}: {
	label: string;
	/** Ícone lucide da linha (size-4, discreto) à esquerda do rótulo. */
	icon?: SettingsIcon;
	htmlFor?: string;
	/** Texto de apoio: só dica (tooltip), nunca visível sob a linha. */
	description?: ReactNode;
	/** Origem do valor, "Salvo" ou erro: texto pequeno sob o rótulo, à esquerda. */
	caption?: ReactNode;
	control?: "field" | "inline";
	/** Controle largo (ex.: dois campos de hora): vai para baixo do rótulo quando falta espaço. */
	wrap?: boolean;
	/** Linha só de status: omita o controle. */
	children?: ReactNode;
}) {
	const hint = typeof description === "string" ? description : undefined;
	return (
		<div
			className={cn(
				"flex min-h-10 items-center justify-between gap-x-3 gap-y-2 px-3.5 py-2.5",
				wrap && "flex-wrap",
			)}
			data-slot="setting-row"
		>
			<div className="flex min-w-[4.5rem] flex-1 basis-24 flex-col gap-0.5" data-slot="setting-row-text" title={hint}>
				<div className="flex items-center gap-2">
					{Icon ? (
						<Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" data-slot="setting-row-icon" />
					) : null}
					{htmlFor ? (
						<label className={TITLE_CLASS} htmlFor={htmlFor}>
							{label}
						</label>
					) : (
						<p className={TITLE_CLASS}>{label}</p>
					)}
				</div>
				{description && !hint ? (
					<div className="text-body leading-[18px] text-muted-foreground">{description}</div>
				) : null}
				{caption ? (
					<div className="flex flex-col gap-0.5 text-xs text-muted-foreground empty:hidden">{caption}</div>
				) : null}
			</div>
			{children ? (
				<div
					className={cn(
						"flex min-w-0 items-center justify-end gap-2",
						wrap ? "ml-auto max-w-full shrink-0" : "max-w-[70%] shrink",
						"settings-ghost-controls",
					)}
					data-slot="setting-row-control"
				>
					{children}
				</div>
			) : null}
		</div>
	);
}

/** "Salvo" discreto ou o erro do último PATCH; some quando ocioso. */
export function SaveIndicator({ status, error }: { status: SaveStatus; error?: string | null }) {
	const t = useT();
	if (status === "error") {
		return (
			<p className="text-xs text-destructive" role="alert">
				{error || t("settings.saveError")}
			</p>
		);
	}
	if (status === "saving" || status === "saved") {
		return (
			<p aria-live="polite" className="text-xs text-muted-foreground" role="status">
				{status === "saving" ? t("settings.saving") : t("settings.saved")}
			</p>
		);
	}
	return null;
}
