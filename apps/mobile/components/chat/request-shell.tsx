import * as React from "react";
import { Pressable, View } from "react-native";
import { ShieldCheckIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChatCardBadge, type ChatCardTone } from "@/components/ui/chat-card";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import { cn } from "@/lib/cn";
import { useAppColorScheme } from "@/lib/use-theme";

/**
 * Casca ÚNICA dos cartões de pedido (conectar app, login de página, segredo, questionário): o mesmo fundo e a mesma
 * borda fina do composer e das pílulas do chat (`chatChrome`), o mesmo raio e o mesmo respiro. Nenhum cartão define
 * fundo, borda ou raio próprios: monta o corpo aqui dentro. Cabeçalho (ícone + rótulo), corpo, rodapé e a nota fora do
 * cartão são opcionais.
 */
export function RequestShell({
	icon,
	label,
	badge,
	headerAction,
	footer,
	note,
	noteIcon,
	children,
	accessibilityLabel,
}: {
	icon?: React.ReactNode;
	label?: string;
	badge?: { tone: ChatCardTone; label: string };
	/** Ação pequena no canto do cabeçalho (o X do questionário). */
	headerAction?: React.ReactNode;
	footer?: React.ReactNode;
	/** Nota apagada FORA do cartão, logo abaixo. */
	note?: string;
	noteIcon?: boolean;
	children?: React.ReactNode;
	accessibilityLabel?: string;
}) {
	const chrome = chatChrome(useAppColorScheme());
	const hasHeader = !!(icon || label || badge || headerAction);
	return (
		<View className="w-full max-w-[min(68ch,100%)] gap-2 self-start" accessibilityLabel={accessibilityLabel}>
			<View className="gap-3 rounded-panel border p-4" style={{ backgroundColor: chrome.fill, borderColor: chrome.edge }}>
				{hasHeader ? (
					<View className="min-h-6 flex-row items-center gap-2">
						{icon}
						{label ? (
							<Text variant="muted" className="min-w-0 flex-1 text-body font-medium" numberOfLines={1}>
								{label}
							</Text>
						) : (
							<View className="flex-1" />
						)}
						{badge ? <ChatCardBadge {...badge} /> : null}
						{headerAction}
					</View>
				) : null}
				{children}
				{footer}
			</View>
			{note ? <RequestNote text={note} icon={noteIcon} /> : null}
		</View>
	);
}

/** Nota apagada que fica fora do cartão (com escudo quando fala de segurança). */
export function RequestNote({ text, icon = false }: { text: string; icon?: boolean }) {
	return (
		<View className="flex-row items-start gap-1.5 px-2">
			{icon ? (
				<View className="pt-px">
					<ShieldCheckIcon size={14} />
				</View>
			) : null}
			<Text variant="caption" className="min-w-0 flex-1 text-caption">
				{text}
			</Text>
		</View>
	);
}

/** Botão pílula do cartão (Autorizar, Avançar, Salvar, Continuar): o `Button` padrão do app, com carregando. */
export function RequestButton({ label, onPress, disabled = false, busy = false, variant = "default", className }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean; variant?: "default" | "secondary"; className?: string }) {
	return (
		<Button size="sm" variant={variant} disabled={disabled || busy} onPress={onPress} accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} className={cn(disabled && !busy && "opacity-40", className)}>
			{busy ? <Spinner tone={variant === "default" ? "primary-foreground" : "foreground"} /> : null}
			<Text>{label}</Text>
		</Button>
	);
}

/** Ação de texto (Voltar, Pular): sem fundo, no mesmo tamanho do botão. */
export function RequestTextButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
	return (
		<Pressable role="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={6} className="h-9 justify-center px-3 active:opacity-60">
			<Text className={cn("text-control font-semibold", disabled ? "text-muted-foreground" : "text-foreground")}>{label}</Text>
		</Pressable>
	);
}
