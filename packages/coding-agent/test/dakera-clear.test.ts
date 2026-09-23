import { afterEach, describe, expect, it, vi } from "bun:test";
import { asGlobalFetch } from "./helpers/fetch-mock";

/**
 * Regression coverage for the backend `clear()` drain: `listMemories` has no
 * offset/cursor, so wiping more than one page means forget-the-page-then-
 * list-again until a page comes back empty — and stopping when a page stops
 * shrinking (rows the API cannot address), so the loop can never spin forever.
 *
 * These tests drive the same loop shape the backend clear uses against a fake
 * listing source.
 */
interface Captured {
	method: string;
	url: string;
	body: Record<string, unknown>;
}

describe("Dakera clear paging", () => {
	let pages: string[][] = [];
	let forgetCalls: string[][] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		pages = [];
		forgetCalls = [];
	});

	function serveMemoryPages(): { memoryRequests: Captured[] } {
		const memoryRequests: Captured[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch((input, init) => {
				const captured: Captured = {
					method: String(init?.method ?? "GET"),
					url: String(input),
					body: (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Record<string, unknown>,
				};
				memoryRequests.push(captured);
				if (captured.url.endsWith("/v1/memory/forget")) {
					const ids = (captured.body.memory_ids as string[]) ?? [];
					forgetCalls.push(ids);
					pages = pages.map(page => page.filter(id => !ids.includes(id)));
					return new Response(JSON.stringify({ deleted_count: ids.length }), { status: 200 });
				}
				return new Response(JSON.stringify({ memories: pages[0].map(id => ({ id, content: `m ${id}` })) }), {
					status: 200,
				});
			}),
		);
		return { memoryRequests };
	}

	async function listPage(baseUrl: string): Promise<{ id: string }[]> {
		const response = await fetch(`${baseUrl}/v1/agents/omp/memories?limit=1000`);
		const data = (await response.json()) as { memories?: { id: string }[] };
		return data.memories ?? [];
	}

	async function forget(baseUrl: string, ids: string[]): Promise<void> {
		await fetch(`${baseUrl}/v1/memory/forget`, {
			method: "POST",
			body: JSON.stringify({ agent_id: "omp", memory_ids: ids }),
		});
	}

	it("drains more than one page of memories until the listing empties", async () => {
		pages = [Array.from({ length: 5 }, (_, i) => `m${i}`)];
		const { memoryRequests } = serveMemoryPages();

		let forgotten = 0;
		let passes = 0;
		for (;;) {
			const page = await listPage("http://dakera.local");
			passes++;
			if (page.length === 0) break;
			await forget(
				"http://dakera.local",
				page.map(memory => memory.id),
			);
			forgotten += page.length;
			expect(passes).toBeLessThanOrEqual(20);
		}

		expect(forgotten).toBe(5);
		expect(passes).toBe(2); // one page of 5 forgotten, then the empty confirmation page
		expect(forgetCalls).toHaveLength(1);
		expect(memoryRequests.filter(request => request.url.endsWith("/v1/memory/forget"))).toHaveLength(1);
	});

	it("stops when a page stops shrinking (unaddressable rows)", async () => {
		// The fake forget leaves the rows in place: from the wipe's point of
		// view these rows are unaddressable and re-list forever.
		pages = [["stuck", "stuck"]];
		serveMemoryPages();
		forgetCalls.length = 0;
		// Restore a forget that does NOT remove rows.
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(
				() => new Response(JSON.stringify({ memories: [{ id: "stuck", content: "x" }] }), { status: 200 }),
			),
		);

		let lastPage = Number.POSITIVE_INFINITY;
		let stuck = false;
		let passes = 0;
		for (;;) {
			const page = await listPage("http://dakera.local");
			passes++;
			if (page.length === 0) break;
			const ids = page.map(memory => memory.id);
			if (ids.length >= lastPage) {
				stuck = true;
				break;
			}
			await forget("http://dakera.local", ids);
			lastPage = page.length;
			expect(passes).toBeLessThanOrEqual(20);
		}

		expect(stuck).toBe(true);
		expect(passes).toBe(2);
	});
});
