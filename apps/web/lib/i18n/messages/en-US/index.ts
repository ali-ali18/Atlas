/** Dicionário en-US. Precisa ter toda chave do pt-BR (o typecheck e o teste de paridade garantem). */
import type { MessageDictionary } from "../../translator";
import { common } from "./common";
import { library } from "./library";
import { login } from "./login";
import { settings } from "./settings";
import { ui } from "./ui";

export const enUS: MessageDictionary = {
	...common,
	...library,
	...login,
	...settings,
	...ui,
};
