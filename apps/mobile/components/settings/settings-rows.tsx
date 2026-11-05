import * as React from "react";
import { View } from "react-native";
import { ChevronRightIcon } from "@/components/icons";
import { SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/** Rótulo pequeno de uma seção (Bot, App) acima de um grupo, como no Grok. */
export function SectionLabel({ children }: { children: string }) {
	return (
		<Text variant="muted" className="px-5 pb-2 pt-7 text-body">
			{children}
		</Text>
	);
}

function RowText({ title, subtitle, tone, dimmed }: { title: string; subtitle?: string | null; tone?: "default" | "destructive"; dimmed?: boolean }) {
	return (
		<View className="min-w-0 flex-1 py-3.5" style={dimmed ? { opacity: 0.5 } : undefined}>
			<Text className={tone === "destructive" ? "text-lg text-destructive" : "text-lg"}>{title}</Text>
			{subtitle ? (
				<Text variant="muted" className="pt-0.5 text-body">
					{subtitle}
				</Text>
			) : null}
		</View>
	);
}

/** Linha que abre algo: título, apoio opcional embaixo, valor à direita e seta (`chevron={false}` quando só mostra valor). */
export function NavRow({ title, subtitle, value, onPress, chevron = true, disabled = false, tone = "default" }: { title: string; subtitle?: string | null; value?: string | null; onPress?: () => void; chevron?: boolean; disabled?: boolean; tone?: "default" | "destructive" }) {
	return (
		<SurfaceRow label={title} onPress={disabled ? undefined : onPress} className="justify-between">
			<RowText title={title} subtitle={subtitle} tone={tone} dimmed={disabled} />
			{value ? (
				<Text variant="muted" numberOfLines={1} className="max-w-[45%] shrink-0 text-control" style={disabled ? { opacity: 0.5 } : undefined}>
					{value}
				</Text>
			) : null}
			{chevron && !disabled ? <ChevronRightIcon /> : null}
		</SurfaceRow>
	);
}

/** Linha com interruptor à direita (o `ToggleSwitch` do app). */
export function ToggleRow({ title, subtitle, value, onValueChange, disabled }: { title: string; subtitle?: string | null; value: boolean; onValueChange: (value: boolean) => void; disabled?: boolean }) {
	return (
		<SurfaceRow className="justify-between">
			<RowText title={title} subtitle={subtitle} />
			<ToggleSwitch value={value} onValueChange={onValueChange} disabled={disabled} accessibilityLabel={title} />
		</SurfaceRow>
	);
}
