import { describe, expect, it } from "bun:test";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DakeraMemoryType, DakeraRecallHit } from "@oh-my-pi/pi-coding-agent/dakera/client";
import { formatRecallHits, resolveDakeraModel } from "@oh-my-pi/pi-coding-agent/dakera/reflect";

const registryFor = (models: MockModel[]): ModelRegistry =>
	({ getAll: () => models, getAvailable: () => models }) as unknown as ModelRegistry;

const hit = (id: string, content: string, created_at?: number, memory_type?: DakeraMemoryType): DakeraRecallHit => ({
	memory: { id, content, created_at, memory_type },
});

describe("resolveDakeraModel", () => {
	// Found live: a config that names only `modelRoles.default` — the common case
	// — has no smol role, so a smol-only ladder left reflect erroring on a
	// machine with a perfectly usable model.
	it("takes the default model role when no smol role is configured", async () => {
		const answerer = createMockModel({ provider: "mock", id: "answerer" });
		const settings = Settings.isolated({ modelRoles: { default: "mock/answerer" } });

		expect((await resolveDakeraModel(settings, registryFor([answerer])))?.id).toBe("answerer");
	});

	it("prefers the smol role over the default one", async () => {
		const small = createMockModel({ provider: "mock", id: "small" });
		const answerer = createMockModel({ provider: "mock", id: "answerer" });
		const settings = Settings.isolated({ modelRoles: { default: "mock/answerer", smol: "mock/small" } });

		expect((await resolveDakeraModel(settings, registryFor([small, answerer])))?.id).toBe("small");
	});

	// An explicit selector outranks the role ladder, so reflect can be pinned to a
	// model that is not the one answering the session.
	it("honors dakera.reflectModel over any role", async () => {
		const pinned = createMockModel({ provider: "mock", id: "pinned" });
		const small = createMockModel({ provider: "mock", id: "small" });
		const settings = Settings.isolated({
			"dakera.reflectModel": "mock/pinned",
			modelRoles: { smol: "mock/small" },
		});

		expect((await resolveDakeraModel(settings, registryFor([pinned, small])))?.id).toBe("pinned");
	});

	// Without any resolvable model reflect must report the missing model rather
	// than answer from an arbitrary one.
	it("resolves no model when no role and no selector is configured", async () => {
		const settings = Settings.isolated({});

		expect(await resolveDakeraModel(settings, registryFor([createMockModel()]))).toBeUndefined();
	});
});

describe("formatRecallHits", () => {
	// The reflect prompt tells the model to prefer the most recently dated
	// contradiction, which needs the dates to run one way; recall hands the hits
	// over ranked, not chronological.
	it("renders ranked hits oldest-first so dated contradictions resolve", () => {
		const rendered = formatRecallHits([
			hit("newest", "deploy uses blue-green", 1_800_000_000, "semantic"),
			hit("oldest", "deploy uses rolling restarts", 1_700_000_000, "semantic"),
		]);

		expect(rendered).toBe(
			"(2023-11-14T22:13:20.000Z) [semantic] deploy uses rolling restarts\n\n(2027-01-15T08:00:00.000Z) [semantic] deploy uses blue-green",
		);
	});

	// An undated row cannot be newer than anything, so it leads the history.
	it("leads with undated hits rather than trailing with them", () => {
		const rendered = formatRecallHits([
			hit("dated", "deploy uses blue-green", 1_800_000_000),
			hit("undated", "the repo started as a spike"),
		]);

		expect(rendered).toBe("the repo started as a spike\n\n(2027-01-15T08:00:00.000Z) deploy uses blue-green");
	});
});
