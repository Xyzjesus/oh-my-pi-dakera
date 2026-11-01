import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { getEvalState } from "@oh-my-pi/pi-coding-agent/eval/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { TempDir } from "@oh-my-pi/pi-utils";

type Language = "py" | "js";

const NOTICE: Record<Language, string> = {
	py: "Kernel restarted: the previous Python kernel is dead; state is unavailable. Re-run needed setup",
	js: "Kernel restarted: the previous JS worker is dead; state is unavailable. Re-run needed setup",
};

function makeSession(evalSessionId: string, preludes?: () => readonly EvalPreludeDefinition[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => evalSessionId,
		...(preludes ? { getEvalPreludes: preludes } : {}),
	};
}

interface Cell {
	text: string;
	isError: boolean;
}

async function run(
	tool: EvalTool,
	language: Language,
	code: string,
	options?: { reset?: boolean; signal?: AbortSignal; onText?: (text: string) => void },
): Promise<Cell> {
	const result = await tool.execute(
		`call-${crypto.randomUUID()}`,
		{ language, code, timeout: 60, ...(options?.reset ? { reset: true } : {}) },
		options?.signal,
		options?.onText
			? update => {
					const text = update.content?.find(block => block.type === "text")?.text;
					if (text) options.onText?.(text);
				}
			: undefined,
	);
	const text = result.content.find(block => block.type === "text")?.text ?? "";
	return { text, isError: result.details?.isError === true };
}

const PID_CELL: Record<Language, string> = {
	py: "import os\nprint('pid', os.getpid())",
	js: "print('pid', process.pid)",
};

function pidOf(cell: Cell): number {
	const match = /pid (\d+)/.exec(cell.text);
	if (!match) throw new Error(`no pid in cell output: ${cell.text}`);
	return Number(match[1]);
}

/**
 * SIGKILL the runtime process, then wait until the host has recorded it dead.
 * The death is a real OS event in a child the host owns and nothing exposes an
 * event for it, so the test polls the host's eval-state registry: fake timers
 * cannot advance a process exit.
 */
async function killRuntime(session: ToolSession, language: Language, pid: number): Promise<void> {
	// A JS cell on the Bun Worker fallback reports the test runner's own pid.
	if (pid === process.pid) throw new Error("runtime runs inside the test process; refusing to SIGKILL it");
	process.kill(pid, "SIGKILL");
	const runtime = language === "py" ? "python" : "js";
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const state = getEvalState(session)?.runtimes.find(entry => entry.language === runtime);
		if (state && !state.alive) return;
		await Bun.sleep(20);
	}
	throw new Error(`host never saw ${runtime} runtime ${pid} die`);
}

function expectNotice(cell: Cell, language: Language): void {
	expect(cell.text.trimStart().startsWith(NOTICE[language])).toBe(true);
	expect(cell.text).toContain("variables, imports and definitions from earlier cells are gone");
}

function expectNoNotice(cell: Cell): void {
	expect(cell.text).not.toContain("Kernel restarted:");
}

const SET_VALUE: Record<Language, string> = {
	py: "restart_probe = 41",
	js: "var restartProbe = 41;",
};

const READ_VALUE: Record<Language, string> = {
	py: "print(restart_probe + 1)",
	js: "print(restartProbe + 1)",
};

/**
 * Runs one cell through the language executor with a caller-supplied output
 * consumer, which is how a consumer that fails is injected. A rejection becomes
 * an error cell carrying the error text.
 */
async function runWithConsumer(
	session: ToolSession,
	language: Language,
	code: string,
	onChunk?: (chunk: string) => void,
): Promise<Cell> {
	const sessionId = session.getEvalSessionId?.() ?? "missing";
	const execution =
		language === "py"
			? executePython(code, { cwd: session.cwd, sessionId, toolSession: session, onChunk, timeoutMs: 60_000 })
			: executeJs(code, { cwd: session.cwd, sessionId, session, onChunk, timeoutMs: 60_000 });
	return await execution.then(
		result => ({ text: result.output, isError: result.exitCode !== 0 }),
		(error: unknown) => ({ text: String(error), isError: true }),
	);
}

/** Defines state, then ends on a carriage return so the executor's final flush emits a lone newline. */
const DEFINE_THEN_FLUSH: Record<Language, string> = {
	py: "import math\nsurvives = 42\ndef saved_fn(): return 43\nprint('defined')\nprint('\\r', end='')",
	js: "var survives = 42; var savedFn = () => 43; print('defined'); void process.stdout.write('\\r');",
};

const USE_DEFINED: Record<Language, string> = {
	py: "print('survived', survives, math.sqrt(4), saved_fn())",
	js: "print('survived', survives, Math.sqrt(4), savedFn())",
};

describe("eval kernel restart notice", () => {
	afterEach(async () => {
		await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
	});

	for (const language of ["py", "js"] as const) {
		it(`${language}: the first cell after the runtime is killed between cells says its state is gone`, async () => {
			const session = makeSession(`restart-notice-kill-${language}-${crypto.randomUUID()}`);
			const tool = new EvalTool(session);

			const first = await run(tool, language, `${SET_VALUE[language]}\n${PID_CELL[language]}`);
			expectNoNotice(first);
			const survived = await run(tool, language, READ_VALUE[language]);
			expectNoNotice(survived);
			expect(survived.text).toContain("42");

			await killRuntime(session, language, pidOf(first));

			const afterKill = await run(tool, language, READ_VALUE[language]);
			expectNotice(afterKill, language);
			expect(afterKill.isError).toBe(true);
			expect(afterKill.text).toMatch(language === "py" ? /NameError/ : /restartProbe/);

			const next = await run(tool, language, PID_CELL[language]);
			expectNoNotice(next);
		}, 120_000);

		it(`${language}: a reset or a dispose after the runtime died gives no notice`, async () => {
			const session = makeSession(`restart-notice-reset-${language}-${crypto.randomUUID()}`);
			const tool = new EvalTool(session);

			const first = await run(tool, language, PID_CELL[language]);
			await killRuntime(session, language, pidOf(first));
			const reset = await run(tool, language, PID_CELL[language], { reset: true });
			expectNoNotice(reset);

			await killRuntime(session, language, pidOf(reset));
			await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
			const afterDispose = await run(tool, language, PID_CELL[language]);
			expectNoNotice(afterDispose);
		}, 120_000);
	}

	it("js: the first cell after a cancelled cell says the worker state is gone", async () => {
		const session = makeSession(`restart-notice-cancel-js-${crypto.randomUUID()}`);
		const tool = new EvalTool(session);

		await run(tool, "js", SET_VALUE.js);
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const cancelled = run(tool, "js", "print('waiting'); await new Promise(() => {});", {
			signal: controller.signal,
			onText: text => {
				if (text.includes("waiting")) started.resolve();
			},
		});
		await started.promise;
		controller.abort(new DOMException("user cancelled", "AbortError"));
		await cancelled.catch(() => undefined);

		const next = await run(tool, "js", READ_VALUE.js);
		expectNotice(next, "js");
		const after = await run(tool, "js", "print('after')");
		expectNoNotice(after);
	}, 120_000);

	it("py: a cell that fails in prelude setup on the replacement neither hides nor falsifies the notice", async () => {
		using markers = TempDir.createSync("@restart-notice-prelude-");
		const entered = path.join(markers.path(), "entered");
		const release = path.join(markers.path(), "release");
		let preludes: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(`restart-notice-prelude-${crypto.randomUUID()}`, () => preludes);
		const tool = new EvalTool(session);

		const first = await run(tool, "py", PID_CELL.py);
		await killRuntime(session, "py", pidOf(first));

		// Cell A starts on the replacement kernel; its prelude blocks, then raises.
		preludes = [
			{
				name: "blocking-failure",
				documentation: "waits for the release file, then fails",
				exports: [],
				javascript: "",
				python: [
					"import asyncio, pathlib",
					`pathlib.Path(${JSON.stringify(entered)}).write_text("entered")`,
					`while not pathlib.Path(${JSON.stringify(release)}).exists():`,
					"    await asyncio.sleep(0.01)",
					'raise RuntimeError("prelude failed")',
				].join("\n"),
				invoke: async () => ({ content: [] }),
			},
		];
		const failing = run(tool, "py", "print('not reached')").catch((error: unknown) => ({
			text: String(error),
			isError: true,
		}));
		// The prelude runs in the kernel process; its marker file is the only signal it has started.
		const deadline = Date.now() + 30_000;
		while (!(await Bun.file(entered).exists())) {
			if (Date.now() > deadline) throw new Error("prelude never started");
			await Bun.sleep(10);
		}

		// Cell B runs on the same replacement while A waits: it is the first to run there.
		preludes = [];
		const sibling = await run(
			tool,
			"py",
			"import math, os\nsurvives = 42\ndef saved_fn(): return 43\nprint('pid', os.getpid())",
		);
		expectNotice(sibling, "py");

		await Bun.write(release, "release");
		const failed = await failing;
		expect(failed.text).toContain("prelude failed");
		expectNoNotice(failed);

		// Cell C still has everything B defined, on B's process, and must not be told it is gone.
		const after = await run(
			tool,
			"py",
			"import os\nprint('survived', survives, math.sqrt(4), saved_fn(), os.getpid())",
		);
		expect(after.text).toContain(`survived 42 2.0 43 ${pidOf(sibling)}`);
		expectNoNotice(after);
	}, 120_000);
});

describe("eval kernel restart notice when output delivery fails", () => {
	afterEach(async () => {
		await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
	});

	for (const language of ["py", "js"] as const) {
		it(`${language}: a cell whose final output flush fails keeps the notice, and the next cell gets none`, async () => {
			const session = makeSession(`restart-notice-flush-${language}-${crypto.randomUUID()}`);
			const first = await runWithConsumer(session, language, PID_CELL[language]);
			await killRuntime(session, language, pidOf(first));

			let failures = 0;
			const failed = await runWithConsumer(session, language, DEFINE_THEN_FLUSH[language], chunk => {
				if (chunk !== "\n") return;
				failures += 1;
				throw new Error("output delivery failed during final flush");
			});
			const after = await runWithConsumer(session, language, USE_DEFINED[language]);

			// The failed cell ran on the replacement: its definitions survive, and nothing re-announces the loss.
			expect(failures).toBe(1);
			expect(after.text).toMatch(/survived 42 2(?:\.0)? 43/);
			expectNoNotice(after);
			// The loss was announced once, by the failed cell, which returns the notice with its error.
			expectNotice(failed, language);
			expect(failed.isError).toBe(true);
			expect(failed.text).toContain("output delivery failed during final flush");
		}, 120_000);

		it(`${language}: when overlapping cells' consumers refuse the notice, the cell that claimed it still returns it`, async () => {
			const session = makeSession(`restart-notice-refused-${language}-${crypto.randomUUID()}`);
			const first = await runWithConsumer(session, language, PID_CELL[language]);
			await killRuntime(session, language, pidOf(first));

			// Every cell's consumer refuses the notice, so whichever cell claims it is refused.
			let refusals = 0;
			const refuseNotice = (chunk: string): void => {
				if (!chunk.includes("Kernel restarted:")) return;
				refusals += 1;
				throw new Error("notice delivery refused");
			};
			const cells = await Promise.all(
				["one", "two", "three"].map(name => runWithConsumer(session, language, `print('${name}')`, refuseNotice)),
			);
			const after = await runWithConsumer(session, language, PID_CELL[language]);

			const announced = cells.filter(cell => cell.text.includes("Kernel restarted:"));
			expect(announced).toHaveLength(1);
			expectNotice(announced[0]!, language);
			expect(announced[0]!.isError).toBe(true);
			expect(announced[0]!.text).toContain("notice delivery refused");
			expect(refusals).toBe(1);
			expectNoNotice(after);
		}, 120_000);

		it(`${language}: a cell whose consumer throws on every chunk still returns the notice`, async () => {
			const session = makeSession(`restart-notice-broken-${language}-${crypto.randomUUID()}`);
			const first = await runWithConsumer(session, language, PID_CELL[language]);
			await killRuntime(session, language, pidOf(first));

			const failed = await runWithConsumer(session, language, "print('unreached')", () => {
				throw new Error("consumer is broken");
			});
			const after = await runWithConsumer(session, language, PID_CELL[language]);

			expectNotice(failed, language);
			expect(failed.isError).toBe(true);
			expect(failed.text).toContain("consumer is broken");
			expectNoNotice(after);
		}, 120_000);
	}
});
