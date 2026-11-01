import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

// run-rs-task.ts decides whether the Rust half of `bun check` runs. Each case
// copies the real script into a throwaway git repo and runs `check:rs` there with
// `cargo` shadowed by a stub on PATH, so a case observes exactly what a
// contributor does: whether cargo ran, the line the gate printed, and its exit
// code. No Rust is built.

const SCRIPT = path.join(import.meta.dir, "run-rs-task.ts");
const cleanups: (() => Promise<void>)[] = [];
// Each case builds and clones a repository and spawns bun; on a loaded host
// that outruns bun's 5 s default.
const CASE_TIMEOUT_MS = 30_000;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Fixture {
	root: string;
	/** Bare-bones stand-in for the main repository: two commits on `main`. */
	origin: string;
	/** A full clone of `origin`, so `origin/main` exists. */
	work: string;
	shimDir: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await $`git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false ${args}`
		.cwd(cwd)
		.quiet();
	return result.text();
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function makeFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-run-rs-task-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const origin = path.join(root, "origin");
	const work = path.join(root, "work");
	const shimDir = path.join(root, "bin");
	// `rustup` fails so the script falls back to the `cargo` on PATH: the stub.
	await writeExecutable(path.join(shimDir, "rustup"), "#!/bin/sh\nexit 1\n");
	await writeExecutable(path.join(shimDir, "cargo"), '#!/bin/sh\necho "cargo-stub $*"\n');

	await Bun.write(path.join(origin, "scripts/run-rs-task.ts"), Bun.file(SCRIPT));
	await Bun.write(path.join(origin, "packages/app/src/a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(origin, "crates/x/src/lib.rs"), "pub fn x() {}\n");
	await git(origin, "init", "-q", "-b", "main");
	await git(origin, "add", "-A");
	await git(origin, "commit", "-q", "-m", "base");
	// A second commit, so a depth-1 clone is really shallow.
	await commitFile(origin, "packages/app/src/a.ts", "export const a = 2;\n", "second");
	await git(root, "clone", "-q", origin, work);
	return { root, origin, work, shimDir };
}

async function commitFile(repo: string, file: string, content: string, message: string): Promise<void> {
	await Bun.write(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", message);
}

async function runCheckRs(
	fixture: Fixture,
	cwd: string,
	env: Record<string, string> = {},
): Promise<{ exitCode: number; output: string; cargoRan: boolean }> {
	const base: Record<string, string | undefined> = { ...process.env };
	// The ambient environment must not decide the case: an omp shell exports
	// CI=true, a GitHub runner exports GITHUB_ACTIONS, and a git hook exports GIT_DIR.
	for (const key of ["CI", "GITHUB_ACTIONS", "OMP_FORCE_RUST_TASKS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
		delete base[key];
	}
	const proc = Bun.spawn([process.execPath, "scripts/run-rs-task.ts", "check:rs"], {
		cwd,
		env: { ...base, ...env, PATH: `${fixture.shimDir}${path.delimiter}${process.env.PATH ?? ""}` },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const output = `${stdout}${stderr}`;
	return { exitCode, output, cargoRan: output.includes("cargo-stub clippy") };
}

describe.skipIf(process.platform === "win32")("run-rs-task.ts check:rs", () => {
	// Failure mode: a contributor commits a Rust change, runs `bun check` on the
	// clean tree, and gets a green gate that never looked at their Rust.
	test(
		"a committed Rust change on a clean tree runs the Rust gate and names the file",
		async () => {
			const fixture = await makeFixture();
			await git(fixture.work, "switch", "-q", "-c", "feature");
			await commitFile(fixture.work, "crates/x/src/lib.rs", "pub fn x() -> u8 { 1 }\n", "rust change");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("crates/x/src/lib.rs");
			expect(result.exitCode).toBe(0);
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: omp exports CI=true into every agent command, so every agent's
	// `bun check` on a TypeScript-only change pays a full `cargo clippy --workspace`;
	// or the gate skips without saying so.
	test(
		"a TypeScript-only commit skips the Rust half under CI=true and says why",
		async () => {
			const fixture = await makeFixture();
			await git(fixture.work, "switch", "-q", "--detach");
			await commitFile(fixture.work, "packages/app/src/a.ts", "export const a = 3;\n", "ts change");

			const result = await runCheckRs(fixture, fixture.work, { CI: "true" });

			expect(result.cargoRan).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Skipping check:rs");
			expect(result.output).toContain("origin/main");
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: an edited but uncommitted Rust file skips the gate.
	test(
		"an uncommitted Rust edit runs the Rust gate",
		async () => {
			const fixture = await makeFixture();
			await Bun.write(path.join(fixture.work, "crates/x/src/lib.rs"), "pub fn x() -> u8 { 2 }\n");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(true);
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: a gate that runs the Rust half for any dirty tree charges every
	// TypeScript edit a full `cargo clippy --workspace`.
	test(
		"an uncommitted TypeScript edit skips the Rust gate",
		async () => {
			const fixture = await makeFixture();
			await Bun.write(path.join(fixture.work, "packages/app/src/a.ts"), "export const a = 4;\n");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(false);
			expect(result.output).toContain("Skipping check:rs");
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: `git status` folds an untracked directory into one
	// `crates/newcrate/` entry, so a brand-new crate looks like no Rust change at all.
	test(
		"a new untracked crate runs the Rust gate",
		async () => {
			const fixture = await makeFixture();
			await Bun.write(path.join(fixture.work, "crates/newcrate/Cargo.toml"), '[package]\nname = "newcrate"\n');
			await Bun.write(path.join(fixture.work, "crates/newcrate/src/lib.rs"), "pub fn y() {}\n");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("crates/newcrate/");
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: a two-dot diff against main's tip reports main's own newer
	// commits as the branch's, so a TypeScript branch that has not merged main
	// looks like it changed Rust.
	test(
		"a branch behind main does not take main's newer Rust commit as its own",
		async () => {
			const fixture = await makeFixture();
			await git(fixture.work, "switch", "-q", "-c", "feature");
			await commitFile(fixture.work, "packages/app/src/a.ts", "export const a = 3;\n", "ts change");
			await commitFile(fixture.origin, "crates/x/src/lib.rs", "pub fn x() -> u8 { 3 }\n", "main rust change");
			await git(fixture.work, "fetch", "-q", "origin");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(false);
			expect(result.output).toContain("Skipping check:rs");
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: a gate that gives up on every shallow clone charges the full Rust
	// half, on every `bun check`, to anyone who cloned with `--depth`.
	test(
		"a shallow clone that reaches its merge base skips a TypeScript-only commit",
		async () => {
			const fixture = await makeFixture();
			const shallow = path.join(fixture.root, "shallow");
			await git(fixture.root, "clone", "-q", "--depth", "1", `file://${fixture.origin}`, shallow);
			await commitFile(shallow, "packages/app/src/a.ts", "export const a = 3;\n", "ts change");

			const result = await runCheckRs(fixture, shallow);

			expect(result.cargoRan).toBe(false);
			expect(result.output).toContain("Skipping check:rs");
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: actions/checkout clones at depth 1 by default. A gate that read
	// "no common ancestor in the fetched history" as "no change" would switch off the
	// Rust gate there; one that ran without saying how to stop it would run forever.
	test(
		"a shallow clone cut above its merge base runs the Rust gate and names the cure",
		async () => {
			const fixture = await makeFixture();
			await git(fixture.origin, "switch", "-q", "-c", "feature", "HEAD~1");
			await commitFile(fixture.origin, "packages/app/src/a.ts", "export const a = 3;\n", "ts change");
			await git(fixture.origin, "switch", "-q", "main");
			const shallow = path.join(fixture.root, "shallow");
			await git(
				fixture.root,
				"clone",
				"-q",
				"--depth",
				"1",
				"--no-single-branch",
				`file://${fixture.origin}`,
				shallow,
			);
			await git(shallow, "switch", "-q", "feature");

			const result = await runCheckRs(fixture, shallow);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("shallow clone");
			expect(result.output).toContain("git fetch --unshallow");
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: a checkout with nothing to diff against (no remote, a renamed
	// remote, a one-commit repository) reads as "no change" and skips; or it runs
	// on every `bun check` without saying how to make it stop.
	test(
		"a repository with no main ref to diff against runs the Rust gate and names the cure",
		async () => {
			const fixture = await makeFixture();
			const lone = path.join(fixture.root, "lone");
			await Bun.write(path.join(lone, "scripts/run-rs-task.ts"), Bun.file(SCRIPT));
			await git(fixture.root, "init", "-q", "-b", "main", lone);
			await git(lone, "add", "-A");
			await git(lone, "commit", "-q", "-m", "only commit");

			const result = await runCheckRs(fixture, lone);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("cannot tell");
			expect(result.output).toContain("git remote add upstream");
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: with CI=true no longer forcing a run, nothing restores the full
	// gate: neither a person who asks for it nor a GitHub Actions job on main,
	// where the branch diff is empty by definition.
	test.each([
		["OMP_FORCE_RUST_TASKS=1", { OMP_FORCE_RUST_TASKS: "1" }],
		["a GitHub Actions runner", { CI: "true", GITHUB_ACTIONS: "true" }],
	])(
		"%s runs the Rust gate on a checkout with no Rust change",
		async (_label, env) => {
			const fixture = await makeFixture();

			const result = await runCheckRs(fixture, fixture.work, env);

			expect(result.cargoRan).toBe(true);
		},
		CASE_TIMEOUT_MS,
	);
});
