import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Pressable, Text, View } from "react-native";
import { cn } from "@/lib/cn";

// Espelho do ChatCard de packages/ui: mesmos nomes, props, variantes e vocabulário (CHAT_CARD_COPY é
// importado do próprio packages/ui). Diferenças inevitáveis: sem <section>/<p>; o ícone `leading` é um
// nó RN; o recolher é estado local + Pressable (não há Collapsible/Base UI) e o chevron é o caractere "›".

/** Estado do selo do cabeçalho: espera (âmbar), sucesso, recusa/erro, neutro. */
export type ChatCardTone = "pending" | "success" | "danger" | "muted";

const BADGE_TONE: Record<ChatCardTone, { box: string; text: string }> = {
	pending: { box: "bg-warning/10 dark:bg-warning/15", text: "text-warning" },
	success: { box: "bg-success/10 dark:bg-success/15", text: "text-success" },
	danger: { box: "bg-destructive/10 dark:bg-destructive/20", text: "text-destructive" },
	muted: { box: "bg-foreground/[0.06]", text: "text-muted-foreground" },
};

const chatCardVariants = cva("min-w-0 rounded-2xl bg-muted/60", {
	variants: {
		variant: {
			card: "w-full flex-col gap-3 p-3",
			activity: "flex-col justify-center gap-2 self-start px-3 py-2",
		},
	},
	defaultVariants: { variant: "card" },
});

export function ChatCard({ className, variant = "card", ...props }: React.ComponentProps<typeof View> & VariantProps<typeof chatCardVariants>) {
	return <View className={cn(chatCardVariants({ variant }), className)} {...props} />;
}

export function ChatCardLeading({ className, ...props }: React.ComponentProps<typeof View>) {
	return <View className={cn("h-5 shrink-0 items-center justify-center", className)} {...props} />;
}

export function ChatCardBadge({ tone, label }: { tone: ChatCardTone; label: string }) {
	return (
		<View accessibilityRole="text" className={cn("shrink-0 flex-row items-center rounded-full px-2 py-0.5", BADGE_TONE[tone].box)}>
			<Text className={cn("text-xs font-medium leading-4", BADGE_TONE[tone].text)}>{label}</Text>
		</View>
	);
}

/** Cabeçalho do cartão: ícone + título curto + selo de estado + ação compacta. */
export function ChatCardHeader({
	leading,
	title,
	badge,
	action,
}: {
	leading?: React.ReactNode;
	title: React.ReactNode;
	badge?: { tone: ChatCardTone; label: string };
	action?: React.ReactNode;
}) {
	return (
		<View className="min-w-0 flex-row items-start gap-2">
			{leading != null ? <ChatCardLeading>{leading}</ChatCardLeading> : null}
			<Text className="min-w-0 flex-1 text-sm font-medium leading-5 text-foreground">{title}</Text>
			{badge ? <ChatCardBadge {...badge} /> : null}
			{action}
		</View>
	);
}

/** Linha da variante `activity`: ícone + conteúdo, na altura de uma linha de texto. */
export function ChatCardLine({
	leading,
	children,
	trailing,
	className,
}: {
	leading?: React.ReactNode;
	children: React.ReactNode;
	trailing?: React.ReactNode;
	className?: string;
}) {
	return (
		<View className={cn("min-w-0 flex-row items-center gap-2", className)}>
			{leading != null ? <ChatCardLeading>{leading}</ChatCardLeading> : null}
			<View className="min-w-0 flex-1">{children}</View>
			{trailing}
		</View>
	);
}

/** Botão que abre/fecha detalhes: o texto troca entre `label` e `openLabel`. */
export function ChatCardToggle({
	open,
	label,
	openLabel,
	className,
	onPress,
}: {
	open: boolean;
	label: string;
	openLabel: string;
	className?: string;
	onPress: () => void;
}) {
	return (
		<Pressable
			role="button"
			accessibilityState={{ expanded: open }}
			onPress={onPress}
			hitSlop={8}
			className={cn("shrink-0 flex-row items-center gap-1 self-start rounded-full px-1.5 py-0.5 active:bg-foreground/[0.06]", className)}
		>
			<Text className="text-xs font-medium text-muted-foreground">{open ? openLabel : label}</Text>
			<Text className={cn("text-xs text-muted-foreground", open && "rotate-90")}>›</Text>
		</Pressable>
	);
}

type ChatCardDetailsProps = {
	children: React.ReactNode;
	/** Texto fechado: "Ver detalhes" (padrão) ou "Ver tudo (n)" em lista. */
	label?: string;
	/** Texto aberto. */
	openLabel?: string;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Com `summary`, o botão fica no fim da linha dele. */
	summary?: React.ReactNode;
	className?: string;
};

/** Seção recolhível do card (mesmo vocabulário em todos: Ver detalhes / Mostrar menos). */
export function ChatCardDetails({
	children,
	label = CHAT_CARD_COPY.details,
	openLabel = CHAT_CARD_COPY.less,
	open,
	defaultOpen = false,
	onOpenChange,
	summary,
	className,
}: ChatCardDetailsProps) {
	const [inner, setInner] = React.useState(defaultOpen);
	const isOpen = open ?? inner;
	const toggle = () => {
		setInner(!isOpen);
		onOpenChange?.(!isOpen);
	};
	return (
		<View className={cn("min-w-0", className)}>
			{summary != null ? (
				<View className="min-w-0 flex-row items-center gap-2">
					<View className="min-w-0 flex-1">{summary}</View>
					<ChatCardToggle label={label} open={isOpen} openLabel={openLabel} onPress={toggle} />
				</View>
			) : (
				<ChatCardToggle className="-ml-1" label={label} open={isOpen} openLabel={openLabel} onPress={toggle} />
			)}
			{isOpen ? <View className="mt-2 min-w-0 flex-col gap-2">{children}</View> : null}
		</View>
	);
}

/** Barra de ações: primária e secundárias à esquerda, terciárias (`trailing`) à direita. */
export function ChatCardActions({ children, trailing }: { children?: React.ReactNode; trailing?: React.ReactNode }) {
	return (
		<View className="flex-row flex-wrap items-center gap-2">
			{children}
			{trailing != null ? <View className="ml-auto flex-row flex-wrap items-center gap-2">{trailing}</View> : null}
		</View>
	);
}

/** Erro do card, em caixa padrão (tom `destructive`). */
export function ChatCardError({ children }: { children: React.ReactNode }) {
	return (
		<View accessibilityRole="alert" className="rounded-xl bg-destructive/10 px-3 py-2">
			<Text className="text-sm text-destructive">{children}</Text>
		</View>
	);
}

export { chatCardVariants };
