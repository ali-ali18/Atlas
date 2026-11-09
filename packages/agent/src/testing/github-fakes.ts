// Fake do GitHub para teste: repositórios por DONO (outro dono não lista nem compara), chamadas registradas e falha injetável.
import type { Github, GithubCompareInput, GithubRepoView } from "../ports/github.js";

export class FakeGithub implements Github {
	readonly listed: string[] = [];
	readonly compared: Array<{ ownerId: string; input: GithubCompareInput }> = [];
	/** Erro que as próximas chamadas lançam (null = sem falha). */
	fail: Error | null = null;
	constructor(private readonly repos: Array<GithubRepoView & { owner: string }> = []) {}

	seed(owner: string, repo: Partial<GithubRepoView> & Pick<GithubRepoView, "fullName">): void {
		this.repos.push({ owner, private: false, defaultBranch: "main", pushedAt: null, ...repo });
	}

	async listRepos(ownerId: string): Promise<GithubRepoView[]> {
		this.listed.push(ownerId);
		if (this.fail) throw this.fail;
		return this.repos.filter((repo) => repo.owner === ownerId).map(({ owner: _owner, ...view }) => (void _owner, view));
	}

	async compare(ownerId: string, input: GithubCompareInput): Promise<string> {
		this.compared.push({ ownerId, input });
		if (this.fail) throw this.fail;
		const visible = this.repos.some((repo) => repo.owner === ownerId && repo.fullName.toLowerCase() === input.repo.toLowerCase());
		// Repositório de outro dono = "não achei", igual ao GitHub real com o token do dono.
		if (!visible) throw new Error(`Could not compare on GitHub (Not Found). Hint: check the repository name and that you can see it.`);
		return `Compare ${input.repo} ${input.base}...${input.head}: 2 commits, 3 files changed.${input.includePatch ? " (patches included)" : ""}`;
	}

	readonly ports = { github: this as Github };
}
