/**
 * Agent-id derivation for the Dakera backend.
 *
 * Dakera has no bank: the isolation unit is the `agent_id`, so Hindsight's
 * bank-id scheme collapses to an agent-id scheme. Two modes, matching
 * `dakera.scoping`:
 *   - `global`       — one shared agent_id, every project's memories mix.
 *   - `per-project`  — one agent_id per repository, hard isolation.
 *
 * `per-project-tagged` is deliberately absent: Dakera's `recall` accepts no
 * tag filter, so a shared agent_id with per-project tags would retain into a
 * scope it could never read back — every project would see every other
 * project's memories.
 *
 * The base id is `agentIdPrefix-agentId` (default `omp`); per-project mode
 * appends `-<project>`.
 *
 * No setup call is needed: storing against an unseen `agent_id` creates it,
 * which is why this module has no `ensureBankExists` counterpart.
 */

import { projectLabel } from "../hindsight/bank";
import { resolveDakeraAgentIdOverride } from "./agent-override";
import type { DakeraConfig } from "./config";

const DEFAULT_AGENT_NAME = "omp";
const PROJECT_TAG_PREFIX = "project:";

/** Resolved agent target for a session. */
export interface AgentScope {
	agentId: string;
	/** Tags attached to every retain. Set only in `global` mode, where the
	 * agent_id alone cannot say which project a memory came from. */
	retainTags?: string[];
}

/** Compose the prefixed base agent id (no project segment). */
function baseAgentId(config: DakeraConfig): string {
	const base = config.agentId?.trim() || DEFAULT_AGENT_NAME;
	const prefix = config.agentIdPrefix?.trim() || "";
	return prefix ? `${prefix}-${base}` : base;
}

/**
 * Resolve the active agent target for a working directory.
 *
 * Async because a per-repo `.omp/config.yml` `dakera.agentId` override is
 * consulted first (see `agent-override.ts`): when present it names the agent
 * outright — no prefix, no project segment — so every repo, subfolder and
 * worktree that opts in converges on one agent id.
 */
export async function computeAgentScope(config: DakeraConfig, directory: string): Promise<AgentScope> {
	const override = await resolveDakeraAgentIdOverride(directory);
	if (override) return { agentId: override };
	const base = baseAgentId(config);
	switch (config.scoping) {
		case "global":
			return { agentId: base, retainTags: [`${PROJECT_TAG_PREFIX}${projectLabel(directory)}`] };
		case "per-project":
			return { agentId: `${base}-${projectLabel(directory)}` };
	}
}
