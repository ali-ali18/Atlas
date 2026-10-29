/** Dicionário pt-BR: fonte da verdade das chaves. Um arquivo por área; acrescente o `...area` abaixo. */
import { chat } from "./chat";
import { common } from "./common";
import { composer } from "./composer";
import { library } from "./library";
import { login } from "./login";
import { settings } from "./settings";
import { sidebar } from "./sidebar";
import { ui } from "./ui";

export const ptBR = {
	...chat,
	...common,
	...composer,
	...library,
	...login,
	...settings,
	...sidebar,
	...ui,
} as const;
