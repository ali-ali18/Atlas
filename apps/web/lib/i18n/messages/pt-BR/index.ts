/** Dicionário pt-BR: fonte da verdade das chaves. Um arquivo por área; acrescente o `...area` abaixo. */
import { common } from "./common";
import { library } from "./library";
import { settings } from "./settings";

export const ptBR = {
	...common,
	...library,
	...settings,
} as const;
