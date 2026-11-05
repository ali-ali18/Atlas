import * as React from "react";
import { Image, View } from "react-native";
import { CHROME_BUTTON_SIZE } from "@/components/ui/chrome-button";
import { Text } from "@/components/ui/text";
import { initialsOf } from "@/lib/home-list";
import { useSurfaces } from "@/lib/use-surfaces";

export type UserProps = { name: string | null; email: string | null; image: string | null };

/** Foto da conta em círculo com a pele de chrome; sem foto (ou se ela falhar) as iniciais. Topo da home, Configurações e Perfil. */
export function UserAvatar({ name, email, image, size = CHROME_BUTTON_SIZE.md }: UserProps & { size?: number }) {
	const [broken, setBroken] = React.useState(false);
	const surfaces = useSurfaces();
	// Foto nova (trocada no Perfil): volta a tentar mesmo que a anterior tenha falhado.
	React.useEffect(() => setBroken(false), [image]);
	return (
		<View style={{ width: size, height: size, borderColor: surfaces.chromeEdge, backgroundColor: surfaces.chromeFill }} className="items-center justify-center overflow-hidden rounded-full border">
			{image && !broken ? (
				<Image source={{ uri: image }} onError={() => setBroken(true)} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />
			) : (
				<Text style={size > 56 ? { fontSize: Math.round(size / 3) } : undefined} className="text-control font-semibold">
					{initialsOf(name, email)}
				</Text>
			)}
		</View>
	);
}
