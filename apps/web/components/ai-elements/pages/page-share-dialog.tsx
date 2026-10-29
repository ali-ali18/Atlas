"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Switch } from "@workspace/ui/components/switch";

import { useT } from "@/lib/i18n/provider";
import { type AtlasPageShare, createPageShare, getPageShare, revokePageShare } from "@/lib/atlas-api";

export type PageShareApi = {
	get: (pageId: string) => Promise<AtlasPageShare>;
	create: (pageId: string) => Promise<AtlasPageShare>;
	revoke: (pageId: string) => Promise<AtlasPageShare>;
};

const defaultApi: PageShareApi = { get: getPageShare, create: createPageShare, revoke: revokePageShare };

/** Texto em pt-BR (idioma-fonte); a tela mostra `share.publicLinkWarning`. */
export const PUBLIC_LINK_WARNING = "Qualquer pessoa com o link vê este painel e as atualizações dele.";

export type ShareState = { kind: "loading" } | { kind: "ready"; active: boolean; url: string | null } | { kind: "error"; message: string };

/** Corpo do diálogo (apresentação pura, para teste). `url` null com link ativo = aberto de novo: o servidor não guarda o token. */
export function PageShareBody({
	state,
	busy,
	copied,
	onToggle,
	onCopy,
	onRotate,
}: {
	state: ShareState;
	busy: boolean;
	copied: boolean;
	onToggle: (next: boolean) => void;
	onCopy: () => void;
	onRotate: () => void;
}) {
	const t = useT();
	if (state.kind === "loading") return <div aria-live="polite" className="h-16 animate-pulse rounded-lg bg-muted/40 motion-reduce:animate-none" data-testid="share-loading" />;
	if (state.kind === "error") {
		return (
			<p className="text-destructive text-sm" role="alert">
				{state.message}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<label className="font-medium text-sm" htmlFor="page-public-link">
					{t("share.publicLink")}
				</label>
				<Switch aria-label={t("share.publicLink")} checked={state.active} disabled={busy} id="page-public-link" onCheckedChange={onToggle} />
			</div>
			{state.active ? (
				<>
					<p className="m-0 text-muted-foreground text-sm" data-testid="share-warning">
						{t("share.publicLinkWarning")}
					</p>
					{state.url ? (
						<div className="flex items-center gap-2">
							<input
								aria-label={t("share.linkAddress")}
								className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
								onFocus={(event) => event.currentTarget.select()}
								readOnly
								value={state.url}
							/>
							<Button onClick={onCopy} size="sm" type="button" variant="outline">
								{copied ? <CheckIcon /> : <CopyIcon />}
								{copied ? t("share.copied") : t("share.copy")}
							</Button>
						</div>
					) : (
						<p className="m-0 text-muted-foreground text-xs">{t("share.linkHidden")}</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button disabled={busy} onClick={onRotate} size="sm" type="button" variant="outline">
							{t("share.newLink")}
						</Button>
						<Button disabled={busy} onClick={() => onToggle(false)} size="sm" type="button" variant="ghost">
							{t("share.disableLink")}
						</Button>
					</div>
				</>
			) : (
				<p className="m-0 text-muted-foreground text-sm">{t("share.disabled")}</p>
			)}
		</div>
	);
}

/** Diálogo "Link público" do painel: liga/desliga, gira e copia o endereço. Só o dono chega aqui (a API escopa pelo dono). */
export function PageShareDialog({
	open,
	onOpenChange,
	pageId,
	title,
	api = defaultApi,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pageId: string;
	title: string;
	api?: PageShareApi;
}) {
	const t = useT();
	const [state, setState] = useState<ShareState>({ kind: "loading" });
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setState({ kind: "loading" });
		setCopied(false);
		api
			.get(pageId)
			.then((share) => !cancelled && setState({ kind: "ready", active: share.active, url: null }))
			.catch(() => !cancelled && setState({ kind: "error", message: t("share.readError") }));
		return () => {
			cancelled = true;
		};
	}, [open, pageId, api]);

	async function mutate(task: () => Promise<AtlasPageShare>) {
		if (busy) return;
		setBusy(true);
		setCopied(false);
		try {
			const share = await task();
			setState({ kind: "ready", active: share.active, url: share.url ?? null });
		} catch {
			setState({ kind: "error", message: t("share.updateError") });
		} finally {
			setBusy(false);
		}
	}

	async function copy() {
		if (state.kind !== "ready" || !state.url) return;
		try {
			await navigator.clipboard.writeText(state.url);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch {
			// Sem permissão de área de transferência: o campo continua selecionável para copiar à mão.
		}
	}

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md" data-testid="page-share-dialog">
				<DialogHeader>
					<DialogTitle>{t("share.title", { title })}</DialogTitle>
					<DialogDescription>{t("share.description")}</DialogDescription>
				</DialogHeader>
				<PageShareBody
					busy={busy}
					copied={copied}
					onCopy={() => void copy()}
					onRotate={() => void mutate(() => api.create(pageId))}
					onToggle={(next) => void mutate(() => (next ? api.create(pageId) : api.revoke(pageId)))}
					state={state}
				/>
			</DialogContent>
		</Dialog>
	);
}
