/** Dicionário pt-BR: fonte da verdade das chaves. Um arquivo por área; acrescente o `...area` abaixo. */
import { common } from "./common";
import { library } from "./library";
import { login } from "./login";
import { settings } from "./settings";
import { ui } from "./ui";

export const ptBR = {
	...common,
	...library,
	...login,
	...settings,
	...ui,
} as const;
