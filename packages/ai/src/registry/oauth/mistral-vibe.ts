/**
 * Mistral Vibe browser sign-in: the same flow the Vibe Code CLI uses
 * (mistralai/mistral-vibe, vibe/setup/auth/). Mistral's console provisions and
 * stores a regular API key; the browser session does the authorizing, so no
 * password ever transits this code.
 *
 * Flow, verified 2026-11-01 against a live account:
 *  1. POST https://console.mistral.ai/api/vibe/sign-in
 *     { code_challenge, code_challenge_method: "S256" }  (no auth header)
 *     -> { process_id, sign_in_url, poll_url, expires_at }
 *  2. The user approves in the browser at sign_in_url.
 *  3. Poll GET poll_url -> { status: "pending" | "completed" | ... ,
 *     exchange_token? } (HTTP 410 once the process expires; HTTP 429 when
 *     polled too often).
 *  4. POST .../vibe/sign-in/{process_id}/exchange
 *     { exchange_token, code_verifier } -> { api_key }
 *
 * The minted key authenticates https://api.mistral.ai/v1 over the plain
 * `openai-completions` transport; its usage is billed against the Vibe Code
 * quota of the signed-in plan, not against pay-as-you-go API credits.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { getRetryAfterMsFromHeaders } from "../../utils/retry-after";
import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import { generatePKCE } from "./pkce";
import type { OAuthController } from "./types";

const AUTH_BASE_URL = "https://console.mistral.ai";
const AUTH_API_BASE_URL = `${AUTH_BASE_URL}/api`;
const SIGN_IN_PATH = "/vibe/sign-in";
/** The Vibe CLI's poll cadence. */
const POLL_INTERVAL_SECONDS = 3;
/** Consecutive transient poll failures tolerated before giving up (matches the Vibe CLI). */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
/** Longest `Retry-After` honored, so one large value cannot hide an approval until expiry. */
const MAX_RETRY_AFTER_MS = 30_000;
/** Console `error_code` when the selected workspace may not mint API keys. */
const API_KEYS_CREATE_UNAUTHORIZED_ERROR_CODE = 9004;

type SignIn = {
	processId: string;
	signInUrl: string;
	pollUrl: string;
	expiresAtMs: number;
};

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

/** POST a JSON body under the login's signal; an abort surfaces as a cancelled login. */
async function postJson(
	url: string,
	body: Record<string, string>,
	ctrl: OAuthController,
	fetchImpl: FetchImpl,
): Promise<Response> {
	throwIfCancelled(ctrl.signal);
	try {
		return await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
	} catch (error) {
		throwIfCancelled(ctrl.signal);
		throw error;
	}
}

async function startSignIn(codeChallenge: string, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<SignIn> {
	const message = "Failed to start Mistral browser sign-in";
	const response = await postJson(
		`${AUTH_API_BASE_URL}${SIGN_IN_PATH}`,
		{ code_challenge: codeChallenge, code_challenge_method: "S256" },
		ctrl,
		fetchImpl,
	);
	const payload = asRecord(await readJson(response, message), message);
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

/**
 * One poll, classified for {@link pollOAuthDeviceCodeFlow}. Terminal states throw typed
 * errors (the shared loop rethrows them). HTTP 429 maps to `slow_down` carrying the
 * console's `Retry-After`. A dropped connection or a 5xx/garbled answer is reported as
 * `pending` until `failures` reaches {@link MAX_CONSECUTIVE_POLL_FAILURES} in a row, so
 * one network blip does not waste the user's approval.
 */
async function pollSignIn(
	signIn: SignIn,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
	failures: { consecutive: number },
): Promise<OAuthDeviceCodePollResult<string>> {
	const message = "Mistral sign-in status unavailable";
	let payload: Record<string, unknown>;
	try {
		const response = await fetchImpl(signIn.pollUrl, { signal });
		if (response.status === 410) {
			throw new AIError.OAuthError("Mistral sign-in expired; run /login again", {
				kind: "timeout",
				provider: "mistral",
			});
		}
		if (response.status === 429) {
			failures.consecutive = 0;
			const retryAfterMs = getRetryAfterMsFromHeaders(response.headers);
			return {
				status: "slow_down",
				retryAfterMs: retryAfterMs === undefined ? undefined : Math.min(retryAfterMs, MAX_RETRY_AFTER_MS),
			};
		}
		payload = asRecord(await readJson(response, message), message);
	} catch (error) {
		const transient =
			!signal?.aborted && (error instanceof AIError.OAuthError ? error.kind === "http" : error instanceof Error);
		if (!transient || ++failures.consecutive >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
		return { status: "pending" };
	}
	failures.consecutive = 0;

	switch (payload.status) {
		case "pending":
			return { status: "pending" };
		case "completed": {
			const exchangeToken = payload.exchange_token;
			if (typeof exchangeToken === "string" && exchangeToken.length > 0) {
				return { status: "complete", value: exchangeToken };
			}
			throw new AIError.OAuthError("Mistral sign-in completed without an exchange token", {
				kind: "validation",
				provider: "mistral",
			});
		}
		case "expired":
			throw new AIError.OAuthError("Mistral sign-in expired; run /login again", {
				kind: "timeout",
				provider: "mistral",
			});
		case "denied":
			throw new AIError.OAuthError("Mistral sign-in was denied", { kind: "device-auth", provider: "mistral" });
		case "error": {
			const detail = payload.message;
			throw new AIError.OAuthError(
				typeof detail === "string" && detail.length > 0 ? detail : "Mistral sign-in failed",
				{ kind: "polling", provider: "mistral" },
			);
		}
		default:
			throw new AIError.OAuthError("Mistral sign-in returned an unknown state", {
				kind: "validation",
				provider: "mistral",
			});
	}
}

async function waitForCompletion(signIn: SignIn, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<string> {
	const failures = { consecutive: 0 };
	try {
		return await pollOAuthDeviceCodeFlow({
			intervalSeconds: POLL_INTERVAL_SECONDS,
			expiresInSeconds: Math.max(0, signIn.expiresAtMs - Date.now()) / 1000,
			signal: ctrl.signal,
			poll: signal => pollSignIn(signIn, signal, fetchImpl, failures),
		});
	} catch (error) {
		// The shared timeout text blames RFC 8628 clock drift; a console process just expired.
		if (error instanceof AIError.OAuthError && error.kind === "timeout" && error.provider === undefined) {
			throw new AIError.OAuthError("Mistral sign-in timed out; run /login again", {
				kind: "timeout",
				provider: "mistral",
				cause: error,
			});
		}
		throw error;
	}
}

async function exchangeForApiKey(
	signIn: SignIn,
	exchangeToken: string,
	codeVerifier: string,
	ctrl: OAuthController,
	fetchImpl: FetchImpl,
): Promise<string> {
	const message = "Failed to exchange Mistral sign-in for an API key";
	const response = await postJson(
		`${AUTH_API_BASE_URL}${SIGN_IN_PATH}/${encodeURIComponent(signIn.processId)}/exchange`,
		{ exchange_token: exchangeToken, code_verifier: codeVerifier },
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
	const signIn = await startSignIn(challenge, ctrl, fetchImpl);
	throwIfCancelled(ctrl.signal);
	ctrl.onAuth?.({
		url: signIn.signInUrl,
		instructions: "Sign in with your Mistral account and approve Mistral Vibe access, then return here.",
	});
	ctrl.onProgress?.("Waiting for Mistral sign-in to complete...");
	const exchangeToken = await waitForCompletion(signIn, ctrl, fetchImpl);
	ctrl.onProgress?.("Exchanging sign-in for a Mistral API key...");
	return exchangeForApiKey(signIn, exchangeToken, verifier, ctrl, fetchImpl);
}
