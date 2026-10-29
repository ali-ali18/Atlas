/** Dicionário pt-BR: fonte da verdade das chaves. Um arquivo por área; acrescente o `...area` abaixo. */
import { app } from "./app";
import { chat } from "./chat";
import { common } from "./common";
import { composer } from "./composer";
import { library } from "./library";
import { login } from "./login";
import { marketplace } from "./marketplace";
import { mobile } from "./mobile";
import { settings } from "./settings";
import { sidebar } from "./sidebar";
import { ui } from "./ui";

export const ptBR = {
	...app,
	...chat,
	...common,
	...composer,
	...library,
	...login,
	...marketplace,
	...mobile,
	...settings,
	...sidebar,
	...ui,
} as const;
