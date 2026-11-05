import * as React from "react";
import { View } from "react-native";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import { appVersionLabel } from "@/lib/app-version";
import { useSurfaces } from "@/lib/use-surfaces";

/** Rodapé: o mascote (squircle, como o ícone do app), o nome e a versão (com o início do id da atualização, se houver). */
export function SettingsFooter() {
	const surfaces = useSurfaces();
	const version = React.useMemo(appVersionLabel, []);
	return (
		<View className="items-center gap-1 pb-4 pt-10">
			<Avatar shape="squircle" size={96} animated={false} eyeColor={surfaces.screen} />
			<Text className="pt-1 text-xl">Atlas</Text>
			{version ? (
				<Text variant="muted" className="text-control">
					{version}
				</Text>
			) : null}
		</View>
	);
}
