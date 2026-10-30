import { AVATAR_COLORS } from "@workspace/ui/lib/avatar/identity";

import type { TFunction } from "@/lib/i18n/translator";

/** Nome da cor do avatar no idioma da interface (o nome em `AVATAR_COLORS` é pt-BR, usado só como padrão). */
export function avatarColorName(value: string, t: TFunction): string {
	const found = AVATAR_COLORS.find((color) => color.value.toLowerCase() === value.toLowerCase());
	if (!found) return value;
	return t(`groups.color.${found.id}` as "groups.color.black");
}
