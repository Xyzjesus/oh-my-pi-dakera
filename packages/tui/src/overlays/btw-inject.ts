import { visibleWidth, wrapTextWithAnsi } from "../index";
import { theme } from "../theme/theme";
import { card, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { formatBtwInjectText } from "./btw-history";

/** Labels a steering prompt that has not been sent yet. */
export const BTW_INJECT_LABEL = "Inject into main session";
/** Labels a sent steering prompt. */
export const BTW_INJECTED_LABEL = "Injected into main session";

/** A displayed `<inject>` block: still sendable, or sent. Blocks in neither state render as plain text. */
export type BtwInjectState = "pending" | "sent";

/**
 * Terminal lines for an answer's `<inject>` block: every wrapped line behind a gutter of
 * the `btw.rail` (pink while pending, green once sent) and the send arrow (`nav.selected`,
 * as on queued and IRC messages) or blanks as wide, then the label on the row below. Both
 * states take the same rows and text column, so sending recolours the block in place.
 */
export function renderBtwInjectLines(inject: string, width: number, injected: boolean): string[] {
	const arrow = theme.nav.selected;
	const color = injected ? "success" : "customMessageLabel";
	const marker = injected ? arrow : " ".repeat(visibleWidth(arrow));
	const prefix = `${theme.fg(color, theme.symbol("btw.rail"))} ${theme.bold(marker)} `;
	const inner = Math.max(1, width - visibleWidth(prefix));
	const body = formatBtwInjectText(inject)
		.split("\n")
		.flatMap(line => (line.trim() ? wrapTextWithAnsi(line, inner) : [""]))
		.map(line => `${prefix}${line}`);
	return [...body, `${prefix}${theme.fg(color, injected ? BTW_INJECTED_LABEL : BTW_INJECT_LABEL)}`];
}

/**
 * The same block for native surfaces, which wrap text themselves, so a per-row gutter
 * cannot follow wrapped lines: a card toned like the rail (`user` pending, `success` sent)
 * marks the whole block instead, with the label as its last row.
 */
export function describeBtwInject(inject: string, injected: boolean): NativeNode {
	const lines = formatBtwInjectText(inject).split("\n");
	const label = injected ? `${theme.nav.selected} ${BTW_INJECTED_LABEL}` : BTW_INJECT_LABEL;
	return card({ role: "omp.btw.inject", tone: injected ? "success" : "user" }, [
		...lines.map(line => text(line, { wrap: "word" })),
		text([span(label, injected ? "success" : "customMessageLabel")]),
	]);
}
