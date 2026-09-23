import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isDakeraConfigured, loadDakeraConfig } from "@oh-my-pi/pi-coding-agent/dakera/config";

// `loadDakeraConfig` takes the env bag as an argument, so precedence is proven
// without touching `process.env`.
const configFor = (settingsValue: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) =>
	loadDakeraConfig(Settings.isolated({ "dakera.apiUrl": "http://server.local", ...settingsValue }), env);

describe("loadDakeraConfig", () => {
	it("lets DAKERA_* win over persisted settings", () => {
		const config = configFor(
			{ "dakera.apiUrl": "http://from-settings", "dakera.recallTopK": 3, "dakera.autoRetain": true },
			{ DAKERA_API_URL: "http://from-env", DAKERA_RECALL_TOP_K: "12", DAKERA_AUTO_RETAIN: "false" },
		);
		expect(config.apiUrl).toBe("http://from-env");
		expect(config.recallTopK).toBe(12);
		expect(config.autoRetain).toBe(false);
	});

	// A deployment exports one variable and the server, the MCP surface and omp
	// all agree; the token-shaped name still wins when both are present.
	it("accepts DAKERA_API_KEY when DAKERA_API_TOKEN is unset", () => {
		expect(configFor({}, { DAKERA_API_KEY: "dk_key" }).apiToken).toBe("dk_key");
		expect(configFor({}, { DAKERA_API_KEY: "dk_key", DAKERA_API_TOKEN: "dk_token" }).apiToken).toBe("dk_token");
	});

	// CI shells routinely export DAKERA_API_URL="" — that must fall back to the
	// persisted value rather than clear the endpoint.
	it("treats a blank env value as unset", () => {
		expect(configFor({}, { DAKERA_API_URL: "   " }).apiUrl).toBe("http://server.local");
		expect(configFor({}, { DAKERA_RECALL_TOP_K: "abc" }).recallTopK).toBe(8);
	});

	// An explicit empty string in settings is the documented way to point the
	// backend at nothing; the localhost default must not resurrect it.
	it("marks an explicitly blank apiUrl as unconfigured", () => {
		expect(isDakeraConfigured(configFor({ "dakera.apiUrl": "" }))).toBe(false);
		expect(isDakeraConfigured(configFor())).toBe(true);
	});

	it("falls back to the documented mode when a scoping or retainMode value is invalid", () => {
		const config = configFor({ "dakera.scoping": "per-project-tagged", "dakera.retainMode": "half-session" });
		expect(config.scoping).toBe("per-project");
		expect(config.retainMode).toBe("full-session");

		const overridden = configFor(
			{ "dakera.scoping": "per-project-tagged", "dakera.retainMode": "half-session" },
			{ DAKERA_SCOPING: "global", DAKERA_RETAIN_MODE: "last-turn" },
		);
		expect(overridden.scoping).toBe("global");
		expect(overridden.retainMode).toBe("last-turn");
	});

	it("keeps an explicit false for booleans instead of treating it as unset", () => {
		const config = configFor({ "dakera.autoRecall": false, "dakera.recallRerank": false });
		expect(config.autoRecall).toBe(false);
		expect(config.recallRerank).toBe(false);

		const envOn = configFor({ "dakera.autoRecall": false }, { DAKERA_AUTO_RECALL: "true" });
		expect(envOn.autoRecall).toBe(true);
	});
});
