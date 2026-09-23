/**
 * Resolved Dakera runtime configuration.
 *
 * Source of truth precedence (last wins):
 *   1. Built-in defaults
 *   2. Settings (`dakera.*` schema entries via `Settings.get(...)`)
 *   3. `DAKERA_*` environment variables
 *
 * Env wins because operators frequently override per-shell (CI, prod) without
 * touching the persisted settings file. Both `DAKERA_API_TOKEN` (the
 * coding-agent convention, mirroring `HINDSIGHT_API_TOKEN`) and
 * `DAKERA_API_KEY` (the name the Dakera server and SDKs use) are accepted for
 * the bearer token, so a deployment can export one variable and have the
 * server, the MCP surface and omp agree.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export type DakeraScoping = "global" | "per-project";

export interface DakeraConfig {
	apiUrl: string | null;
	apiToken: string | null;

	agentId: string | null;
	agentIdPrefix: string;
	scoping: DakeraScoping;

	autoRecall: boolean;
	autoRetain: boolean;

	retainMode: "full-session" | "last-turn";
	retainEveryNTurns: number;
	/** `importance` sent on store (0.0–1.0). Dakera raises it on every read. */
	retainImportance: number;

	recallTopK: number;
	recallMinImportance: number;
	/** Server-side rerank pass. Expensive on CPU-only hosts; server default is on. */
	recallRerank: boolean;
	recallContextTurns: number;
	recallMaxQueryChars: number;

	/** Model selector for the client-side `reflect` synthesis; empty = smol role, then default. */
	reflectModel: string | null;

	debug: boolean;

	/** Default per-request client deadline (ms) for ops without a specific override. */
	requestTimeoutMs: number;
	/** Client deadline (ms) for recall. */
	recallTimeoutMs: number;
	/** Client deadline (ms) for store / storeBatch. */
	retainTimeoutMs: number;
	/** Client deadline (ms) for the `reflect` model call. */
	reflectTimeoutMs: number;
}

const VALID_RETAIN_MODES: DakeraConfig["retainMode"][] = ["full-session", "last-turn"];
const VALID_SCOPINGS: DakeraScoping[] = ["global", "per-project"];

const DEFAULT_PREAMBLE =
	"Relevant memories from past conversations (prioritize recent when conflicting). " +
	"Only use memories that are directly useful to continue this conversation; ignore the rest:";

function envBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return ["true", "1", "yes"].includes(value.toLowerCase());
}

function envNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function envString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function pickRetainMode(value: unknown): DakeraConfig["retainMode"] | undefined {
	return typeof value === "string" && (VALID_RETAIN_MODES as string[]).includes(value)
		? (value as DakeraConfig["retainMode"])
		: undefined;
}

function pickScoping(value: unknown): DakeraScoping | undefined {
	return typeof value === "string" && (VALID_SCOPINGS as string[]).includes(value)
		? (value as DakeraScoping)
		: undefined;
}

/**
 * Load the resolved Dakera config.
 *
 * Pure (no I/O) aside from reading `process.env` and the supplied Settings
 * instance, so tests can pass `Settings.isolated({...})` and stub env per case.
 */
export function loadDakeraConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): DakeraConfig {
	const apiUrlEnv = envString(env.DAKERA_API_URL);
	const apiTokenEnv = envString(env.DAKERA_API_TOKEN) ?? envString(env.DAKERA_API_KEY);
	const agentIdEnv = envString(env.DAKERA_AGENT_ID);
	const scopingEnv = pickScoping(env.DAKERA_SCOPING);
	const retainModeEnv = pickRetainMode(env.DAKERA_RETAIN_MODE);
	const autoRecallEnv = envBool(env.DAKERA_AUTO_RECALL);
	const autoRetainEnv = envBool(env.DAKERA_AUTO_RETAIN);
	const rerankEnv = envBool(env.DAKERA_RECALL_RERANK);
	const debugEnv = envBool(env.DAKERA_DEBUG);

	const settingsScoping = pickScoping(settings.get("dakera.scoping"));
	if (settings.get("dakera.scoping") && !settingsScoping) {
		logger.warn("Dakera: invalid scoping setting, falling back to per-project", {
			value: settings.get("dakera.scoping"),
		});
	}
	const settingsRetainMode = pickRetainMode(settings.get("dakera.retainMode"));
	if (settings.get("dakera.retainMode") && !settingsRetainMode) {
		logger.warn("Dakera: invalid retainMode setting, falling back to full-session", {
			value: settings.get("dakera.retainMode"),
		});
	}

	return {
		apiUrl: apiUrlEnv ?? settings.get("dakera.apiUrl") ?? null,
		apiToken: apiTokenEnv ?? settings.get("dakera.apiToken") ?? null,

		agentId: agentIdEnv ?? settings.get("dakera.agentId") ?? null,
		agentIdPrefix: settings.get("dakera.agentIdPrefix") ?? "",
		scoping: scopingEnv ?? settingsScoping ?? "per-project",

		autoRecall: autoRecallEnv ?? settings.get("dakera.autoRecall"),
		autoRetain: autoRetainEnv ?? settings.get("dakera.autoRetain"),

		retainMode: retainModeEnv ?? settingsRetainMode ?? "full-session",
		retainEveryNTurns: envNumber(env.DAKERA_RETAIN_EVERY_N_TURNS) ?? settings.get("dakera.retainEveryNTurns"),
		retainImportance: envNumber(env.DAKERA_RETAIN_IMPORTANCE) ?? settings.get("dakera.retainImportance"),

		recallTopK: envNumber(env.DAKERA_RECALL_TOP_K) ?? settings.get("dakera.recallTopK"),
		recallMinImportance: envNumber(env.DAKERA_RECALL_MIN_IMPORTANCE) ?? settings.get("dakera.recallMinImportance"),
		recallRerank: rerankEnv ?? settings.get("dakera.recallRerank"),
		recallContextTurns: envNumber(env.DAKERA_RECALL_CONTEXT_TURNS) ?? settings.get("dakera.recallContextTurns"),
		recallMaxQueryChars: envNumber(env.DAKERA_RECALL_MAX_QUERY_CHARS) ?? settings.get("dakera.recallMaxQueryChars"),

		reflectModel: envString(env.DAKERA_REFLECT_MODEL) ?? settings.get("dakera.reflectModel") ?? null,

		debug: debugEnv ?? settings.get("dakera.debug"),

		requestTimeoutMs: envNumber(env.DAKERA_REQUEST_TIMEOUT_MS) ?? settings.get("dakera.requestTimeoutMs"),
		recallTimeoutMs: envNumber(env.DAKERA_RECALL_TIMEOUT_MS) ?? settings.get("dakera.recallTimeoutMs"),
		retainTimeoutMs: envNumber(env.DAKERA_RETAIN_TIMEOUT_MS) ?? settings.get("dakera.retainTimeoutMs"),
		reflectTimeoutMs: envNumber(env.DAKERA_REFLECT_TIMEOUT_MS) ?? settings.get("dakera.reflectTimeoutMs"),
	};
}

/** Whether the caller has enough config to talk to a Dakera server. */
export function isDakeraConfigured(config: DakeraConfig): config is DakeraConfig & { apiUrl: string } {
	return typeof config.apiUrl === "string" && config.apiUrl.length > 0;
}

/** Preamble above the injected `<memories>` block. */
export const DAKERA_RECALL_PREAMBLE = DEFAULT_PREAMBLE;
