"use client";

import { useEffect, useId, useRef, useState } from "react";
import { normalizeEnvRepo, parseTestPrInput, resolveTestPrForm } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";

import { suggestRepos } from "@/components/settings/dev-environments-state";
import { useTranslations } from "@/lib/i18n/provider";
import { listDevEnvironments, listDevSessions, listGithubPulls, listGithubRepos, type GithubPullOption, type GithubRepoOption } from "@/lib/atlas-api";

const LABEL_CLASS = "text-body leading-[18px] font-medium";

export type TestPrDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Recebe a mensagem pronta para o bot. */
	onSubmit: (message: string) => void;
	initialRepo?: string;
	/** Sugestões já conhecidas (pré-visualização e testes); sem isso busca na conexão GitHub. */
	repoOptions?: GithubRepoOption[];
	/** Conversa atual: o repositório da sessão de código ativa vira o padrão. */
	conversationId?: string;
	/** PRs já conhecidas (pré-visualização e testes); sem isso busca as abertas do repositório. */
	pullOptions?: GithubPullOption[];
};

/** Repositório padrão: sessão de código mais recente da conversa, senão o ambiente usado mais recentemente. */
export async function defaultTestPrRepo(conversationId: string | undefined): Promise<string | null> {
	if (conversationId) {
		const sessions = await listDevSessions(conversationId).catch(() => []);
		const recent = [...sessions].filter((session) => session.repo).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0];
		if (recent?.repo) return recent.repo;
	}
	const envs = await listDevEnvironments().catch(() => null);
	const latest = envs ? [...envs.environments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] : undefined;
	return latest?.repo ?? null;
}

/**
 * "Testar uma PR": repositório (sugestões da conexão GitHub) e número ou link
 * da PR. Colar o link em qualquer campo preenche os dois. Envia a mensagem pronta.
 */
export function TestPrDialog({ open, onOpenChange, onSubmit, initialRepo = "", repoOptions, conversationId, pullOptions }: TestPrDialogProps) {
	const { t } = useTranslations();
	const [repo, setRepo] = useState(initialRepo);
	const [pr, setPr] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [options, setOptions] = useState<GithubRepoOption[]>(repoOptions ?? []);
	const [suggestOpen, setSuggestOpen] = useState(false);
	const loaded = useRef(Boolean(repoOptions));
	const [pulls, setPulls] = useState<GithubPullOption[]>(pullOptions ?? []);
	const ids = useId();
	const repoKey = normalizeEnvRepo(repo);

	// Ao abrir sem repositório, usa o da sessão de código ativa ou do ambiente mais recente.
	useEffect(() => {
		if (!open || repo.trim() || initialRepo) return;
		let cancelled = false;
		void defaultTestPrRepo(conversationId).then((found) => {
			if (!cancelled && found) setRepo((current) => current || found);
		});
		return () => {
			cancelled = true;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: só ao abrir.
	}, [open]);

	// PRs abertas do repositório como atalhos (sem acesso ao GitHub, nada aparece).
	useEffect(() => {
		if (pullOptions || !open || !repoKey) {
			if (!pullOptions) setPulls([]);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			listGithubPulls(repoKey)
				.then((list) => !cancelled && setPulls(list.slice(0, 20)))
				.catch(() => !cancelled && setPulls([]));
		}, 400);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, repoKey, pullOptions]);
	const suggestions = suggestRepos(options, repo, []);

	function loadRepos() {
		if (loaded.current) return;
		loaded.current = true;
		listGithubRepos()
			.then(setOptions)
			.catch(() => setOptions([]));
	}

	/** Link colado em qualquer campo: preenche repositório e número. */
	function applyPaste(text: string): boolean {
		const parsed = parseTestPrInput(text);
		if (!parsed?.repo || !parsed.number) return false;
		setRepo(parsed.repo);
		setPr(`#${parsed.number}`);
		setError(null);
		return true;
	}

	function submit() {
		const result = resolveTestPrForm(repo, pr);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		onSubmit(result.message);
		onOpenChange(false);
		setPr("");
		setError(null);
	}

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="gap-5 p-5 sm:max-w-md sm:p-6" data-slot="test-pr-dialog">
				<DialogHeader>
					<DialogTitle className="text-base font-semibold">{t("devSession.testPr.title")}</DialogTitle>
					<DialogDescription>{t("devSession.testPr.description")}</DialogDescription>
				</DialogHeader>
				<form
					className="flex min-w-0 flex-col gap-4"
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<div className="flex min-w-0 flex-col gap-1.5">
						<label className={LABEL_CLASS} htmlFor={`${ids}-repo`}>
							{t("devSession.testPr.repo")}
						</label>
						<div className="relative">
							<Input
								autoComplete="off"
								className="font-mono text-body"
								id={`${ids}-repo`}
								onBlur={() => setTimeout(() => setSuggestOpen(false), 120)}
								onChange={(event) => {
									if (applyPaste(event.target.value)) return;
									setRepo(event.target.value);
									setSuggestOpen(true);
									setError(null);
								}}
								onFocus={() => {
									loadRepos();
									setSuggestOpen(true);
								}}
								placeholder="acme/site"
								spellCheck={false}
								value={repo}
							/>
							{suggestOpen && suggestions.length > 0 ? (
								<ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-44 overflow-auto rounded-2xl bg-popover p-1 shadow-lg ring-1 ring-foreground/10" role="listbox">
									{suggestions.map((name) => (
										<li key={name} role="option">
											<button
												className="flex h-8 w-full items-center rounded-xl px-2.5 text-left font-mono text-body outline-none hover:bg-muted focus-visible:bg-muted"
												onMouseDown={(event) => {
													event.preventDefault();
													setRepo(name);
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
					</div>
					<div className="flex min-w-0 flex-col gap-1.5">
						<label className={LABEL_CLASS} htmlFor={`${ids}-pr`}>
							{t("devSession.testPr.number")}
						</label>
						<Input
							autoComplete="off"
							className="font-mono text-body"
							id={`${ids}-pr`}
							onChange={(event) => {
								if (applyPaste(event.target.value)) return;
								setPr(event.target.value);
								setError(null);
							}}
							placeholder="42 ou https://github.com/acme/site/pull/42"
							spellCheck={false}
							value={pr}
						/>
						{pulls.length > 0 ? (
							<ul aria-label={t("devSession.testPr.openPulls")} className="flex max-h-32 flex-col gap-0.5 overflow-y-auto" data-slot="test-pr-quick-picks">
								{pulls.map((pull) => (
									<li key={pull.number}>
										<button
											className="flex h-7 w-full items-center gap-2 rounded-xl px-2 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted"
											onClick={() => {
												setPr(`#${pull.number}`);
												setError(null);
											}}
											type="button"
										>
											<span className="shrink-0 font-mono text-muted-foreground">#{pull.number}</span>
											<span className="min-w-0 flex-1 truncate">{pull.title}</span>
										</button>
									</li>
								))}
							</ul>
						) : null}
						{error ? (
							<p className="text-xs text-destructive" role="alert">
								{error}
							</p>
						) : null}
					</div>
					<DialogFooter>
						<Button onClick={() => onOpenChange(false)} type="button" variant="outline">
							{t("common.cancel")}
						</Button>
						<Button disabled={!pr.trim()} type="submit">
							{t("devSession.testPr.submit")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
