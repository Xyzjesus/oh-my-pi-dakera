import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const SELECTOR_ADVICE = "use a narrower selector (path:A-B)";

describe("read repeat hint", () => {
	let cwd: string;
	let tool: ReadTool;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-repeat-hint-"));
		const evalTool = { docTopics: () => ({ browser: "line 1\nline 2\nline 3" }) } as unknown as Tool;
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "session"),
			settings: Settings.isolated(),
			getToolByName: name => (name === "eval" ? evalTool : undefined),
		};
		tool = new ReadTool(session);
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	async function thirdRead(target: string): Promise<string> {
		await tool.execute("first", { path: target });
		await tool.execute("second", { path: target });
		const result = await tool.execute("third", { path: target });
		return result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
	}

	// #17631: the hint advised `path:A-B` on xd:// topics, whose scheme passes the tail into the topic name.
	it("does not suggest a line selector for a selector-free xd:// topic", async () => {
		const text = await thirdRead("xd://eval/browser");
		expect(text).toContain("identical output 3 times");
		expect(text).not.toContain(SELECTOR_ADVICE);
		await expect(tool.execute("selector", { path: "xd://eval/browser:1-2" })).rejects.toThrow(
			"Unknown topic 'browser:1-2'",
		);
	});

	it("suggests a line selector for a filesystem path", async () => {
		const file = path.join(cwd, "notes.txt");
		await Bun.write(file, "a\nb\nc\n");
		expect(await thirdRead(file)).toContain(SELECTOR_ADVICE);
	});
});
