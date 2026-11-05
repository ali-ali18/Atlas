import * as React from "react";
import { View } from "react-native";
import { CheckIcon } from "@/components/icons";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";

/** Uma opção da gaveta; `description` é o apoio de uma linha embaixo do rótulo (ex.: o que cada nível de permissão faz). */
export type Option = { value: string; label: string; description?: string };

/** Gaveta com uma lista de opções (uma escolhida): o seletor das linhas "Idioma", "Permissões", "Aparência". É o `DraggableSheet` do menu da mensagem. */
export function OptionSheet({ open, title, options, value, onPick, onClose }: { open: boolean; title: string; options: readonly Option[]; value: string; onPick: (value: string) => void; onClose: () => void }) {
	return (
		<DraggableSheet visible={open} onClose={onClose} header={<Text variant="heading">{title}</Text>}>
			<SurfaceGroup>
				{options.map((option) => (
					<SurfaceRow key={option.value} label={option.label} radio={{ checked: option.value === value }} onPress={() => onPick(option.value)} className="justify-between py-2">
						<View className="min-w-0 flex-1">
							<Text className="text-control">{option.label}</Text>
							{option.description ? (
								<Text variant="muted" className="pt-0.5 text-body">
									{option.description}
								</Text>
							) : null}
						</View>
						{option.value === value ? <CheckIcon /> : null}
					</SurfaceRow>
				))}
			</SurfaceGroup>
		</DraggableSheet>
	);
}
