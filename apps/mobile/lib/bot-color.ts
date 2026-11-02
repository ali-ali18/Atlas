// Cor de destaque do bot no app: a mesma regra do web (`botAccent`, em `@workspace/shared`): cores muito claras são
// escurecidas até o primeiro plano branco ter contraste e o primeiro plano é sempre branco. Sem cor válida cai no
// `primary` do tema (o `fallback`, que a tela monta com os tokens). Nunca se usa a cor crua do avatar em botão,
// bolinhas ou chave. (Sem importar o tema aqui: ele puxa o NativeWind, que o vitest não carrega.)
import { botAccent } from "@workspace/shared";

export type BotColors = { accent: string; foreground: string };

export function botColors(color: string | undefined, fallback: BotColors): BotColors {
	return botAccent(color) ?? fallback;
}
