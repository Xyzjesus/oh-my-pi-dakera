#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";

const RUST_AFFECTING_FILE_NAMES = [
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
] as const satisfies readonly string[];
// The trunks a checkout is measured against: `main` on a fork's `upstream` remote
// and on `origin`. Remote-tracking refs only, because a local `main` can carry the
// very commits being checked. Each of these remotes that is configured must call
// `main` its default branch and have it fetched, and the task runs if the branch
// changed Rust against any of them: a missing, disagreeing or unconfirmed trunk is
// uncertainty, not evidence.
const TRUNK_REMOTES = ["upstream", "origin"] as const satisfies readonly string[];
// How long the gate waits for a remote to name its default branch. It asks only a
// remote with no recorded default (`git clone` records one; `git remote add` and
// `git fetch` do not), and asks them all at once, so a remote that never answers
// delays the run by this much at most, and the run then goes ahead.
const REMOTE_ANSWER_TIMEOUT_MS = 10_000;
// Vendored path-patched crates are workspace members for Bazel hermeticity
// (path-patch rendering is machine-local), but cargo dev tasks keep their
// historical scope: the forks are not held to workspace format/lint/test gates.
//
// pi-builtins is NOT excluded. It is first-party, and although it opts out of
// the workspace's pedantic/nursery lints in its own manifest (most of it is
// ported third-party code), it is held to default clippy and to zero rustc
// warnings like everything else.
const VENDORED_FORK_EXCLUDES = [
	"--exclude",
	"brush-core",
	"--exclude",
	"brush-parser",
	"--exclude",
	"cfg_aliases",
	"--exclude",
	"napi",
] as const satisfies readonly string[];
// grep-searcher's upstream ripgrep code predates the workspace clippy policy, but
// the fork's own `search_push` (src/searcher/push.rs, see its README.md) carries
// tests, so it is exempt from the lint gates only and still runs under test:rs.
const LINT_EXEMPT_FORK_EXCLUDES = [
	...VENDORED_FORK_EXCLUDES,
	"--exclude",
	"grep-searcher",
] as const satisfies readonly string[];
const TASK_COMMANDS = {
	"check:rs": [
		["cargo", "fmt", "--all", "--", "--check"],
		["cargo", "clippy", "--workspace", ...LINT_EXEMPT_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"],
	],
	"fix:rs": [
		["cargo", "fmt", "--all"],
		[
			"cargo",
			"clippy",
			"--workspace",
			...LINT_EXEMPT_FORK_EXCLUDES,
			"--fix",
			"--allow-dirty",
			"--no-deps",
			"--allow-staged",
			"--allow-no-vcs",
		],
	],
	"fmt:rs": [["cargo", "fmt", "--all"]],
	"lint:rs": [["cargo", "clippy", "--workspace", ...LINT_EXEMPT_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"]],
	"test:rs": [
		[
			"cargo",
			"nextest",
			"run",
			"--workspace",
			...VENDORED_FORK_EXCLUDES,
			"--status-level=fail",
			"--final-status-level=fail",
		],
		// nextest cannot run doctests (no stable libtest-json interface for
		// them), so they need their own libtest pass. It runs every runnable
		// doctest in the workspace's lib crates; today that is tree-sitter-go's
		// one example, since pi-natives is a `cdylib`, which rustdoc refuses to
		// collect doctests from, and pi-builtins' 16 examples are `ignore`d
		// vendored uutils docs. `--doc` overrides a crate's own
		// `doctest = false`, so a vendored crate whose examples do not compile
		// (napi-rs's) has to be in VENDORED_FORK_EXCLUDES.
		["cargo", "test", "--doc", "--workspace", ...VENDORED_FORK_EXCLUDES],
	],
} as const satisfies Record<string, readonly (readonly string[])[]>;

type RustTaskName = keyof typeof TASK_COMMANDS;

const repoRoot = path.join(import.meta.dir, "..");
const cargoBinary = await resolveCargoBinary();
const taskName = process.argv[2];

if (!isRustTaskName(taskName)) {
	console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
	process.exit(1);
}

if (taskName !== "fmt:rs") {
	const decision = await decideWhetherToRun();
	console.log(`${decision.run ? "Running" : "Skipping"} ${taskName}: ${decision.reason}`);
	if (!decision.run) process.exit(0);
}

for (const command of TASK_COMMANDS[taskName]) {
	const exitCode = await runCommand(command);
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}

function isRustTaskName(value: string | undefined): value is RustTaskName {
	return value != null && value in TASK_COMMANDS;
}

interface RunDecision {
	run: boolean;
	/** Printed as one line, so a skipped Rust gate is never silent. */
	reason: string;
}

interface TrunkChanges {
	trunk: string;
	base: string;
	/** Rust-affecting paths changed since `base`, committed or not. */
	rustPaths: string[];
}

type BranchChanges =
	| { trunks: TrunkChanges[] }
	/** `cure`, when known, is a command after which the next run can decide. */
	| { unknown: string; cure?: string };

type GitResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Runs the task when this checkout changed anything Rust builds from, and skips
 * it only on a positive answer that it did not. `CI` is not read: most tools take
 * it to mean "non-interactive", which is why omp exports `CI=true` into every
 * agent command, and reading it as "check everything" made each agent's
 * `bun check` lint the whole workspace. No CI job here runs this script (Rust CI
 * is bazel); GitHub Actions and `OMP_FORCE_RUST_TASKS=1` still force a full run.
 */
async function decideWhetherToRun(): Promise<RunDecision> {
	if (isEnabled(Bun.env.OMP_FORCE_RUST_TASKS)) return { run: true, reason: "OMP_FORCE_RUST_TASKS is set." };
	// A CI job on `main` has an empty branch diff by definition and must still check everything.
	if (Bun.env.GITHUB_ACTIONS === "true") return { run: true, reason: "running in GitHub Actions." };

	const changes = await collectBranchChanges();
	if ("unknown" in changes) {
		const cure = changes.cure ? ` To let it skip when no Rust changed: ${changes.cure}` : "";
		return { run: true, reason: `cannot tell what this checkout changed (${changes.unknown}).${cure}` };
	}

	const changed = changes.trunks.find(trunk => trunk.rustPaths.length > 0);
	if (changed === undefined) {
		const since = changes.trunks.map(trunk => `${trunk.base.slice(0, 12)}, the merge base with ${trunk.trunk}`);
		return {
			run: false,
			reason: `no Rust-affecting change since ${since.join(", and since ")}, committed or uncommitted. Set OMP_FORCE_RUST_TASKS=1 to run it anyway.`,
		};
	}
	const more = changed.rustPaths.length > 1 ? ` and ${changed.rustPaths.length - 1} more` : "";
	return {
		run: true,
		reason: `${displayPath(changed.rustPaths[0])}${more} changed since ${changed.base.slice(0, 12)}, the merge base with ${changed.trunk}.`,
	};
}

/**
 * A path as shown on the one decision line. Git allows control characters in a
 * path, and a raw newline or escape sequence would split or garble that line.
 */
function displayPath(changedPath: string): string {
	let shown = "";
	let escaped = false;
	for (const char of changedPath) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			shown += `\\x${code.toString(16).padStart(2, "0")}`;
			escaped = true;
		} else {
			shown += char;
		}
	}
	return escaped ? `"${shown}"` : shown;
}

function isEnabled(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * What this checkout changed relative to each trunk: everything committed since
 * the merge base (never a two-dot diff against the trunk's tip, which would count
 * the trunk's own newer commits as the branch's), plus staged, unstaged and
 * untracked files. Whatever git cannot answer comes back as `unknown`.
 */
async function collectBranchChanges(): Promise<BranchChanges> {
	const shallow = await git("rev-parse", "--is-shallow-repository");
	if (!shallow.ok) return { unknown: shallow.error };
	// A shallow clone can hide the true merge base and still hand back an older one,
	// against which a branch that reverts main's newer Rust commit diffs clean.
	if (shallow.text.trim() === "true") return { unknown: "shallow clone", cure: "git fetch --unshallow" };

	const remotes = await git("remote");
	if (!remotes.ok) return { unknown: remotes.error };
	const configured = new Set(remotes.text.split("\n"));
	const trunkRemotes = TRUNK_REMOTES.filter(remote => configured.has(remote));
	if (trunkRemotes.length === 0) {
		return {
			unknown: `no ${TRUNK_REMOTES.join(" or ")} remote to diff against`,
			cure: "git remote add upstream https://github.com/can1357/oh-my-pi && git fetch upstream main:refs/remotes/upstream/main",
		};
	}

	// `--untracked-files=all` lists a new crate's files instead of one `crates/new/` entry.
	const status = await git("status", "--porcelain", "-z", "--untracked-files=all");
	if (!status.ok) return { unknown: status.error };
	const uncommitted = getChangedPathsFromPorcelain(status.text);

	// Asked together, so remotes that never answer cost one timeout, not one each.
	const defaultBranches = await Promise.all(trunkRemotes.map(getDefaultBranch));
	const trunks: TrunkChanges[] = [];
	for (const [index, remote] of trunkRemotes.entries()) {
		const defaultBranch = defaultBranches[index];
		// A `main` that is not the remote's trunk is only another branch, and a branch
		// it already holds diffs clean against it. An unconfirmed `main` is no better.
		if ("unknown" in defaultBranch) {
			return {
				unknown: `could not learn ${remote}'s default branch: ${defaultBranch.unknown}; the Rust half keeps running`,
			};
		}
		if (defaultBranch.branch !== "main") {
			return {
				unknown: `${remote}'s default branch is ${defaultBranch.branch}, not main, and this gate compares only against main, so it runs on every check here`,
			};
		}
		const trunk = `${remote}/main`;
		const tip = await git("rev-parse", "--verify", "--quiet", `refs/remotes/${trunk}^{commit}`);
		if (!tip.ok) {
			// The fetch names its destination because a plain `git fetch <remote> main`
			// only writes FETCH_HEAD when the remote's refspec leaves `main` out, as a
			// single-branch clone's does.
			return {
				unknown: `the ${remote} remote has no fetched main`,
				cure: `git fetch ${remote} main:refs/remotes/${remote}/main`,
			};
		}
		const mergeBase = await git("merge-base", "HEAD", tip.text.trim());
		if (!mergeBase.ok) return { unknown: `no merge base between HEAD and ${trunk}` };
		const base = mergeBase.text.trim();
		// `--no-renames` reports both sides of a rename, so moving a file out of a crate still counts.
		const committed = await git("diff", "--no-renames", "--name-only", "-z", base, "HEAD");
		if (!committed.ok) return { unknown: committed.error };
		const paths = [...committed.text.split("\0").filter(Boolean), ...uncommitted];
		trunks.push({ trunk, base, rustPaths: paths.filter(isRustAffectingPath) });
	}
	return { trunks };
}

/**
 * The branch `remote` calls its trunk: the `refs/remotes/<remote>/HEAD` that
 * `git clone` records, else the remote's own answer. A remote added with
 * `git remote add` and fetched records none, and guessing `main` for it told a
 * `master` repository to fetch a `main` it does not have.
 */
async function getDefaultBranch(remote: string): Promise<{ branch: string } | { unknown: string }> {
	const prefix = `refs/remotes/${remote}/`;
	const recorded = await git("symbolic-ref", "--quiet", `${prefix}HEAD`);
	if (recorded.ok) return { branch: recorded.text.trim().slice(prefix.length) };
	const advertised = await gitAskingRemote("ls-remote", "--symref", remote, "HEAD");
	if (!advertised.ok) return { unknown: advertised.error };
	const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(advertised.text)?.[1];
	return branch === undefined ? { unknown: "its answer names none" } : { branch };
}

/**
 * `git` for a command that talks to a remote: it never prompts, and it gives up
 * after REMOTE_ANSWER_TIMEOUT_MS. A timeout stops git without waiting for its
 * output streams, so a remote that never answers cannot delay the Rust gate.
 */
async function gitAskingRemote(...args: string[]): Promise<GitResult> {
	const child = Bun.spawn(["git", ...args], {
		cwd: repoRoot,
		env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const finished = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const { promise: timedOut, resolve } = Promise.withResolvers<"timed out">();
	const timer = setTimeout(() => resolve("timed out"), REMOTE_ANSWER_TIMEOUT_MS);
	const outcome = await Promise.race([finished, timedOut]);
	clearTimeout(timer);
	if (outcome === "timed out") {
		child.kill("SIGKILL");
		return { ok: false, error: `git ${args[0]} got no answer within ${REMOTE_ANSWER_TIMEOUT_MS / 1000} s` };
	}
	const [exitCode, stdout, stderr] = outcome;
	if (exitCode === 0) return { ok: true, text: stdout };
	const firstLine = stderr.trim().split("\n")[0];
	return { ok: false, error: `git ${args[0]}: ${firstLine || `exit ${exitCode}`}` };
}

async function git(...args: string[]): Promise<GitResult> {
	const result = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) return { ok: true, text: result.text() };
	const firstLine = result.stderr.toString().trim().split("\n")[0];
	return { ok: false, error: `git ${args[0]}: ${firstLine || `exit ${result.exitCode}`}` };
}

function getChangedPathsFromPorcelain(porcelain: string): string[] {
	const entries = porcelain.split("\0").filter(Boolean);
	const changedPaths: string[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;

		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (changedPath !== "") {
			changedPaths.push(changedPath);
		}

		if (status.includes("R") || status.includes("C")) {
			const renamedPath = entries[index + 1];
			if (renamedPath) {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}

	return changedPaths;
}

function isRustAffectingPath(changedPath: string): boolean {
	const normalized = changedPath.replace(/\\/g, "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.endsWith(".rs") ||
		// Everything under crates/ feeds a crate: fixtures, include_bytes! data, grammars build.rs compiles.
		normalized.startsWith("crates/") ||
		normalized.startsWith(".cargo/") ||
		// `test:rs` is `cargo nextest run`, which reads its filters and scheduling from here.
		normalized === ".config/nextest.toml" ||
		isOneOf(fileName, RUST_AFFECTING_FILE_NAMES)
	);
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(entry => entry === value);
}

async function resolveCargoBinary(): Promise<string> {
	// On macOS runners, Homebrew's `rustup-init` binary is on PATH before the
	// rustup proxies in `$CARGO_HOME/bin`, and invoking it as `cargo` falls
	// through to its installer mode ("unexpected argument 'nextest' found").
	// Ask rustup directly for the cargo binary in the active toolchain.
	const result = await $`rustup which cargo`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) {
		const resolved = result.stdout.toString().trim();
		if (resolved !== "") return resolved;
	}
	return "cargo";
}

async function runCommand(command: readonly string[]): Promise<number> {
	const [head, ...rest] = command;
	const isCargo = head === "cargo";
	const argv = isCargo ? [cargoBinary, ...rest] : [head, ...rest];
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (isCargo) {
		// Cargo subprocesses (notably `rustc -vV` from `cargo metadata`) resolve
		// via PATH; ensure the active toolchain bin dir wins over Homebrew's
		// rustup-init shadow on macOS runners.
		const toolchainBin = path.dirname(cargoBinary);
		const pathSep = process.platform === "win32" ? ";" : ":";
		const currentPath = env.PATH ?? env.Path ?? "";
		env.PATH = currentPath === "" ? toolchainBin : `${toolchainBin}${pathSep}${currentPath}`;
	}
	const proc = Bun.spawn(argv, {
		cwd: repoRoot,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
