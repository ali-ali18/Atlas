/** Dicionário pt-BR: fonte da verdade das chaves. Um arquivo por área; acrescente o `...area` abaixo. */
import { common } from "./common";
import { library } from "./library";

export const ptBR = {
	...common,
	...library,
} as const;
