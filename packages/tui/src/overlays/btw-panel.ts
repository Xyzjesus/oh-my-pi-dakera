import { type Component, Markdown, Text, type TUI } from "../index";
import { replaceTabs } from "../render/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { sanitizeErrorLine } from "../chrome/error-block";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent } from "../chrome/streaming-panel";
import { boundKeys, interruptKey } from "../chrome/keybinding-hints";
import { formatKeyHint } from "../app-keybindings";
import type { NativeNode } from "../native/node";
import { col, md, node, span, text } from "../native/describe";
import { hintsRow, type NativeHint, statusHintsRow } from "../native/overlay";
import { appBtwInjectKeys } from "../keybinding-matchers";
import { type BtwInjectParts, getBtwInject, splitBtwInject } from "./btw-history";
import { describeBtwInject, renderBtwInjectLines } from "./btw-inject";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	/** Heading shown instead of `/btw <question>`, e.g. `/sitrep the migration` for a side command. */
	title?: string;
	tui: TUI;
	canBranch?: () => boolean;
	canFollowUp?: () => boolean;
	/**
	 * Given only while `btw.inject` is on: shows the answer's `<inject>` block as a highlighted
	 * block (send arrows once sent) and offers the inject key (`app.btw.inject`) while this returns true.
	 */
	canInject?: () => boolean;
}

/** An answer's `<inject>` block as a panel section; wraps at render time. */
class BtwInjectBlock implements Component {
	constructor(
		readonly inject: string,
		readonly injected: boolean,
	) {}

	render(width: number): readonly string[] {
		return renderBtwInjectLines(this.inject, width, this.injected);
	}

	invalidate(): void {}
}

export class BtwPanelComponent extends OverlayPanel {
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#canFollowUp: (() => boolean) | undefined;
	#canInject: (() => boolean) | undefined;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;
	#copied = false;
	#injected = false;
	#baseTitle: string;
	readonly #content: StreamingPanelContent;
	#native: { node: NativeNode; canFollowUp: boolean; canBranch: boolean; canInject: boolean } | undefined;

	constructor(options: BtwPanelComponentOptions) {
		const baseTitle = replaceTabs(options.title ?? `/btw ${options.question}`);
		super(baseTitle, "omp.overlay.btw");
		this.#baseTitle = baseTitle;
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#canFollowUp = options.canFollowUp;
		this.#canInject = options.canInject;
		this.#content = new StreamingPanelContent(() => ({
			sections: this.#contentSections(),
			footer: () => this.#footerLine(),
		}));
		this.addChild(this.#content);
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#injected = false;
		this.#setCopied(false);
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#injected = false;
		this.#setCopied(false);
		this.#rebuild();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	/** Visual confirmation that `c` copied the answer to the clipboard. */
	markCopied(): void {
		if (this.#closed || !this.isCopyable()) return;
		this.#setCopied(true);
		this.#rebuild();
	}

	/** Shows the answer's steering prompt as sent (send arrows, green), or back to pending when a send failed. */
	setInjected(injected: boolean): void {
		if (this.#closed || this.#injected === injected || this.getInjectText() === undefined) return;
		this.#injected = injected;
		this.#rebuild();
	}

	#setCopied(copied: boolean): void {
		this.#copied = copied;
		this.title = copied ? `${this.#baseTitle} ✓ Copied` : this.#baseTitle;
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		if (this.#closed) return;
		this.#state = "branching";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#setCopied(false);
		this.#rebuild();
	}
	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return this.#visibleAnswer;
	}

	/** The completed answer's steering prompt; undefined until a complete `<inject>` block exists. */
	getInjectText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return getBtwInject(this.#answer);
	}

	/**
	 * With `btw.inject` on, the answer around its `<inject>` block, which displays apart from
	 * the prose only while streaming or once the tag closed: an unclosed block in a finished
	 * answer cannot be sent, so it stays plain text.
	 */
	#injectParts(): BtwInjectParts | undefined {
		const parts = this.#canInject ? splitBtwInject(this.#visibleAnswer) : undefined;
		return parts && (parts.closed || this.#state === "running") ? parts : undefined;
	}

	/** The key hint shows only while a bound key can send the answer's steering prompt. */
	#showsInjectKey(): boolean {
		return (
			this.#canInject?.() === true &&
			!this.#injected &&
			this.getInjectText() !== undefined &&
			appBtwInjectKeys().length > 0
		);
	}

	close(): void {
		this.#closed = true;
	}

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	override describe(): NativeNode {
		const canFollowUp = this.#canFollowUp?.() ?? false;
		const canBranch = this.#canBranch?.() ?? this.isBranchable();
		const canInject = this.#showsInjectKey();
		const memo = this.#native;
		if (memo && memo.canFollowUp === canFollowUp && memo.canBranch === canBranch && memo.canInject === canInject)
			return memo.node;
		// Inline in the dock, styled as a sheet by role: a borderless column headed by the question.
		// The command word is the accent; the rest of the heading is the question or arguments.
		const space = this.#baseTitle.indexOf(" ");
		const command = space === -1 ? this.#baseTitle : this.#baseTitle.slice(0, space);
		const rest = space === -1 ? "" : this.#baseTitle.slice(space);
		const title = text([span(command, "accent"), ...(rest ? [span(rest)] : [])], { truncate: "end", lines: 1 });
		const live = this.#state === "running" || this.#state === "branching";
		const head = node("row", { role: "omp.sheet.head", gap: "sm", align: "center" }, [
			...(live ? [node("spinner", {})] : []),
			title,
		]);
		const described = col([head, this.#describeBody(), this.#describeFooter(canFollowUp, canBranch, canInject)], {
			role: this.nativeRole,
			gap: "sm",
			tone: this.#state === "error" ? "error" : this.#state === "aborted" ? "warning" : undefined,
		});
		this.#native = { node: described, canFollowUp, canBranch, canInject };
		return described;
	}

	#describeBody(): NativeNode {
		if (this.#state === "error") {
			return text([span(sanitizeErrorLine(this.#errorMessage ?? "Unknown error"), "error")], { wrap: "word" });
		}
		const answer = this.#visibleAnswer;
		const parts = this.#injectParts();
		const stream = this.#state === "running";
		if (parts) {
			const before = parts.before.trim();
			const after = parts.after.trim();
			return col(
				[
					...(before ? [md(before, { stream })] : []),
					describeBtwInject(parts.inject, this.#injected),
					...(after ? [md(after, { stream })] : []),
				],
				{ gap: "sm" },
			);
		}
		if (answer) return md(answer, { stream });
		const waiting = this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
		return text([span(waiting, "dim")]);
	}

	#describeFooter(canFollowUp: boolean, canBranch: boolean, canInject: boolean): NativeNode {
		const esc: NativeHint = { keys: boundKeys("app.interrupt", ["escape"]).slice(0, 1), label: "to close" };
		switch (this.#state) {
			case "running":
				return hintsRow([{ ...esc, label: "to cancel" }]);
			case "complete": {
				const hints: NativeHint[] = [];
				if (canInject) hints.push({ keys: appBtwInjectKeys().slice(0, 1), label: "to inject" });
				if (this.isCopyable()) hints.push({ keys: ["c"], label: this.#copied ? "to copy again" : "to copy" });
				if (canFollowUp) hints.push({ keys: ["f"], label: "to follow up" });
				if (canBranch) hints.push({ keys: ["b"], label: "to branch" });
				hints.push(esc);
				if (!this.#copied) return hintsRow(hints);
				return statusHintsRow([span("✓ Copied to clipboard", "success")], hints);
			}
			case "branching":
				return text([span(`${theme.status.pending} Branching to chat…`, "muted")]);
			case "aborted":
				return statusHintsRow([span(`${theme.status.warning} Cancelled`, "warning")], [esc]);
			case "error":
				return statusHintsRow([span(`${theme.status.error} Error`, "error")], [esc]);
		}
	}

	#rebuild(): void {
		this.#native = undefined;
		this.#content.refresh();
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		// The main editor routes `app.interrupt` (Escape by default) to the panel.
		const esc = interruptKey();
		switch (this.#state) {
			case "running":
				return theme.fg("muted", `${esc} to cancel`);
			case "complete": {
				const actions: string[] = [];
				const copyKey = formatKeyHint("c");
				if (this.#showsInjectKey()) actions.push(`${formatKeyHint(appBtwInjectKeys()[0]!)} to inject`);
				if (this.isCopyable()) actions.push(this.#copied ? `${copyKey} to copy again` : `${copyKey} to copy`);
				if (this.#canFollowUp?.()) actions.push(`${formatKeyHint("f")} to follow up`);
				if (this.#canBranch?.() ?? this.isBranchable()) actions.push(`${formatKeyHint("b")} to branch`);
				actions.push(`${esc} to close`);
				if (this.#copied) {
					return `${theme.fg("success", "✓ Copied to clipboard")}${theme.fg("muted", actions.length > 0 ? ` · ${actions.join(" · ")}` : "")}`;
				}
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", `${theme.status.pending} Branching to chat…`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · ${esc} to close`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · ${esc} to close`);
		}
	}

	#contentSections(): Component[] {
		if (this.#state === "error") {
			return [new Text(theme.fg("error", sanitizeErrorLine(this.#errorMessage ?? "Unknown error")), 0, 0)];
		}
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return [new Text(theme.fg("dim", waiting), 0, 0)];
		}
		const parts = this.#injectParts();
		if (!parts) return [new Markdown(text, 0, 0, getMarkdownTheme())];
		// Separate sections: one blank row sets the block apart from the prose around it.
		const before = parts.before.trim();
		const after = parts.after.trim();
		return [
			...(before ? [new Markdown(before, 0, 0, getMarkdownTheme())] : []),
			new BtwInjectBlock(parts.inject, this.#injected),
			...(after ? [new Markdown(after, 0, 0, getMarkdownTheme())] : []),
		];
	}
}
