/** Dicionário pt-BR: fonte da verdade das chaves. Um arquivo por área; acrescente o `...area` abaixo. */
import { common } from "./common";
import { library } from "./library";
import { login } from "./login";
import { settings } from "./settings";
import { sidebar } from "./sidebar";
import { ui } from "./ui";

export const ptBR = {
	...common,
	...library,
	...login,
	...settings,
	...sidebar,
	...ui,
} as const;
