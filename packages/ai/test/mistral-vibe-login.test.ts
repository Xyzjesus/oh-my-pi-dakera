import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { removeWithRetries } from "../../utils/src/temp";

const SIGN_IN_URL = "https://console.mistral.ai/api/vibe/sign-in";
const POLL_URL = "https://console.mistral.ai/api/vibe/sign-in/proc-1";
const EXCHANGE_URL = "https://console.mistral.ai/api/vibe/sign-in/proc-1/exchange";
const BROWSER_URL = "https://console.mistral.ai/codestral/cli/authenticate?process_id=proc-1";

const loginMistral = getProviderDefinition("mistral")?.login;
if (!loginMistral) throw new Error("Mistral login is not registered");

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function startResponse(): Response {
	return json({
		process_id: "proc-1",
		sign_in_url: BROWSER_URL,
		poll_url: POLL_URL,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
	});
}

type Call = { url: string; init?: RequestInit };

/** Scripted console: the poll endpoint answers (or throws) each entry of `polls` in order. */
function mockConsole(polls: (Response | Error)[], exchange: () => Response = () => json({ api_key: "vibe-key" })) {
	const calls: Call[] = [];
	const fetchImpl: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		if (url === SIGN_IN_URL) return startResponse();
		if (url === POLL_URL) {
			const next = polls.shift();
			if (!next) throw new Error("poll called more times than scripted");
			if (next instanceof Error) throw next;
			return next;
		}
		if (url === EXCHANGE_URL) return exchange();
		throw new Error(`Unexpected URL: ${url}`);
	});
	return { calls, fetchImpl };
}

/** Skip poll waits and record the delays the shared poll loop asked for (signal-less logins sleep via `Bun.sleep`). */
function instantPollWaits(): number[] {
	const delays: number[] = [];
	vi.spyOn(Bun, "sleep").mockImplementation((async (ms: number) => {
		delays.push(ms);
	}) as typeof Bun.sleep);
	return delays;
}

describe("mistral vibe browser sign-in", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exchanges the approved sign-in with the PKCE verifier and returns the minted key", async () => {
		const { calls, fetchImpl } = mockConsole([
			json({ status: "pending" }),
			json({ status: "completed", exchange_token: "xt-1" }),
		]);
		const onAuth = vi.fn();
		const waits = instantPollWaits();

		const result = await loginMistral({ onAuth, fetch: fetchImpl });

		expect(result).toBe("vibe-key");
		expect(onAuth).toHaveBeenCalledTimes(1);
		expect(onAuth.mock.calls[0]?.[0]).toMatchObject({ url: BROWSER_URL });
		expect(waits).toEqual([3000]);

		const start = JSON.parse(String(calls[0]?.init?.body));
		expect(start.code_challenge_method).toBe("S256");
		const exchange = calls.find(call => call.url === EXCHANGE_URL);
		const exchangeBody = JSON.parse(String(exchange?.init?.body));
		expect(exchangeBody.exchange_token).toBe("xt-1");
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchangeBody.code_verifier)),
		);
		expect(Buffer.from(digest).toString("base64url")).toBe(start.code_challenge);
	});

	it("rejects an expired process (HTTP 410) without exchanging", async () => {
		const { calls, fetchImpl } = mockConsole([new Response(null, { status: 410 })]);

		await expect(loginMistral({ fetch: fetchImpl })).rejects.toThrow("Mistral sign-in expired");
		expect(calls.some(call => call.url === EXCHANGE_URL)).toBe(false);
	});

	it("rejects a denied sign-in without exchanging", async () => {
		const { calls, fetchImpl } = mockConsole([json({ status: "denied" })]);

		await expect(loginMistral({ fetch: fetchImpl })).rejects.toThrow("Mistral sign-in was denied");
		expect(calls.some(call => call.url === EXCHANGE_URL)).toBe(false);
	});

	it("rides out transient poll failures and still exchanges the approval", async () => {
		const { calls, fetchImpl } = mockConsole([
			new TypeError("fetch failed"),
			json({ detail: "upstream" }, 502),
			json({ status: "completed", exchange_token: "xt-1" }),
		]);
		instantPollWaits();

		await expect(loginMistral({ fetch: fetchImpl })).resolves.toBe("vibe-key");
		expect(calls.filter(call => call.url === POLL_URL)).toHaveLength(3);
	});

	it("keeps polling through rate limits, waiting as long as Retry-After says", async () => {
		const throttled = () => new Response(null, { status: 429, headers: { "Retry-After": "7" } });
		const { fetchImpl } = mockConsole([
			throttled(),
			throttled(),
			throttled(),
			throttled(),
			json({ status: "completed", exchange_token: "xt-1" }),
		]);
		const waits = instantPollWaits();

		await expect(loginMistral({ fetch: fetchImpl })).resolves.toBe("vibe-key");
		expect(waits).toEqual([7000, 7000, 7000, 7000]);
	});

	it("never polls faster than the base cadence after a short Retry-After, and caps a long one", async () => {
		const { fetchImpl } = mockConsole([
			new Response(null, { status: 429, headers: { "retry-after-ms": "50" } }),
			json({ status: "pending" }),
			new Response(null, { status: 429, headers: { "Retry-After": "600" } }),
			json({ status: "pending" }),
			json({ status: "completed", exchange_token: "xt-1" }),
		]);
		const waits = instantPollWaits();

		await expect(loginMistral({ fetch: fetchImpl })).resolves.toBe("vibe-key");
		expect(waits).toEqual([3000, 3000, 30_000, 30_000]);
	});

	it("gives up after three consecutive poll failures without exchanging", async () => {
		const { calls, fetchImpl } = mockConsole([
			json({}, 503),
			new TypeError("fetch failed"),
			json({}, 503),
			json({ status: "completed", exchange_token: "xt-1" }),
		]);
		instantPollWaits();

		await expect(loginMistral({ fetch: fetchImpl })).rejects.toThrow("HTTP 503");
		expect(calls.some(call => call.url === EXCHANGE_URL)).toBe(false);
	});

	it("explains a workspace that may not mint Vibe keys", async () => {
		const { fetchImpl } = mockConsole([json({ status: "completed", exchange_token: "xt-1" })], () =>
			json({ error_code: 9004, detail: "forbidden" }, 403),
		);

		await expect(loginMistral({ fetch: fetchImpl })).rejects.toThrow("workspace can't be used for Mistral Vibe");
	});

	it("rejects a sign-in URL outside the Mistral console", async () => {
		const fetchImpl: FetchImpl = vi.fn(async () =>
			json({
				process_id: "proc-1",
				sign_in_url: "https://evil.example/authenticate",
				poll_url: POLL_URL,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		const onAuth = vi.fn();

		await expect(loginMistral({ onAuth, fetch: fetchImpl })).rejects.toThrow("unexpected URL");
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("rejects a poll URL that only shares a string prefix with the console API path", async () => {
		const fetchImpl: FetchImpl = vi.fn(async () =>
			json({
				process_id: "proc-1",
				sign_in_url: BROWSER_URL,
				poll_url: "https://console.mistral.ai/api-evil/vibe/sign-in/proc-1",
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		const onAuth = vi.fn();

		await expect(loginMistral({ onAuth, fetch: fetchImpl })).rejects.toThrow("unexpected URL");
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("does not contact the console when the login is already cancelled", async () => {
		const { calls, fetchImpl } = mockConsole([]);
		const controller = new AbortController();
		controller.abort();

		await expect(loginMistral({ fetch: fetchImpl, signal: controller.signal })).rejects.toBeInstanceOf(
			LoginCancelledError,
		);
		expect(calls).toHaveLength(0);
	});

	it("cancels the wait between polls through the login signal", async () => {
		const { calls, fetchImpl } = mockConsole([json({ status: "pending" })]);
		const controller = new AbortController();
		const realSetTimeout = globalThis.setTimeout;
		// Abort once the poll wait has started (after its abort listener is attached);
		// the real 3 s timer must not hold the rejection.
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
			queueMicrotask(() => controller.abort());
			return realSetTimeout(callback, ms);
		}) as typeof setTimeout);
		const started = Date.now();

		await expect(loginMistral({ fetch: fetchImpl, signal: controller.signal })).rejects.toBeInstanceOf(
			LoginCancelledError,
		);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(calls.map(call => call.url)).toEqual([SIGN_IN_URL, POLL_URL]);
		expect(calls[1]?.init?.signal?.aborted).toBe(true);
	});
});

describe("mistral vibe sign-in persistence", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-mistral-vibe-login-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		store?.close();
		store = null;
		await removeWithRetries(tempDir);
	});

	it("stores the minted key as a plain API-key credential, not an OAuth row", async () => {
		if (!store) throw new Error("test setup failed");
		const authStorage = new AuthStorage(store);
		const { fetchImpl } = mockConsole([json({ status: "completed", exchange_token: "xt-1" })]);

		const outcome = await authStorage.oauth.login("mistral", {
			onAuth: () => {},
			onPrompt: async () => {
				throw new Error("browser sign-in must not prompt");
			},
			fetch: fetchImpl,
		});

		expect(outcome).toEqual({ type: "api_key" });
		const rows = store.listAuthCredentials("mistral");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential).toMatchObject({ type: "api_key", key: "vibe-key" });
	});
});
