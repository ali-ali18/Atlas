import { BotIcon, CheckIcon, XIcon } from "lucide-react";
import { Spinner } from "@workspace/ui/components/spinner";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";
import { OpenAIIcon } from "@/components/icons/openai";

export type ProviderCallbackState = "working" | "success" | "error";

export type ProviderCallbackViewProps = {
	state: ProviderCallbackState;
	/** E-mail da conta conectada, quando a API devolve. */
	email?: string | null;
	/** Mensagem pt-BR do erro (já mapeada do código). */
	message?: string | null;
	/** `true` quando a janela foi aberta pelo Atlas (dá para tentar de novo e fechar sozinha). */
	hasOpener: boolean;
	onRetry?: () => void;
	onClose?: () => void;
};

function AppTile({ children, label }: { children: React.ReactNode; label: string }) {
	return (
		<span
			role="img"
			aria-label={label}
			className="grid size-14 place-items-center rounded-2xl border bg-background text-foreground shadow-xs"
		>
			{children}
		</span>
	);
}

/** "•••" entre os apps: pulsa enquanto trabalha, fica fixo quando termina. */
function LinkDots({ animated }: { animated: boolean }) {
	return (
		<span aria-hidden className="flex items-center gap-1.5 text-muted-foreground">
			{[0, 1, 2].map((index) => (
				<span
					key={index}
					className={cn("size-1.5 rounded-full bg-current", animated ? "animate-pulse" : "opacity-60")}
					style={animated ? { animationDelay: `${index * 200}ms` } : undefined}
				/>
			))}
		</span>
	);
}

const TITLES: Record<ProviderCallbackState, string> = {
	working: "Conectando ao ChatGPT…",
	success: "ChatGPT conectado",
	error: "Não foi possível conectar",
};

function StatusIcon({ state }: { state: ProviderCallbackState }) {
	if (state === "working")
		return <Spinner className="size-5 text-muted-foreground" />;
	const ok = state === "success";
	return (
		<span
			aria-hidden
			className={cn(
				"grid size-9 place-items-center rounded-full",
				ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
			)}
		>
			{ok ? <CheckIcon className="size-5" strokeWidth={2.5} /> : <XIcon className="size-5" strokeWidth={2.5} />}
		</span>
	);
}

/** Cartão central da página de retorno do login: estado, resultado e próximos passos. */
export function ProviderCallbackView({
	state,
	email,
	message,
	hasOpener,
	onRetry,
	onClose,
}: ProviderCallbackViewProps) {
	return (
		<main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
			<section className="flex w-full max-w-sm flex-col items-center gap-6 rounded-3xl border bg-card p-8 text-center shadow-sm">
				<div className="flex items-center gap-4">
					<AppTile label="ChatGPT">
						<OpenAIIcon className="size-7" />
					</AppTile>
					<LinkDots animated={state === "working"} />
					<AppTile label="App">
						<BotIcon className="size-7" />
					</AppTile>
				</div>

				<div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
					<StatusIcon state={state} />
					<h1 className="font-heading text-lg font-semibold tracking-tight">{TITLES[state]}</h1>
					{state === "success" && email ? <p className="text-sm text-muted-foreground">{email}</p> : null}
					{state === "success" ? (
						<p className="text-sm text-muted-foreground">Você já pode fechar esta janela.</p>
					) : null}
					{state === "error" ? (
						<p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm">{message}</p>
					) : null}
				</div>

				{state === "error" ? (
					<div className="flex gap-2">
						{hasOpener ? (
							<Button type="button" onClick={onRetry}>
								Tentar de novo
							</Button>
						) : null}
						<Button type="button" variant="outline" onClick={onClose}>
							Fechar
						</Button>
					</div>
				) : null}

				{!hasOpener && state !== "working" ? (
					<a
						href="/?settings=provedores"
						className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
					>
						Voltar ao app
					</a>
				) : null}
			</section>
		</main>
	);
}
