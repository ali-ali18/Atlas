/** Dicionário en-US. Precisa ter toda chave do pt-BR (o typecheck e o teste de paridade garantem). */
import type { MessageDictionary } from "../../translator";
import { common } from "./common";
import { library } from "./library";

export const enUS: MessageDictionary = {
	...common,
	...library,
};
