import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { computeAgentScope } from "@oh-my-pi/pi-coding-agent/dakera/bank";
import { resolveDakeraAgentIdOverride } from "@oh-my-pi/pi-coding-agent/dakera/agent-override";
import type { DakeraConfig } from "@oh-my-pi/pi-coding-agent/dakera/config";

const baseConfig = (overrides: Partial<DakeraConfig> = {}): DakeraConfig => ({
	apiUrl: "http://localhost:3000",
	apiToken: null,
	agentId: null,
	agentIdPrefix: "",
	scoping: "per-project",
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainImportance: 0.5,
	recallTopK: 8,
	recallMinImportance: 0,
	recallRerank: true,
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	reflectModel: null,
	debug: false,
	requestTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 60_000,
	reflectTimeoutMs: 120_000,
	...overrides,
});

/** Minimal git repo fixture with an optional `.omp/config.yml`. */
function makeRepo(configYml?: string): string {
	const dir = mkdtempSync(path.join(tmpRoot, "dakera-bank-"));
	execFileSync("git", ["init", "-q", dir]);
	if (configYml !== undefined) {
		mkdirSync(path.join(dir, ".omp"));
		writeFileSync(path.join(dir, ".omp", "config.yml"), configYml);
	}
	return dir;
}

const scratchDirs: string[] = [];
const tmpRoot = realpathSync(os.tmpdir());
afterAll(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("computeAgentScope", () => {
	describe("scoping=per-project", () => {
		it("isolates two checkouts behind two agent ids", async () => {
			expect((await computeAgentScope(baseConfig(), "/work/alpha")).agentId).toBe("omp-alpha");
			expect((await computeAgentScope(baseConfig(), "/work/beta")).agentId).toBe("omp-beta");
		});

		it("composes prefix, id and project segment", async () => {
			const config = baseConfig({ agentId: "team", agentIdPrefix: "prod" });
			expect((await computeAgentScope(config, "/work/cool-app")).agentId).toBe("prod-team-cool-app");
		});

		// Isolation lives in the id, so a retain tag would only bloat every stored
		it("attaches no retain tags", async () => {
			expect((await computeAgentScope(baseConfig(), "/work/alpha")).retainTags).toBeUndefined();
		});
	});

	describe("scoping=global", () => {
		it("keeps one shared agent id across projects", async () => {
			const config = baseConfig({ scoping: "global", agentId: "team", agentIdPrefix: "prod" });
			expect((await computeAgentScope(config, "/work/alpha")).agentId).toBe("prod-team");
			expect((await computeAgentScope(config, "/work/beta")).agentId).toBe("prod-team");
		});

		// The agent id cannot name the project here, so provenance rides on the
		// retain tags — the only place it can still be recorded.
		it("tags every retain with the project", async () => {
			expect((await computeAgentScope(baseConfig({ scoping: "global" }), "/work/alpha")).retainTags).toEqual([
				"project:alpha",
			]);
		});
	});

	it("labels an empty working directory as unknown", async () => {
		expect((await computeAgentScope(baseConfig(), "")).agentId).toBe("omp-unknown");
	});
});

describe("dakera.agentId override (.omp/config.yml walk-up)", () => {
	it("replaces the whole derived id from the repo root", async () => {
		const repo = makeRepo("dakera:\n  agentId: aeza-dev\n");
		scratchDirs.push(repo);
		expect((await computeAgentScope(baseConfig({ agentIdPrefix: "prod" }), repo)).agentId).toBe("aeza-dev");
	});

	it("applies from a subfolder of the repo", async () => {
		const repo = makeRepo("dakera:\n  agentId: aeza-dev\n");
		scratchDirs.push(repo);
		const sub = path.join(repo, "src", "deep");
		mkdirSync(sub, { recursive: true });
		expect((await computeAgentScope(baseConfig(), sub)).agentId).toBe("aeza-dev");
	});

	it("applies from a linked worktree of the repo", async () => {
		const repo = makeRepo("dakera:\n  agentId: aeza-dev\n");
		scratchDirs.push(repo);
		execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
		const worktree = mkdtempSync(path.join(tmpRoot, "dakera-wt-"));
		scratchDirs.push(worktree);
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree, "-b", "wt-branch"]);
		expect((await computeAgentScope(baseConfig(), worktree)).agentId).toBe("aeza-dev");
	});

	it("does not leak an override above the repo root into a sibling repo", async () => {
		const parent = mkdtempSync(path.join(tmpRoot, "dakera-parent-"));
		scratchDirs.push(parent);
		const outer = path.join(parent, "outer");
		mkdirSync(path.join(outer, ".omp"), { recursive: true });
		writeFileSync(path.join(outer, ".omp", "config.yml"), "dakera:\n  agentId: outer-agent\n");
		execFileSync("git", ["init", "-q", outer]);
		const inner = path.join(parent, "inner");
		execFileSync("git", ["init", "-q", inner]);
		expect((await computeAgentScope(baseConfig(), inner)).agentId).toBe(`omp-${path.basename(inner).toLowerCase()}`);
	});

	it("ignores an override whose agentId is blank or non-string", async () => {
		const repo = makeRepo('dakera:\n  agentId: ""\n');
		scratchDirs.push(repo);
		expect((await computeAgentScope(baseConfig(), repo)).agentId).toBe(
			`omp-${path.basename(realpathSync(repo)).toLowerCase()}`,
		);
	});

	it("falls back to the derived id in a repo without .omp/config.yml", async () => {
		const repo = makeRepo();
		scratchDirs.push(repo);
		expect((await computeAgentScope(baseConfig(), repo)).agentId).toBe(
			`omp-${path.basename(realpathSync(repo)).toLowerCase()}`,
		);
	});

	it("resolveDakeraAgentIdOverride returns undefined outside any repo", () => {
		expect(resolveDakeraAgentIdOverride(path.join(path.resolve(os.tmpdir()), "nowhere"))).toBeUndefined();
	});
});
