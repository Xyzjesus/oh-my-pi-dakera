import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { cerebrasModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

async function discoverModels(data: readonly Record<string, unknown>[]) {
	const options = cerebrasModelManagerOptions({
		apiKey: "cerebras-test-key",
		fetch: async () => Response.json({ data }),
	});
	return options.fetchDynamicModels?.();
}

describe("Cerebras provider discovery", () => {
	test("discovers gemma-4-31b as image-capable", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					data: [
						{ id: "gemma-4-31b", object: "model" },
						{ id: "llama3.1-8b", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = cerebrasModelManagerOptions({ apiKey: "cerebras-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.cerebras.ai/v1/models",
				authorization: "Bearer cerebras-test-key",
			},
		]);
		expect(models?.find(model => model.id === "gemma-4-31b")).toMatchObject({
			provider: "cerebras",
			api: "openai-completions",
			input: ["text", "image"],
		});
		expect(models?.find(model => model.id === "llama3.1-8b")?.input).toEqual(["text"]);
	});

	test.each([
		["both limits", 200_000, 32_000, 200_000, 32_000],
		["context only", 200_000, undefined, 200_000, null],
		["output only", undefined, 32_000, null, 32_000],
		["numeric strings", "200000", "32000", 200_000, 32_000],
	] as const)(
		"reads provider-reported %s for an unbundled model",
		async (_, context, output, contextWindow, maxTokens) => {
			const models = await discoverModels([
				{ id: "new-unbundled-model", context_length: context, max_completion_tokens: output },
			]);

			expect(models).toMatchObject([{ id: "new-unbundled-model", contextWindow, maxTokens }]);
		},
	);

	test.each([
		["missing", undefined],
		["null", null],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["non-numeric", "invalid"],
		["non-finite", "Infinity"],
		["boolean", true],
		["object", {}],
	] as const)("keeps unknown limits for %s values without discarding the valid counterpart", async (_, invalid) => {
		const models = await discoverModels([
			{ id: "invalid-context", context_length: invalid, max_completion_tokens: 32_000 },
			{ id: "invalid-output", context_length: 200_000, max_completion_tokens: invalid },
		]);

		expect(models).toMatchObject([
			{ id: "invalid-context", contextWindow: null, maxTokens: 32_000 },
			{ id: "invalid-output", contextWindow: 200_000, maxTokens: null },
		]);
	});

	test("retains bundled limit fallbacks and live overrides", async () => {
		const reference = getBundledModels("cerebras").find(model => model.id === "gemma-4-31b");
		expect(reference).toBeDefined();
		const fallback = await discoverModels([{ id: "gemma-4-31b" }]);
		const live = await discoverModels([{ id: "gemma-4-31b", context_length: 64_000, max_completion_tokens: 8_192 }]);

		expect(fallback).toMatchObject([
			{ id: "gemma-4-31b", contextWindow: reference!.contextWindow, maxTokens: reference!.maxTokens },
		]);
		expect(live).toMatchObject([{ id: "gemma-4-31b", contextWindow: 64_000, maxTokens: 8_192 }]);
	});
});
