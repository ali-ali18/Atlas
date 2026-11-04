import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { ChevronRightIcon, CloseIcon, SearchIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ChromeButton } from "@/components/ui/chrome-button";
import { ChromeInput } from "@/components/ui/chrome-input";
import { Text } from "@/components/ui/text";
import type { CatalogBot } from "@/lib/catalog";
import { cn } from "@/lib/cn";
import { useSurfaces } from "@/lib/use-surfaces";

/** Botão redondo de fechar (X) do topo das telas do catálogo e dos aplicativos. */
export function CloseButton({ onPress, disabled = false }: { onPress: () => void; disabled?: boolean }) {
	return (
		<ChromeButton size="md" label="Fechar" onPress={onPress} disabled={disabled}>
			<CloseIcon size={20} tone="foreground" />
		</ChromeButton>
	);
}

/** Pílulas roláveis na horizontal: "Todos" (branca quando escolhida) e as categorias (qualquer lista de `{ id, label }`). */
export function CategoryFilters({ categories, value, onChange }: { categories: readonly { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
	const surfaces = useSurfaces();
	const items = [{ id: "", label: "Todos" }, ...categories];
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-none" contentContainerClassName="gap-2 px-4 py-3" keyboardShouldPersistTaps="handled" accessibilityRole="tablist">
			{items.map((item) => {
				const selected = item.id === value;
				return (
					<Pressable
						key={item.id || "all"}
						role="tab"
						accessibilityState={{ selected }}
						onPress={() => onChange(item.id)}
						style={selected ? undefined : { backgroundColor: surfaces.chromeFill, borderColor: surfaces.chromeEdge }}
						className={cn("h-10 items-center justify-center rounded-full border px-4 active:opacity-80", selected ? "border-transparent bg-foreground" : "")}
					>
						<Text className={cn("text-control font-medium", selected ? "text-background" : "text-foreground")}>{item.label}</Text>
					</Pressable>
				);
			})}
		</ScrollView>
	);
}

/** Título de seção. Com `onPress` ganha a seta ("Produtividade >") e tocar mostra só aquela categoria. */
export function SectionHeader({ label, onPress }: { label: string; onPress?: () => void }) {
	if (!onPress) {
		return (
			<Text accessibilityRole="header" className="px-5 pb-1 pt-5 text-lg font-semibold">
				{label}
			</Text>
		);
	}
	return (
		<Pressable role="button" accessibilityLabel={`Ver todos de ${label}`} onPress={onPress} className="flex-row items-center gap-1 px-5 pb-1 pt-5 active:opacity-70">
			<Text className="text-lg font-semibold">{label}</Text>
			<ChevronRightIcon size={20} tone="muted-foreground" />
		</Pressable>
	);
}

/** Quadrado arredondado de superfície que segura o ícone da linha (avatar do bot, logo do aplicativo). */
export function IconTile({ size = 56, children }: { size?: number; children: React.ReactNode }) {
	const surfaces = useSurfaces();
	return (
		<View style={{ width: size, height: size, borderRadius: size * 0.29, backgroundColor: surfaces.surface, borderColor: surfaces.surfaceEdge, borderWidth: 1 }} className="items-center justify-center overflow-hidden">
			{children}
		</View>
	);
}

/**
 * Linha de lista do catálogo e dos aplicativos: ícone, nome (1 linha), descrição (até 2) e o botão à direita. Tocar na
 * área da esquerda chama `onOpen`. O botão fica ao lado dela (não dentro): botão dentro de botão é inválido na web.
 */
export function ListRow({ icon, name, description, onOpen, action }: { icon: React.ReactNode; name: string; description: string; onOpen: () => void; action: React.ReactNode }) {
	return (
		<View className="flex-row items-center gap-3 px-5 py-2.5">
			<Pressable role="button" accessibilityLabel={name} onPress={onOpen} className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70">
				{icon}
				<View className="min-w-0 flex-1 gap-0.5">
					<Text numberOfLines={1} className="text-base font-semibold">
						{name}
					</Text>
					{description ? (
						<Text numberOfLines={2} variant="muted" className="text-control">
							{description}
						</Text>
					) : null}
				</View>
			</Pressable>
			{action}
		</View>
	);
}

/** Linha do bot: avatar, nome, descrição e "Instalar"/"Instalado". Tocar abre o detalhe. */
export function CatalogRowView({ bot, installed, onOpen }: { bot: CatalogBot; installed: boolean; onOpen: () => void }) {
	return (
		<ListRow
			icon={
				<IconTile>
					<Avatar color={bot.color} shape={bot.shape} size={52} animated={false} />
				</IconTile>
			}
			name={bot.name}
			description={bot.description}
			onOpen={onOpen}
			action={
				installed ? (
					<Button size="sm" variant="secondary" disabled accessibilityLabel={`${bot.name} já instalado`}>
						<Text>Instalado</Text>
					</Button>
				) : (
					<Button size="sm" variant="secondary" accessibilityLabel={`Ver ${bot.name} para instalar`} onPress={onOpen}>
						<Text>Instalar</Text>
					</Button>
				)
			}
		/>
	);
}

/** Busca fixa embaixo: campo arredondado com lupa (sobe com o teclado). */
export function CatalogSearchBar({ query, onChange, placeholder = "Buscar bots e habilidades" }: { query: string; onChange: (value: string) => void; placeholder?: string }) {
	return (
		<View className="px-5 pb-3 pt-2">
			<ChromeInput left={<SearchIcon />} value={query} onChangeText={onChange} placeholder={placeholder} autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" accessibilityLabel={placeholder} />
		</View>
	);
}
