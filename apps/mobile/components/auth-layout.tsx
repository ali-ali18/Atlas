import * as React from "react";
import { View } from "react-native";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";

/**
 * Cabeçalho das telas de entrada, montado a partir de apps/web/app/login/page.tsx: mascote no topo
 * (no web é o ícone num quadrado `bg-primary`; no celular o painel de marca não existe e o avatar branco
 * do Atlas, o mesmo do painel, ocupa o lugar), título `text-xl` e subtítulo `text-sm` centralizados.
 */
export function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
	// Com o teclado aberto o espaço é curto: o mascote encolhe para o campo e o botão ficarem à vista.
	const keyboardOpen = useKeyboardVisible();
	return (
		<View className="items-center gap-2">
			<Avatar ariaLabel="Avatar do Atlas Agent" size={keyboardOpen ? 64 : 102} mood="happy" />
			<Text className="text-center text-xl font-semibold tracking-tight">{title}</Text>
			<Text variant="muted" className="text-center text-sm">
				{subtitle}
			</Text>
		</View>
	);
}

/** Coluna central `max-w-sm space-y-4` do login do web. */
export function AuthColumn({ children }: { children: React.ReactNode }) {
	return <View className="w-full max-w-sm gap-3 self-center">{children}</View>;
}

/** Divisor "ou" do login do web (`AuthDivider`). */
export function AuthDivider({ children }: { children: string }) {
	return (
		<View className="w-full flex-row items-center gap-3">
			<View className="h-px flex-1 bg-border" />
			<Text variant="muted" className="text-xs uppercase tracking-wider">
				{children}
			</Text>
			<View className="h-px flex-1 bg-border" />
		</View>
	);
}

/** Rodapé `login.privateInstance`. */
export function AuthFootnote({ children }: { children: string }) {
	return (
		<Text variant="muted" className="text-center text-xs">
			{children}
		</Text>
	);
}
