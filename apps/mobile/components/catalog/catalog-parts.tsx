import * as React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { ChevronRightIcon, CloseIcon, SearchIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Text } from "@/components/ui/text";
import type { CatalogBot, CategoryOption } from "@/lib/catalog";
import { cn } from "@/lib/cn";

/** Botão redondo de fechar (X) do topo das telas do catálogo. */
export function CloseButton({ onPress, disabled = false }: { onPress: () => void; disabled?: boolean }) {
	return (
		<Pressable role="button" accessibilityLabel="Fechar" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} className={cn("size-11 items-center justify-center rounded-full bg-secondary active:opacity-70", disabled && "opacity-40")}>
			<CloseIcon size={20} tone="foreground" />
		</Pressable>
	);
}

/** Pílulas roláveis na horizontal: "Todos" (branca quando escolhida) e as categorias do catálogo. */
export function CategoryFilters({ categories, value, onChange }: { categories: readonly CategoryOption[]; value: string; onChange: (id: string) => void }) {
	const items = [{ id: "", label: "Todos" }, ...categories];
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-none" contentContainerClassName="gap-2 px-4 py-3" keyboardShouldPersistTaps="handled" accessibilityRole="tablist">
			{items.map((item) => {
				const selected = item.id === value;
				return (
					<Pressable key={item.id || "all"} role="tab" accessibilityState={{ selected }} onPress={() => onChange(item.id)} className={cn("h-10 items-center justify-center rounded-full px-4 active:opacity-80", selected ? "bg-foreground" : "bg-secondary")}>
						<Text className={cn("text-control font-medium", selected ? "text-background" : "text-foreground")}>{item.label}</Text>
					</Pressable>
				);
			})}
		</ScrollView>
	);
}

/** Título de seção com seta ("Produtividade >"): tocar mostra só aquela categoria. */
export function SectionHeader({ label, onPress }: { label: string; onPress: () => void }) {
	return (
		<Pressable role="button" accessibilityLabel={`Ver todos de ${label}`} onPress={onPress} className="flex-row items-center gap-1 px-5 pb-1 pt-5 active:opacity-70">
			<Text className="text-lg font-semibold">{label}</Text>
			<ChevronRightIcon size={20} tone="muted-foreground" />
		</Pressable>
	);
}

/** Linha do bot: avatar quadrado arredondado, nome (1 linha), descrição (até 2) e o botão à direita. Tocar abre o detalhe. */
export function CatalogRowView({ bot, installed, onOpen }: { bot: CatalogBot; installed: boolean; onOpen: () => void }) {
	return (
		<View className="flex-row items-center gap-3 px-5 py-2.5">
			{/* O botão fica ao lado da área tocável (não dentro dela): botão dentro de botão é inválido na web. */}
			<Pressable role="button" accessibilityLabel={bot.name} onPress={onOpen} className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70">
				<View className="size-14 items-center justify-center rounded-2xl bg-secondary">
					<Avatar color={bot.color} shape={bot.shape} size={52} animated={false} />
				</View>
				<View className="min-w-0 flex-1 gap-0.5">
					<Text numberOfLines={1} className="text-base font-semibold">
						{bot.name}
					</Text>
					{bot.description ? (
						<Text numberOfLines={2} variant="muted" className="text-control">
							{bot.description}
						</Text>
					) : null}
				</View>
			</Pressable>
			{installed ? (
				<Button size="sm" variant="secondary" disabled accessibilityLabel={`${bot.name} já instalado`}>
					<Text>Instalado</Text>
				</Button>
			) : (
				<Button size="sm" variant="secondary" accessibilityLabel={`Ver ${bot.name} para instalar`} onPress={onOpen}>
					<Text>Instalar</Text>
				</Button>
			)}
		</View>
	);
}

/** Busca fixa embaixo: campo arredondado com lupa (sobe com o teclado). */
export function CatalogSearchBar({ query, onChange }: { query: string; onChange: (value: string) => void }) {
	return (
		<View className="px-5 pb-3 pt-2">
			<InputGroup className="border-border bg-secondary">
				<InputGroupAddon>
					<SearchIcon />
				</InputGroupAddon>
				<InputGroupInput
					className="web:outline-none"
					value={query}
					onChangeText={onChange}
					placeholder="Buscar bots e habilidades"
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="search"
					clearButtonMode="while-editing"
					accessibilityLabel="Buscar bots e habilidades"
				/>
			</InputGroup>
		</View>
	);
}
