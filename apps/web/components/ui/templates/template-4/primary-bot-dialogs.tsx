"use client";

import { SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@workspace/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";

import { AgentAvatar } from "./agent-avatar";
import type { Agent } from "./data";
import { pickablePrimaryBots } from "./primary-bot-logic";
import { PrimaryBotBadge } from "./primary-bot-badge";

const ERROR_TEXT = "Não foi possível definir o Bot principal";

/** Lista de seleção única (radiogroup) com avatar + nome + título. */
export function PrimaryBotRadioList({
	bots,
	selectedId,
	onSelect,
	label,
}: {
	bots: Agent[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	label: string;
}) {
	if (bots.length === 0) {
		return (
			<p className="py-6 text-center text-muted-foreground text-sm">
				Ainda não há outros bots para escolher
			</p>
		);
	}
	return (
		<div aria-label={label} className="flex max-h-[282px] flex-col gap-1 overflow-y-auto" role="radiogroup">
			{bots.map((bot) => {
				const checked = bot.id === selectedId;
				return (
					<button
						aria-checked={checked}
						className={cn(
							"flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
							checked && "bg-muted",
						)}
						key={bot.id}
						onClick={() => onSelect(bot.id)}
						role="radio"
						type="button"
					>
						<AgentAvatar animated={false} bodyColor={bot.color} id={bot.id} shape={bot.shape} size={36} />
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate font-medium text-sm">{bot.name}</span>
							{bot.snippet ? <span className="truncate text-muted-foreground text-xs">{bot.snippet}</span> : null}
						</span>
						<span
							aria-hidden
							className={cn(
								"grid size-4 shrink-0 place-items-center rounded-full border",
								checked ? "border-primary bg-primary" : "border-input",
							)}
						>
							{checked ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
						</span>
					</button>
				);
			})}
		</div>
	);
}

/** Apresentação do Bot principal (uma vez) + passo "Escolher um Bot existente". */
export function PrimaryBotIntroDialog({
	open,
	agents,
	onDismiss,
	onCreate,
	onChoose,
}: {
	open: boolean;
	agents: Agent[];
	onDismiss: () => void;
	/** "Criar um Bot principal": abre o fluxo de criar bot e marca o novo como principal. */
	onCreate: () => void;
	onChoose: (id: string) => Promise<void>;
}) {
	const [step, setStep] = useState<"intro" | "choose">("intro");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const bots = pickablePrimaryBots(agents);
	const example = bots[0];

	useEffect(() => {
		if (open) {
			setStep("intro");
			setSelectedId(null);
			setError("");
		}
	}, [open]);

	async function confirm() {
		if (!selectedId || busy) return;
		setBusy(true);
		setError("");
		try {
			await onChoose(selectedId);
		} catch {
			setError(ERROR_TEXT);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog onOpenChange={(next) => { if (!next) onDismiss(); }} open={open}>
			<DialogContent className="gap-5 sm:max-w-[400px]" showCloseButton={false}>
				{step === "intro" ? (
					<>
						<div className="flex flex-col items-center gap-4 pt-2 text-center">
							{example ? (
								<PrimaryBotBadge show size={60}>
									<AgentAvatar animated={false} bodyColor={example.color} id={example.id} shape={example.shape} size={60} />
								</PrimaryBotBadge>
							) : null}
							<DialogHeader className="items-center">
								<DialogTitle className="text-lg">Conheça o seu Bot principal</DialogTitle>
								<DialogDescription>
									Seu ponto de contato. Ele age por iniciativa própria e coordena o trabalho com os seus outros bots.
								</DialogDescription>
							</DialogHeader>
						</div>
						<DialogFooter className="flex-row gap-2 sm:justify-stretch">
							<Button className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-3 py-2 leading-tight" onClick={onCreate} type="button" variant="secondary">
								Criar um Bot principal
							</Button>
							<Button className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-3 py-2 leading-tight" onClick={() => setStep("choose")} type="button">
								Escolher um Bot existente
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle className="text-lg">Escolher um Bot existente</DialogTitle>
							<DialogDescription className="sr-only">Selecione o bot que será o seu Bot principal.</DialogDescription>
						</DialogHeader>
						<PrimaryBotRadioList bots={bots} label="Bots" onSelect={setSelectedId} selectedId={selectedId} />
						{error ? (
							<p className="text-destructive text-sm" role="alert">{error}</p>
						) : null}
						<DialogFooter className="flex-row gap-2 sm:justify-stretch">
							<Button className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-3 py-2 leading-tight" disabled={busy} onClick={() => { setStep("intro"); setError(""); }} type="button" variant="secondary">
								Voltar
							</Button>
							<Button className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-3 py-2 leading-tight" disabled={!selectedId || busy} onClick={() => void confirm()} type="button">
								Confirmar
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** "Trocar Bot principal": busca + lista dos demais bots. */
export function PrimaryBotPickerDialog({
	open,
	agents,
	onClose,
	onChoose,
}: {
	open: boolean;
	agents: Agent[];
	onClose: () => void;
	onChoose: (id: string) => Promise<void>;
}) {
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (open) {
			setQuery("");
			setSelectedId(null);
			setError("");
		}
	}, [open]);

	async function confirm() {
		if (!selectedId || busy) return;
		setBusy(true);
		setError("");
		try {
			await onChoose(selectedId);
			onClose();
		} catch {
			setError(ERROR_TEXT);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog onOpenChange={(next) => { if (!next) onClose(); }} open={open}>
			<DialogContent className="gap-4 sm:max-w-[400px]" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle className="text-lg">Escolha um Bot principal</DialogTitle>
					<DialogDescription className="sr-only">Selecione o bot que passa a ser o seu Bot principal.</DialogDescription>
				</DialogHeader>
				<div className="relative">
					<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						aria-label="Buscar"
						className="pl-9"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Buscar"
						value={query}
					/>
				</div>
				<PrimaryBotRadioList
					bots={pickablePrimaryBots(agents, query)}
					label="Bots"
					onSelect={setSelectedId}
					selectedId={selectedId}
				/>
				{error ? (
					<p className="text-destructive text-sm" role="alert">{error}</p>
				) : null}
				<DialogFooter className="flex-row gap-2 sm:justify-stretch">
					<Button className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-3 py-2 leading-tight" disabled={busy} onClick={onClose} type="button" variant="secondary">
						Cancelar
					</Button>
					<Button className="h-auto min-h-9 min-w-0 flex-1 whitespace-normal px-3 py-2 leading-tight" disabled={!selectedId || busy} onClick={() => void confirm()} type="button">
						Confirmar
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
