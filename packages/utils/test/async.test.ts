import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { MAX_TIMER_DELAY_MS, sleepLong, sleepUntil } from "@oh-my-pi/pi-utils/async";

function mockMonotonicScheduler(elapsedForWait: (delayMs: number) => number = delayMs => delayMs) {
	const startedAt = 10_000;
	let now = startedAt;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const wait = vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		now += elapsedForWait(delayMs);
		options?.signal?.throwIfAborted();
	});
	return { elapsed: () => now - startedAt, wait };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sleepLong", () => {
	it("waits until the requested monotonic deadline", async () => {
		const clock = mockMonotonicScheduler();

		await sleepLong(60_000);

		expect(clock.elapsed()).toBe(60_000);
	});

	it("waits across the native timer boundary without overflowing a timer", async () => {
		const clock = mockMonotonicScheduler(delayMs => {
			if (delayMs > MAX_TIMER_DELAY_MS) throw new RangeError("timer overflow");
			return delayMs;
		});
		const delayMs = MAX_TIMER_DELAY_MS + 1_000;

		await sleepLong(delayMs);

		expect(clock.elapsed()).toBe(delayMs);
	});

	it("re-arms after early wakes until the full delay has elapsed", async () => {
		const clock = mockMonotonicScheduler(delayMs => Math.max(1, delayMs / 2));

		await sleepLong(60_000);

		expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
	});

	it("propagates an abort during a wait", async () => {
		const controller = new AbortController();
		mockMonotonicScheduler(delayMs => {
			controller.abort(new Error("cancelled"));
			return delayMs;
		});

		await expect(sleepLong(MAX_TIMER_DELAY_MS + 1_000, controller.signal)).rejects.toThrow("cancelled");
	});

	it("rejects a pre-aborted zero-length sleep without arming a timer", async () => {
		const clock = mockMonotonicScheduler();
		const controller = new AbortController();
		controller.abort();

		await expect(sleepLong(0, controller.signal)).rejects.toThrow("The operation was aborted");
		expect(clock.wait).not.toHaveBeenCalled();
	});
});

describe("sleepUntil", () => {
	it("finishes after a suspended wall-clock deadline without waiting out the monotonic remainder", async () => {
		let wall = 1_000_000;
		const delayMs = 220 * 60_000;
		vi.spyOn(Date, "now").mockImplementation(() => wall);
		vi.spyOn(performance, "now").mockReturnValue(10_000);
		vi.spyOn(scheduler, "wait").mockImplementation(async delay => {
			// Relative timers may exclude suspend: at most one second of
			// active runtime may remain before checking the expired deadline.
			expect(delay).toBeLessThanOrEqual(1_000);
			wall += delayMs + 60_000;
		});

		await sleepUntil(wall + delayMs);
		expect(Date.now()).toBeGreaterThanOrEqual(1_000_000 + delayMs);
	});

	it("does not retry before a future deadline, including after a backward clock correction", async () => {
		let wall = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => wall);
		let firstWait = true;
		vi.spyOn(scheduler, "wait").mockImplementation(async delayMs => {
			if (firstWait) {
				wall -= 2_000;
				firstWait = false;
			} else {
				wall += delayMs;
			}
		});

		await sleepUntil(12_000);
		expect(wall).toBe(12_000);
	});

	it("propagates cancellation even when the deadline expires during the wait", async () => {
		let wall = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => wall);
		const controller = new AbortController();
		vi.spyOn(scheduler, "wait").mockImplementation(async () => {
			wall += 10_000;
			controller.abort(new Error("cancelled"));
		});

		await expect(sleepUntil(12_000, controller.signal)).rejects.toThrow("cancelled");
	});

	it("does not overflow a timer for quota deadlines beyond the native timer limit", async () => {
		let wall = 10_000;
		const deadline = wall + MAX_TIMER_DELAY_MS + 60_000;
		vi.spyOn(Date, "now").mockImplementation(() => wall);
		vi.spyOn(scheduler, "wait").mockImplementation(async delay => {
			if (delay > MAX_TIMER_DELAY_MS) throw new RangeError("timer overflow");
			wall = deadline;
		});

		await sleepUntil(deadline);
		expect(wall).toBe(deadline);
	});

	it("keeps a pre-aborted expired deadline cancelled", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled before retry"));
		await expect(sleepUntil(Date.now() - 1, controller.signal)).rejects.toThrow("cancelled before retry");
	});
});
