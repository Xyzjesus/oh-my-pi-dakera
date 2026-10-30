import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildNonInteractiveEnv, NON_INTERACTIVE_ENV } from "@oh-my-pi/pi-coding-agent/exec/non-interactive-env";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Writes a sequence-editor script that touches `markerPath` and exits with `exitCode`. */
async function writeEditorScript(tempDir: TempDir, markerPath: string, exitCode: number): Promise<string> {
	const editorPath = tempDir.join("sequence-editor.sh");
	await Bun.write(editorPath, `#!/bin/sh\ntouch '${markerPath}'\nexit ${exitCode}\n`);
	await fs.chmod(editorPath, 0o755);
	return editorPath;
}

/**
 * Creates a two-commit repo and returns a git runner whose env is the inherited
 * env, isolated from user/system git config, layered with `buildNonInteractiveEnv()`.
 */
async function createTwoCommitRepo(tempDir: TempDir) {
	const repoDir = tempDir.join("repo");
	const globalConfigPath = tempDir.join("gitconfig");
	await Bun.write(globalConfigPath, "");
	await fs.mkdir(repoDir);
	// Inherited git env (a user's own GIT_SEQUENCE_EDITOR or GIT_CONFIG_*, hook-provided
	// GIT_DIR) and global/system config would mask or change the behaviour under test.
	const inheritedEnv = Object.fromEntries(
		Object.entries(Bun.env).filter(([key]) => !key.startsWith("GIT_") && key !== "XDG_CONFIG_HOME"),
	);
	const isolatedEnv = {
		...inheritedEnv,
		HOME: tempDir.path(),
		GIT_CONFIG_GLOBAL: globalConfigPath,
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const spawnEnv = { ...isolatedEnv, ...buildNonInteractiveEnv(undefined, isolatedEnv) };
	const git = async (...args: string[]) => {
		const proc = Bun.spawn(["git", ...args], {
			cwd: repoDir,
			env: spawnEnv,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		return { exitCode, stderr };
	};
	for (const args of [
		["init", "-q", "-b", "main"],
		["config", "user.email", "t@example.com"],
		["config", "user.name", "t"],
	]) {
		expect(await git(...args)).toMatchObject({ exitCode: 0 });
	}
	for (const name of ["first", "second"]) {
		await Bun.write(path.join(repoDir, `${name}.txt`), `${name}\n`);
		expect(await git("add", "-A")).toMatchObject({ exitCode: 0 });
		expect(await git("commit", "-qm", name)).toMatchObject({ exitCode: 0 });
	}
	return git;
}

describe("buildNonInteractiveEnv", () => {
	it("defaults Windows child-process encoding to UTF-8 when inherited env is unset", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "win32");

		expect(env.PYTHONIOENCODING).toBe("utf-8");
		expect(env.PYTHONUTF8).toBe("1");
		expect(env.LANG).toBe("C.UTF-8");
		expect(env.LC_ALL).toBe("C.UTF-8");
	});

	it("preserves inherited Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { PYTHONUTF8: "0", LANG: "de_DE.UTF-8" }, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("preserves per-command Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv({ PYTHONUTF8: "0", LC_ALL: "en_US.UTF-8" }, {}, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBe("0");
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBe("en_US.UTF-8");
	});

	it("preserves inherited Windows LC category locales as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { LC_CTYPE: "en_US.UTF-8" }, "win32");

		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("does not force UTF-8 encoding defaults on non-Windows platforms", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("does not invent a bogus GPG_TTY", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env).not.toHaveProperty("GPG_TTY");
	});

	it("preserves per-command GPG_TTY overrides", () => {
		const env = buildNonInteractiveEnv({ GPG_TTY: "/dev/pts/7" }, {}, "linux");

		expect(env.GPG_TTY).toBe("/dev/pts/7");
	});

	it("uses an executable SSH askpass rejector on POSIX", async () => {
		if (process.platform === "win32") return;
		const proc = Bun.spawn([NON_INTERACTIVE_ENV.SSH_ASKPASS], {
			stdout: "ignore",
			stderr: "ignore",
		});

		expect(await proc.exited).toBe(1);
	});

	it("bypasses a configured git sequence.editor during interactive rebase", async () => {
		if (process.platform === "win32") return;
		using tempDir = TempDir.createSync("@omp-non-interactive-rebase-");
		const markerPath = tempDir.join("sequence-editor-ran");
		const editorPath = await writeEditorScript(tempDir, markerPath, 1);
		const git = await createTwoCommitRepo(tempDir);
		expect(await git("config", "sequence.editor", `'${editorPath}'`)).toMatchObject({ exitCode: 0 });

		const rebase = await git("rebase", "-i", "HEAD~1");

		expect(rebase).toMatchObject({ exitCode: 0 });
		expect(await fs.exists(markerPath)).toBe(false);
	});

	it("still runs a sequence.editor passed with git -c during interactive rebase", async () => {
		if (process.platform === "win32") return;
		using tempDir = TempDir.createSync("@omp-non-interactive-rebase-c-");
		const markerPath = tempDir.join("sequence-editor-ran");
		const editorPath = await writeEditorScript(tempDir, markerPath, 0);
		const git = await createTwoCommitRepo(tempDir);

		const rebase = await git("-c", `sequence.editor='${editorPath}'`, "rebase", "-i", "HEAD~1");

		expect(rebase).toMatchObject({ exitCode: 0 });
		expect(await fs.exists(markerPath)).toBe(true);
	});

	it("appends its git config entry after inherited GIT_CONFIG_* entries", () => {
		const env = buildNonInteractiveEnv(
			undefined,
			{ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "foo.bar", GIT_CONFIG_VALUE_0: "baz" },
			"linux",
		);

		expect(env).not.toHaveProperty("GIT_CONFIG_KEY_0");
		expect(env).not.toHaveProperty("GIT_CONFIG_VALUE_0");
		expect(env).toMatchObject({
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_1: "sequence.editor",
			GIT_CONFIG_VALUE_1: "true",
		});
	});

	it("injects clap-compatible CI=true by default", () => {
		expect(buildNonInteractiveEnv(undefined, {}, "linux").CI).toBe("true");
		expect(buildNonInteractiveEnv(undefined, {}, "win32").CI).toBe("true");
	});

	it("drops CI when PI_BASH_NO_CI or its legacy alias is set", () => {
		expect(buildNonInteractiveEnv(undefined, { PI_BASH_NO_CI: "1" }, "linux")).not.toHaveProperty("CI");
		expect(buildNonInteractiveEnv(undefined, { CLAUDE_BASH_NO_CI: "1" }, "linux")).not.toHaveProperty("CI");
		expect(buildNonInteractiveEnv(undefined, { PI_BASH_NO_CI: "1" }, "win32")).not.toHaveProperty("CI");
	});

	it("lets a per-command CI override win over the opt-out", () => {
		expect(buildNonInteractiveEnv({ CI: "0" }, { PI_BASH_NO_CI: "1" }, "linux").CI).toBe("0");
	});
});

it("filters expanded dotenv values while preserving matching and empty launcher values", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-env-"));
	try {
		await Bun.write(
			path.join(tmp, ".env"),
			[
				"BASE=loaded-by-omp",
				"EMPTY_PARENT_VAR=project-secret",
				"TEST_ENV_FROM_DOTENV=$BASE-suffix",
				"NODE_ENV=development",
				"export EXPORTED_SECRET=exported",
				"COMMENTED_SECRET=secret # trailing comment",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(tmp, ".env.local"),
			"CONVEX_DEPLOYMENT=anonymous:root-local\nCONVEX_URL=http://127.0.0.1:3210\n",
		);
		const procmgrPath = path.resolve(import.meta.dir, "../../utils/src/procmgr.ts");
		const script = [
			`import { getShellConfig } from ${JSON.stringify(procmgrPath)};`,
			"const env = getShellConfig().env;",
			"console.log(JSON.stringify({",
			"	project: env.TEST_ENV_FROM_DOTENV ?? null,",
			"	deployment: env.CONVEX_DEPLOYMENT ?? null,",
			"	url: env.CONVEX_URL ?? null,",
			"	inherited: env.OMP_TEST_INHERITED_MARKER ?? null,",
			"	empty: env.EMPTY_PARENT_VAR ?? null,",
			"	matching: env.NODE_ENV ?? null,",
			"	exported: env.EXPORTED_SECRET ?? null,",
			"	commented: env.COMMENTED_SECRET ?? null,",
			"}));",
		].join("\n");
		const bunArgSets = process.platform === "linux" ? [[], ["--no-env-file"]] : [["--no-env-file"]];
		for (const bunArgs of bunArgSets) {
			const proc = Bun.spawn([process.execPath, ...bunArgs, "--no-install", "--eval", script], {
				cwd: tmp,
				env: {
					HOME: process.env.HOME ?? "",
					EMPTY_PARENT_VAR: "",
					OMP_TEST_INHERITED_MARKER: "keep-me",
					NODE_ENV: "development",
					PATH: process.env.PATH ?? "",
					SHELL: process.env.SHELL ?? "/bin/bash",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			const payload: {
				project: string | null;
				deployment: string | null;
				url: string | null;
				inherited: string | null;
				empty: string | null;
				matching: string | null;
				exported: string | null;
				commented: string | null;
			} = JSON.parse(stdout);
			expect(payload).toEqual({
				project: null,
				deployment: null,
				url: null,
				inherited: "keep-me",
				matching: "development",
				empty: "",
				exported: null,
				commented: null,
			});
		}
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
});
