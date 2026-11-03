import * as React from "react";
import { View } from "react-native";
import { GridPlusIcon, SearchIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { ChromeInput } from "@/components/ui/chrome-input";

/** Rodapé fixo: botão de grade (abre o catálogo de bots prontos) e a barra "Buscar" em pílula, que filtra a lista na hora. */
export function SearchFooter({ query, onChange, onGrid }: { query: string; onChange: (value: string) => void; onGrid: () => void }) {
	return (
		<View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
			<ChromeButton size="md" label="Bots prontos" onPress={onGrid}>
				<GridPlusIcon />
			</ChromeButton>
			<ChromeInput
				containerClassName="flex-1"
				left={<SearchIcon />}
				value={query}
				onChangeText={onChange}
				placeholder="Buscar"
				autoCapitalize="none"
				autoCorrect={false}
				returnKeyType="search"
				clearButtonMode="while-editing"
				accessibilityLabel="Buscar bots e conversas"
			/>
		</View>
	);
}
