// Presets de POLÍTICA do código (F8.2): `plan` e `build`. Diferem dos presets de capacidades (`presets.ts`): não dizem quais
// tools existem, dizem o que a política do run deixa elas fazerem. São funções puras `RunPolicy -> RunPolicy` sobre a política
// do `decide()`: acrescentam regras `deny` no FIM da lista (a última que casa vence, e regra `run` do dono não afrouxa
// `deny` nem o piso de `confirm`/taint/trifeta, que o `decide()` aplica depois). Nunca removem regra nem sobem autonomia.
//
//  - `plan`: lê, busca e olha o diff; nada muda. Esconde TODA tool `code_*` que não seja `read` (editar, escrever, rodar teste
//    ou comando que muda coisa) e todo efeito que sai do Atlas (envio, dinheiro, link, credencial, destrutivo, escrita externa).
//    Decisão sobre testes: `plan` NÃO roda teste, porque teste executa código do repositório (pode escrever em qualquer lugar do
//    workspace). Comando só de leitura (ls, cat, rg, git log) roda, porque a classe dele é `read`. Notas internas do bot
//    (lista de tarefas, memória) seguem livres: planejar também é anotar.
//  - `build`: edita e roda comando permitido, com as regras do portão (`.env`, caminho sensível e comando fora da allowlist
//    pedem o dono, vindo do próprio `decide()`). Sem dono no run (agenda, rotina, subagente), `build` vira leitura: um run
//    sem ninguém para ver não escreve no repositório de ninguém.
//
// Filho nunca excede a mãe: `childPolicy` copia as regras da mãe (as `deny` ficam) e acrescenta o piso de só-leitura.
import type { PolicyRule, RunPolicy } from "@workspace/shared";
import { EFFECT_CLASSES, type EffectClass } from "@workspace/shared";

export const POLICY_PRESET_IDS = ["plan", "build"] as const;
export type PolicyPresetId = (typeof POLICY_PRESET_IDS)[number];

export function isPolicyPresetId(value: unknown): value is PolicyPresetId {
	return typeof value === "string" && (POLICY_PRESET_IDS as readonly string[]).includes(value);
}

/** Tudo que muda algo, menos `read`. */
const NON_READ: readonly EffectClass[] = EFFECT_CLASSES.filter((effect) => effect !== "read");
/** Efeitos que saem do Atlas ou não têm volta: o `plan` não os oferece em tool nenhuma. */
const EXTERNAL: readonly EffectClass[] = ["write_external", "send", "money", "public_link", "credential", "destructive"];

const denyCode = (effects: readonly EffectClass[]): PolicyRule[] => effects.map((effect) => ({ match: "code_*", effect, verdict: "deny" }));
const denyAll = (effects: readonly EffectClass[]): PolicyRule[] => effects.map((effect) => ({ match: "*", effect, verdict: "deny" }));

export const PLAN_RULES: readonly PolicyRule[] = Object.freeze([...denyCode(NON_READ), ...denyAll(EXTERNAL)]);
export const BUILD_UNATTENDED_RULES: readonly PolicyRule[] = Object.freeze(denyCode(NON_READ));

export function applyPolicyPreset(id: PolicyPresetId, base: RunPolicy): RunPolicy {
	switch (id) {
		case "plan":
			return { ...base, rules: [...base.rules, ...PLAN_RULES] };
		case "build":
			// Com dono: a política do run como está (o `decide()` já pede o dono onde o portão manda). Sem dono: só lê.
			return base.ownerPresent && base.surface !== "agenda" && base.surface !== "routine" && base.surface !== "subagent" && base.surface !== "bot_to_bot" ? { ...base } : { ...base, rules: [...base.rules, ...BUILD_UNATTENDED_RULES] };
	}
}
