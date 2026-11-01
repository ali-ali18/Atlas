import * as React from "react";
import { View } from "react-native";
import { GridPlusIcon, SearchIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

/** Rodapé fixo: botão de grade (placeholder) e a barra "Buscar" em pílula, que filtra a lista na hora. */
export function SearchFooter({ query, onChange, onGrid }: { query: string; onChange: (value: string) => void; onGrid: () => void }) {
	return (
		<View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
			<Button size="icon" variant="secondary" accessibilityLabel="Apps" className="border-border" onPress={onGrid}>
				<GridPlusIcon />
			</Button>
			<InputGroup className="flex-1 border-border bg-secondary">
				<InputGroupAddon>
					<SearchIcon />
				</InputGroupAddon>
				<InputGroupInput
					className="web:outline-none"
					value={query}
					onChangeText={onChange}
					placeholder="Buscar"
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="search"
					clearButtonMode="while-editing"
					accessibilityLabel="Buscar bots e conversas"
				/>
			</InputGroup>
		</View>
	);
}
