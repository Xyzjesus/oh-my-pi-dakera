/**
 * Mistral Vibe browser sign-in: the same flow the Vibe Code CLI uses
 * (mistralai/mistral-vibe, vibe/core/config/_defaults.py). Mistral's console
 * provisions and stores a regular API key; the browser session does the
 * authorizing, so no password ever transits this code.
 *
 * Flow, verified 2026-09-30 against a Pro plan:
 *  1. POST https://console.mistral.ai/api/vibe/sign-in
 *     { code_challenge, code_challenge_method: "S256" }  (no auth header)
 *     -> { process_id, sign_in_url, poll_url, expires_at }
 *  2. The user approves in the browser at sign_in_url.
 *  3. Poll GET poll_url -> { status: "pending" | "completed" | ... ,
 *     exchange_token? } (HTTP 410 once the process expires).
 *  4. POST .../vibe/sign-in/{process_id}/exchange
 *     { exchange_token, code_verifier } -> { api_key }
 *
 * The minted key authenticates https://api.mistral.ai/v1 over the plain
 * `openai-completions` transport; its usage is billed against the Vibe Code
 * quota of the signed-in plan, not against pay-as-you-go API credits
 * (observed 2026-09-30: sustained traffic moved the plan's Vibe Code
 * counter, not the API credits counter).
 */
import { isRecord, sleepLong } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { getRetryAfterMsFromHeaders } from "../../utils/retry-after";
import { generatePKCE } from "./pkce";
import type { OAuthController } from "./types";

const AUTH_BASE_URL = "https://console.mistral.ai";
const AUTH_API_BASE_URL = `${AUTH_BASE_URL}/api`;
const SIGN_IN_PATH = "/vibe/sign-in";
const POLL_INTERVAL_MS = 3000;
/** Consecutive transient poll failures tolerated before giving up (matches the Vibe CLI). */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
/** Console `error_code` when the selected workspace may not mint API keys. */
const API_KEYS_CREATE_UNAUTHORIZED_ERROR_CODE = 9004;
/** Ceiling for the rate-limit backoff when the console sends no `Retry-After`. */
const MAX_RATE_LIMIT_BACKOFF_MS = 30_000;

type SignInProcess = {
	processId: string;
	signInUrl: string;
	pollUrl: string;
	expiresAtMs: number;
};

type PollPayload =
	| {
			status: "pending" | "completed" | "expired" | "denied" | "error";
			exchangeToken?: string;
			message?: string;
	  }
	/** HTTP 429: wait as told (or back off) and poll again; not a failure. */
	| { status: "rate-limited"; retryAfterMs: number | undefined };

/** Narrow a decoded JSON body at the network boundary, once per response. */
function asRecord(value: unknown, message: string): Record<string, unknown> {
	if (isRecord(value)) return value;
	throw new AIError.OAuthError(`${message}: malformed JSON response`, { kind: "validation", provider: "mistral" });
}

function requiredString(record: Record<string, unknown>, field: string, message: string): string {
	const value = record[field];
	if (typeof value === "string" && value.length > 0) return value;
	throw new AIError.OAuthError(`${message}: response is missing "${field}"`, {
		kind: "validation",
		provider: "mistral",
	});
}

/**
 * Reject any URL the sign-in server returns outside its own origin and base path.
 * The path check is segment-aware, so `/api` admits `/api/...` but not `/api-other`.
 */
function assertUrlUnder(value: string, baseUrl: string, message: string): string {
	const url = URL.parse(value);
	const base = new URL(baseUrl);
	const basePath = base.pathname.replace(/\/+$/, "");
	if (
		!url ||
		url.origin !== base.origin ||
		(basePath !== "" && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
	) {
		throw new AIError.OAuthError(`${message}: unexpected URL ${value}`, { kind: "validation", provider: "mistral" });
	}
	return url.href;
}

/** Non-2xx or unparseable bodies are `http` failures: the console answered, but not usefully. */
async function readJson(response: Response, message: string): Promise<unknown> {
	if (!response.ok) {
		throw new AIError.OAuthError(`${message}: HTTP ${response.status}`, {
			kind: "http",
			provider: "mistral",
			status: response.status,
		});
	}
	try {
		return await response.json();
	} catch (cause) {
		throw new AIError.OAuthError(`${message}: malformed JSON response`, {
			kind: "http",
			provider: "mistral",
			status: response.status,
			cause,
		});
	}
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
}

/** `fetch` bound to the login's abort signal; an abort surfaces as a cancelled login. */
async function request(url: string, init: RequestInit, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<Response> {
	throwIfCancelled(ctrl.signal);
	try {
		return await fetchImpl(url, { ...init, signal: ctrl.signal });
	} catch (error) {
		throwIfCancelled(ctrl.signal);
		throw error;
	}
}

async function postJson(
	url: string,
	body: Record<string, string>,
	ctrl: OAuthController,
	fetchImpl: FetchImpl,
	message: string,
): Promise<unknown> {
	const response = await request(
		url,
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
		ctrl,
		fetchImpl,
	);
	return readJson(response, message);
}

async function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	try {
		await sleepLong(ms, signal);
	} catch (error) {
		throwIfCancelled(signal);
		throw error;
	}
}

async function startSignIn(codeChallenge: string, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<SignInProcess> {
	const message = "Failed to start Mistral browser sign-in";
	const payload = asRecord(
		await postJson(
			`${AUTH_API_BASE_URL}${SIGN_IN_PATH}`,
			{ code_challenge: codeChallenge, code_challenge_method: "S256" },
			ctrl,
			fetchImpl,
			message,
		),
		message,
	);
	const expiresAtMs = Date.parse(requiredString(payload, "expires_at", message));
	if (!Number.isFinite(expiresAtMs)) {
		throw new AIError.OAuthError(`${message}: invalid expires_at`, { kind: "validation", provider: "mistral" });
	}
	return {
		processId: requiredString(payload, "process_id", message),
		signInUrl: assertUrlUnder(requiredString(payload, "sign_in_url", message), AUTH_BASE_URL, message),
		pollUrl: assertUrlUnder(requiredString(payload, "poll_url", message), AUTH_API_BASE_URL, message),
		expiresAtMs,
	};
}

async function pollSignIn(process: SignInProcess, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<PollPayload> {
	const message = "Mistral sign-in status unavailable";
	const response = await request(process.pollUrl, {}, ctrl, fetchImpl);
	// The process is gone: 410 instead of a status payload.
	if (response.status === 410) return { status: "expired" };
	if (response.status === 429)
		return { status: "rate-limited", retryAfterMs: getRetryAfterMsFromHeaders(response.headers) };
	const payload = asRecord(await readJson(response, message), message);
	const status = payload.status;
	if (
		status !== "pending" &&
		status !== "completed" &&
		status !== "expired" &&
		status !== "denied" &&
		status !== "error"
	) {
		throw new AIError.OAuthError("Mistral sign-in returned an unknown state", {
			kind: "validation",
			provider: "mistral",
		});
	}
	const exchangeToken = payload.exchange_token;
	const detail = payload.message;
	return {
		status,
		exchangeToken: typeof exchangeToken === "string" && exchangeToken.length > 0 ? exchangeToken : undefined,
		message: typeof detail === "string" && detail.length > 0 ? detail : undefined,
	};
}

/**
 * Poll until the browser session settles. A dropped connection or a 5xx/garbled
 * poll answer is retried on the next tick; only {@link MAX_CONSECUTIVE_POLL_FAILURES}
 * in a row abort the login, so one network blip does not waste the user's approval.
 * HTTP 429 is not a failure: the console throttles steady 3-second polling well before
 * expiry, so the loop honors `Retry-After` (else doubles its interval) until the process expires.
 */
async function waitForCompletion(process: SignInProcess, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<string> {
	let consecutiveFailures = 0;
	let intervalMs = POLL_INTERVAL_MS;
	while (Date.now() < process.expiresAtMs) {
		let result: PollPayload;
		try {
			result = await pollSignIn(process, ctrl, fetchImpl);
			consecutiveFailures = 0;
		} catch (error) {
			if (!isTransientPollFailure(error) || ++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
			await sleepUntilNextPoll(process, ctrl, intervalMs);
			continue;
		}
		switch (result.status) {
			case "rate-limited":
				intervalMs = result.retryAfterMs ?? Math.min(intervalMs * 2, MAX_RATE_LIMIT_BACKOFF_MS);
				await sleepUntilNextPoll(process, ctrl, intervalMs);
				break;
			case "pending":
				await sleepUntilNextPoll(process, ctrl, intervalMs);
				break;
			case "completed":
				if (result.exchangeToken) return result.exchangeToken;
				throw new AIError.OAuthError("Mistral sign-in completed without an exchange token", {
					kind: "validation",
					provider: "mistral",
				});
			case "expired":
				throw new AIError.OAuthError("Mistral sign-in expired; run /login again", {
					kind: "timeout",
					provider: "mistral",
				});
			case "denied":
				throw new AIError.OAuthError("Mistral sign-in was denied", { kind: "device-auth", provider: "mistral" });
			case "error":
				throw new AIError.OAuthError(result.message ?? "Mistral sign-in failed", {
					kind: "polling",
					provider: "mistral",
				});
		}
	}
	throw new AIError.OAuthError("Mistral sign-in timed out; run /login again", {
		kind: "timeout",
		provider: "mistral",
	});
}

/** Network errors and `http`-kind answers are worth another poll; cancellation and bad states are not. */
function isTransientPollFailure(error: unknown): boolean {
	if (error instanceof AIError.LoginCancelledError) return false;
	if (error instanceof AIError.OAuthError) return error.kind === "http";
	return error instanceof Error;
}

async function sleepUntilNextPoll(process: SignInProcess, ctrl: OAuthController, intervalMs: number): Promise<void> {
	await abortableSleep(Math.min(intervalMs, Math.max(0, process.expiresAtMs - Date.now())), ctrl.signal);
}

async function exchangeForApiKey(
	process: SignInProcess,
	exchangeToken: string,
	codeVerifier: string,
	ctrl: OAuthController,
	fetchImpl: FetchImpl,
): Promise<string> {
	const message = "Failed to exchange Mistral sign-in for an API key";
	const response = await request(
		`${AUTH_API_BASE_URL}${SIGN_IN_PATH}/${encodeURIComponent(process.processId)}/exchange`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: codeVerifier }),
		},
		ctrl,
		fetchImpl,
	);
	if (response.status === 403 && (await isWorkspaceApiKeyCreationDenied(response))) {
		throw new AIError.OAuthError(
			"Your Mistral workspace can't be used for Mistral Vibe; run /login again and pick another workspace in the browser, or ask your administrator",
			{ kind: "entitlement", provider: "mistral", status: 403 },
		);
	}
	const payload = asRecord(await readJson(response, message), message);
	return requiredString(payload, "api_key", message);
}

/** The console refuses to mint a key for workspaces without Vibe access (403, `error_code` 9004). */
async function isWorkspaceApiKeyCreationDenied(response: Response): Promise<boolean> {
	try {
		const body: unknown = await response.clone().json();
		return isRecord(body) && body.error_code === API_KEYS_CREATE_UNAUTHORIZED_ERROR_CODE;
	} catch {
		return false;
	}
}

/**
 * `login "custom" hook="mistral-vibe-sign-in"`: whole-flow login for the Mistral provider.
 * Returns the minted key as a string so `/login` stores it as a plain API-key credential.
 */
export async function loginMistralVibeSignIn(ctrl: OAuthController): Promise<string> {
	throwIfCancelled(ctrl.signal);
	const fetchImpl = ctrl.fetch ?? fetch;
	const { verifier, challenge } = await generatePKCE();
	const process = await startSignIn(challenge, ctrl, fetchImpl);
	throwIfCancelled(ctrl.signal);
	ctrl.onAuth?.({
		url: process.signInUrl,
		instructions: "Sign in with your Mistral account and approve Mistral Vibe access, then return here.",
	});
	ctrl.onProgress?.("Waiting for Mistral sign-in to complete...");
	const exchangeToken = await waitForCompletion(process, ctrl, fetchImpl);
	ctrl.onProgress?.("Exchanging sign-in for a Mistral API key...");
	return exchangeForApiKey(process, exchangeToken, verifier, ctrl, fetchImpl);
}
