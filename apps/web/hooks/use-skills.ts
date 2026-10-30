"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	createSkill,
	deleteSkill,
	deleteSkillDrafts,
	exportSkillMarkdown,
	getSkill,
	importSkillMarkdown,
	listBots,
	listBuiltinSkills,
	listSkills,
	updateSkill,
	type BuiltinSkillView,
	type SkillDocView,
} from "@/lib/atlas-api";
import { subscribeSkillProposalResolved } from "@/lib/skill-draft-handoff";
import {
	type BotRef,
	type SkillForm,
	parseToolsText,
	patchSkillInList,
	duplicateErrorMessage,
	skillErrorMessage,
	sortSkills,
	togglePatch,
	validateSkillForm,
} from "@/components/settings/skills-state";
import { activeT } from "@/lib/i18n/active";

export type SaveSkillResult = { ok: true; skill: SkillDocView } | { ok: false; error: string };

/**
 * Habilidades da conta (todas as escopos) + bots para o filtro. Switch e edição
 * são otimistas: a lista muda na hora e volta ao estado anterior se a API recusar.
 */
export function useSkills(enabled = true) {
	const [skills, setSkills] = useState<SkillDocView[]>([]);
	const [builtins, setBuiltins] = useState<BuiltinSkillView[]>([]);
	const [bots, setBots] = useState<BotRef[]>([]);
	const [loading, setLoading] = useState(enabled);
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const requestRef = useRef(0);

	const load = useCallback(() => {
		const request = ++requestRef.current;
		setLoading(true);
		setError(null);
		Promise.all([listSkills(), listBots().catch(() => []), listBuiltinSkills().catch(() => [])])
			.then(([nextSkills, nextBots, nextBuiltins]) => {
				if (request !== requestRef.current) return;
				setSkills(sortSkills(nextSkills));
				setBuiltins(nextBuiltins);
				setBots(nextBots.map((bot) => ({ id: bot.id, name: bot.name })));
			})
			.catch(() => {
				if (request === requestRef.current) setError(activeT("errors.loadSkills"));
			})
			.finally(() => {
				if (request === requestRef.current) setLoading(false);
			});
	}, []);

	useEffect(() => {
		if (!enabled) return;
		load();
		return () => {
			requestRef.current++;
		};
	}, [enabled, load]);

	// Proposta do agente resolvida (card do chat ou "Editar antes"): a lista pode ter mudado.
	useEffect(() => (enabled ? subscribeSkillProposalResolved(() => load()) : undefined), [enabled, load]);

	const toggle = useCallback(
		async (skill: SkillDocView, next: boolean) => {
			const before = skills;
			const patch = togglePatch(skill, next);
			setActionError(null);
			setSkills((current) => patchSkillInList(current, skill.id, patch));
			try {
				const saved = await updateSkill(skill.id, patch);
				setSkills((current) => patchSkillInList(current, skill.id, saved));
			} catch (cause) {
				setSkills(before);
				setActionError(skillErrorMessage(cause));
			}
		},
		[skills],
	);

	const remove = useCallback(async (skill: SkillDocView): Promise<boolean> => {
		setActionError(null);
		try {
			await deleteSkill(skill.id);
			setSkills((current) => current.filter((item) => item.id !== skill.id));
			return true;
		} catch (cause) {
			setActionError(skillErrorMessage(cause));
			return false;
		}
	}, []);

	/** Apaga os rascunhos do escopo (a API só apaga rascunhos do dono) e recarrega a lista. */
	const removeDrafts = useCallback(
		async (scope: { botId?: string; account?: boolean }): Promise<number | null> => {
			setActionError(null);
			try {
				const deleted = await deleteSkillDrafts(scope);
				load();
				return deleted;
			} catch (cause) {
				setActionError(skillErrorMessage(cause));
				return null;
			}
		},
		[load],
	);

	const importMarkdown = useCallback(async (text: string): Promise<SkillDocView | null> => {
		setActionError(null);
		try {
			const skill = await importSkillMarkdown(text);
			setSkills((current) => sortSkills([...current, skill]));
			return skill;
		} catch (cause) {
			setActionError(skillErrorMessage(cause));
			return null;
		}
	}, []);

	const save = useCallback(
		async (editing: SkillDocView | null, form: SkillForm): Promise<SaveSkillResult> => {
			const checked = validateSkillForm(form);
			if (!checked.ok) return { ok: false, error: Object.values(checked.errors).join(" ") };
			const before = skills;
			try {
				if (!editing) {
					const created = await createSkill(checked.input);
					setSkills((current) => sortSkills([...current, created]));
					return { ok: true, skill: created };
				}
				const { name, description, body, tools } = checked.input;
				setSkills((current) =>
					sortSkills(patchSkillInList(current, editing.id, { name, description, tools: tools ?? parseToolsText(form.toolsText) })),
				);
				const saved = await updateSkill(editing.id, { name, description, body, tools, revision: editing.revision });
				setSkills((current) => sortSkills(patchSkillInList(current, editing.id, saved)));
				return { ok: true, skill: saved };
			} catch (cause) {
				setSkills(before);
				return { ok: false, error: skillErrorMessage(cause) };
			}
		},
		[skills],
	);

	const loadFull = useCallback((id: string) => getSkill(id), []);
	const exportText = useCallback((id: string) => exportSkillMarkdown(id), []);

	/** "Duplicar para editar": cria a cópia na conta com o mesmo nome (a do dono vence a de fábrica). */
	const duplicateBuiltin = useCallback(async (builtin: BuiltinSkillView): Promise<SaveSkillResult> => {
		setActionError(null);
		try {
			const created = await createSkill({
				name: builtin.slug,
				description: builtin.description,
				body: builtin.body,
				botId: null,
			});
			setSkills((current) => sortSkills([...current, created]));
			return { ok: true, skill: created };
		} catch (cause) {
			return { ok: false, error: duplicateErrorMessage(cause) };
		}
	}, []);

	return {
		skills,
		builtins,
		duplicateBuiltin,
		bots,
		loading,
		error,
		actionError,
		clearActionError: () => setActionError(null),
		reload: load,
		toggle,
		remove,
		removeDrafts,
		importMarkdown,
		save,
		loadFull,
		exportText,
	};
}
