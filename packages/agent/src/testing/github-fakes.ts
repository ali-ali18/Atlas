// Fake do GitHub para teste: repositórios por DONO (outro dono não lista nem compara), chamadas registradas e falha injetável.
import type { Github, GithubCompareInput, GithubRepoView, GithubWriteAction, GithubWriteReceipt, GithubWriter } from "../ports/github.js";

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

/** Fake da escrita: o app só está instalado nos repositórios semeados DO DONO (outro dono = "app não instalado"). */
export class FakeGithubWriter implements GithubWriter {
	readonly writes: Array<{ ownerId: string; action: GithubWriteAction }> = [];
	private readonly installed = new Set<string>();
	/** Erro que as próximas escritas lançam (null = sem falha). */
	fail: Error | null = null;

	install(ownerId: string, repo: string): void {
		this.installed.add(`${ownerId}:${repo.toLowerCase()}`);
	}

	async write(ownerId: string, action: GithubWriteAction): Promise<GithubWriteReceipt> {
		if (!this.installed.has(`${ownerId}:${action.repo.toLowerCase()}`)) throw new Error(`Nothing was sent: the GitHub app is not installed on ${action.repo} or lacks permission there. Tell the owner to install it in Settings → Connections → GitHub, then ask again.`);
		if (this.fail) throw this.fail;
		this.writes.push({ ownerId, action });
		const number = "number" in action ? action.number : 7;
		return { text: `${action.kind} done on ${action.repo}`, url: `https://github.com/${action.repo}/issues/${number}`, number };
	}
}
