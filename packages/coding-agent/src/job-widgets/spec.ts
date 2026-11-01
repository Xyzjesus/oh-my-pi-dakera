/**
 * The declarative widget spec a cheap model writes once per job: rules that
 * pull numbers and words out of the job's output lines, and the blocks that
 * draw them. Validation here is what lets a spec drive a widget unattended:
 * every regex compiles, every field a block reads is fed by a rule, and the
 * rules match the samples the author saw.
 */
import { type } from "@oh-my-pi/omptype";
import { LineMatcher } from "@oh-my-pi/pi-natives";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { isRecord, truncate } from "@oh-my-pi/pi-utils";
import { TOOL_CALL_MARK, TOOLS_SOURCE_ID } from "./types";

/** How a field's values reduce to one number. */
export type JobWidgetAgg = "last" | "first" | "min" | "max" | "mean" | "sum" | "count" | "rate" | "delta" | "change";

export const JOB_WIDGET_AGGS: readonly JobWidgetAgg[] = [
	"last",
	"first",
	"min",
	"max",
	"mean",
	"sum",
	"count",
	"rate",
	"delta",
	"change",
];

export const JOB_WIDGET_TONES: readonly TspTone[] = [
	"neutral",
	"accent",
	"info",
	"success",
	"warning",
	"error",
	"pending",
	"muted",
	"user",
];

/**
 * One line-matching rule. Every named group but `key` feeds the field of the
 * same name (`/^[a-z][a-z0-9_]{0,23}$/`) with its capture: a number, or text
 * for the `text` group (and for a capture that holds no number). Several
 * rules may feed one field.
 */
export interface JobWidgetRule {
	/**
	 * Source id (`out`, `pipe:1`, `tools`, `bg_7:pipe:1`), `*` for all, a trailing `*` for a prefix
	 * (`pipe:*`). Wildcards never cover `tools`; see {@link ruleReadsSource}.
	 */
	from: string;
	/** Rust-regex syntax with named groups, matched per line. */
	match: string;
	/** Group splitting every field of the rule into one series per key; not a field itself. */
	key?: string;
	/** Group whose capture is kept as text (the key's latest text), not parsed as a number. */
	text?: string;
	/** Field counting the rule's matches. */
	count?: string;
	/** Multiplies every number the rule captures. */
	scale?: number;
}

/** A field one rule feeds; see {@link ruleFields}. */
export interface JobWidgetRuleField {
	field: string;
	/** The capture is kept as text, never parsed as a number. */
	text: boolean;
	/** The rule's `count`: fed by the match itself, not a capture. */
	count: boolean;
}

export type JobWidgetBetter = "higher" | "lower";

/** A number derived from one field. */
export interface JobWidgetValueRef {
	field: string;
	key?: string;
	agg: JobWidgetAgg;
	unit?: string;
	digits?: number;
	better?: JobWidgetBetter;
}

export interface JobWidgetSparkSpec {
	kind: "spark";
	field: string;
	key?: string;
	label: string;
	unit?: string;
	better?: JobWidgetBetter;
	target?: number;
	targetLabel?: string;
	min?: number;
	max?: number;
}

export interface JobWidgetBarsSpec {
	kind: "bars";
	field: string;
	agg: JobWidgetAgg;
	label: string;
	unit?: string;
	max?: number;
	better?: JobWidgetBetter;
}

export interface JobWidgetMeterSpec {
	kind: "meter";
	field: string;
	agg: JobWidgetAgg;
	key?: string;
	total: number | JobWidgetValueRef;
	label: string;
	unit?: string;
}

export interface JobWidgetStatSpec {
	kind: "stat";
	items: (JobWidgetValueRef & { label: string })[];
}

export interface JobWidgetGridSpec {
	kind: "grid";
	field: string;
	label: string;
	/** Tone by the key's latest text: case-insensitive substring, first listed wins. */
	tones: Record<string, TspTone>;
}

export interface JobWidgetTextSpec {
	kind: "text";
	field: string;
}

export type JobWidgetBlockSpec =
	| JobWidgetSparkSpec
	| JobWidgetBarsSpec
	| JobWidgetMeterSpec
	| JobWidgetStatSpec
	| JobWidgetGridSpec
	| JobWidgetTextSpec;

export interface JobWidgetSpec {
	/** What is watched, ≤ 48 chars. */
	title: string;
	/** 1–12. */
	rules: JobWidgetRule[];
	/** 1–4; the first is the primary block compact views show. */
	blocks: JobWidgetBlockSpec[];
	headline?: JobWidgetValueRef & { label?: string };
	/** Field whose latest captured text is the stage line. */
	stage?: string;
}

export const MAX_TITLE_CHARS = 48;
export const MAX_RULES = 12;
export const MAX_BLOCKS = 4;
export const MAX_STAT_ITEMS = 4;
const MAX_PATTERN_CHARS = 400;
const MAX_LABEL_CHARS = 48;
const MAX_UNIT_CHARS = 12;
const MAX_GRID_TONES = 12;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,23}$/;
const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const SOURCE_ID = /^(?:\*|[A-Za-z0-9_:.-]{1,64}\*?)$/;
/** Named groups in both Rust spellings: `(?P<name>…)` and `(?<name>…)`. */
const NAMED_GROUP = /\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g;

const Agg = type.enumerated(...JOB_WIDGET_AGGS);
const Better = type.enumerated("higher", "lower");
const ValueRefShape = type({
	field: "string",
	agg: Agg,
	"label?": "string",
	"key?": "string <= 120",
	"unit?": "string",
	"digits?": "0 <= number.integer <= 4",
	"better?": Better,
});
const RuleShape = type({
	from: "string",
	match: `string <= ${MAX_PATTERN_CHARS}`,
	"key?": "string",
	"text?": "string",
	"count?": "string",
	"scale?": "number",
});
const BlockShape = type({
	kind: type.enumerated("spark", "bars", "meter", "stat", "grid", "text"),
	"field?": "string",
	"label?": "string",
	"key?": "string <= 120",
	"agg?": Agg,
	"unit?": "string",
	"better?": Better,
	"target?": "number",
	"targetLabel?": "string",
	"min?": "number",
	"max?": "number",
	// A string total (`"?"`, `"42"`) is read leniently; see `parseBlock`.
	"total?": type("number").or(ValueRefShape).or("string"),
	"items?": ValueRefShape.array().atLeastLength(1).atMostLength(MAX_STAT_ITEMS),
	"tones?": type({ "[string]": type.enumerated(...JOB_WIDGET_TONES) }),
});
const SpecShape = type({
	"skip?": "string",
	"title?": "string",
	"rules?": RuleShape.array().atLeastLength(1).atMostLength(MAX_RULES),
	"blocks?": BlockShape.array().atLeastLength(1).atMostLength(MAX_BLOCKS),
	"headline?": ValueRefShape,
	"stage?": "string",
});
type ValueRefShape = typeof ValueRefShape.infer;
type RuleShape = typeof RuleShape.infer;
type BlockShape = typeof BlockShape.infer;

/**
 * JSON schema of {@link JobWidgetSpec}, carried by the forced `respond` tool
 * the author model calls. Deliberately bare (shapes and enums, no prose): the
 * system prompt documents every property, and the schema is billed as input
 * on every request. Semantic checks live in {@link validateJobWidgetSpec}.
 * Nothing is required at the top: a `skip` answer declines to draw a widget
 * ({@link jobWidgetSkip}); every other answer must carry `title`, `rules`
 * and `blocks`, which validation enforces.
 */
export const JOB_WIDGET_SPEC_SCHEMA: Record<string, unknown> = SpecShape.toJsonSchema();

/** Lines the author saw for one source, for the validation dry run. */
export interface JobWidgetSampleLines {
	id: string;
	lines: readonly string[];
}

export type JobWidgetSpecValidation = { ok: true; spec: JobWidgetSpec } | { ok: false; errors: string[] };

/**
 * Why an authored answer declines to draw a widget (its `skip`), or
 * `undefined` for an answer offering a spec: nothing in the job's output is
 * a quantity worth watching.
 */
export function jobWidgetSkip(value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.skip !== "string") return undefined;
	const reason = value.skip.trim();
	return reason.length > 0 ? reason : undefined;
}

/**
 * Whether a rule's `from` names the source `id`. A subagent's `tools` (file
 * contents, search hits and command output mixed) is read only by a rule
 * naming it: a wildcard written for a command's output must not reach it.
 */
export function ruleReadsSource(from: string, id: string): boolean {
	if (id === TOOLS_SOURCE_ID) return from === TOOLS_SOURCE_ID;
	if (from === "*") return true;
	if (from.endsWith("*")) return id.startsWith(from.slice(0, -1));
	return from === id;
}

/** Named groups a Rust pattern declares, in pattern order. */
export function patternGroupNames(pattern: string): Set<string> {
	const names = new Set<string>();
	for (const match of pattern.matchAll(NAMED_GROUP)) names.add(match[1]);
	return names;
}

/** The fields a rule feeds: one per named group but `key`, then its `count`. */
export function ruleFields(rule: JobWidgetRule): JobWidgetRuleField[] {
	const fields: JobWidgetRuleField[] = [];
	for (const group of patternGroupNames(rule.match)) {
		if (group !== rule.key) fields.push({ field: group, text: group === rule.text, count: false });
	}
	if (rule.count !== undefined) fields.push({ field: rule.count, text: false, count: true });
	return fields;
}

/** Whether an aggregation needs numbers (everything but match counting). */
export function aggNeedsValue(agg: JobWidgetAgg): boolean {
	// `count` and `rate` read matches, not values: a text or `count` field can feed them.
	return agg !== "count" && agg !== "rate";
}

const NUMBER_PREFIX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const SUFFIX_SCALE: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/**
 * A captured number: `,`/`_` separators dropped, a `k`/`K`/`M`/`G` suffix
 * right after the digits multiplies; `NaN` when the text starts with no number.
 */
export function parseWidgetValue(text: string): number {
	// Hot path: a plain decimal (`41.3`, `412000`) needs none of the cleanup. `Number` would also
	// read `0x1f` and `0b1` as hex and binary, so a second character that could start a radix prefix
	// takes the slow path.
	const first = text.charCodeAt(0);
	if (first >= 48 && first <= 57 && !/[xXbBoO]/.test(text.charAt(1))) {
		const plain = Number(text);
		if (Number.isFinite(plain)) return plain;
	}
	const compact = text.trim().replace(/[,_]/g, "");
	const match = NUMBER_PREFIX.exec(compact);
	if (!match) return Number.NaN;
	const value = Number.parseFloat(match[0]);
	return value * (SUFFIX_SCALE[compact.charAt(match[0].length)] ?? 1);
}

/**
 * Parse and check an authored spec. `samples` (the lines the author saw)
 * enable the dry run, which rejects:
 * - rules matching none of the non-empty samples (an empty widget);
 * - a field read as a number whose sample captures hold none;
 * - rules reading omp's {@link TOOL_CALL_MARK} lines of a subagent's tool
 *   calls (counting or naming tool calls is activity, not progress).
 *
 * With `brief` (the job's command, task and hints) as well, a constant meter
 * `total` or spark `target` must be a number the brief or the samples state:
 * an invented total draws a made-up fraction. A meter may use 100 without a
 * stated denominator when every numeric feeding rule supplies an observed,
 * unscaled percentage.
 */
export function validateJobWidgetSpec(
	value: unknown,
	samples?: readonly JobWidgetSampleLines[],
	brief?: string,
): JobWidgetSpecValidation {
	const errors: string[] = [];
	const spec = parseSpec(value, errors);
	if (!spec) return { ok: false, errors };
	const numeric = checkReferences(spec, errors);
	let matcher: LineMatcher | undefined;
	try {
		matcher = new LineMatcher(spec.rules.map(rule => rule.match));
	} catch (error) {
		errors.push(`rules: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (matcher && samples && errors.length === 0) {
		const percentages = dryRun(spec, matcher, samples, numeric, errors);
		if (brief !== undefined) checkStatedNumbers(spec, samples, brief, percentages, errors);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, spec };
}

/** A number as text writes it: digits with separators, a fraction, a `k`/`M`/`G` suffix. */
const WRITTEN_NUMBER = /\d[\d,_]*(?:\.\d+)?[kKMG]?/g;
/** Aggregations that retain the captured percentage's scale and meaning. */
const PERCENT_AGGS = new Set<JobWidgetAgg>(["last", "first", "min", "max", "mean"]);

/** Rejects constant totals and targets that neither `brief` nor the samples state; see {@link validateJobWidgetSpec}. */
function checkStatedNumbers(
	spec: JobWidgetSpec,
	samples: readonly JobWidgetSampleLines[],
	brief: string,
	percentages: ReadonlyMap<string, boolean>,
	errors: string[],
): void {
	const stated = new Set<number>();
	const collect = (text: string): void => {
		for (const match of text.matchAll(WRITTEN_NUMBER)) stated.add(parseWidgetValue(match[0]));
	};
	collect(brief);
	for (const sample of samples) for (const line of sample.lines) collect(line);
	spec.blocks.forEach((block, index) => {
		const where = `blocks[${index}] (${block.kind})`;
		if (
			block.kind === "meter" &&
			typeof block.total === "number" &&
			!stated.has(block.total) &&
			!(block.total === 100 && percentages.get(block.field) === true && PERCENT_AGGS.has(block.agg))
		) {
			errors.push(
				`${where}.total: ${block.total} appears nowhere in the job or its output; read the total from a line (a value ref) or show the value as a stat`,
			);
		} else if (block.kind === "spark" && block.target !== undefined && !stated.has(block.target)) {
			errors.push(
				`${where}.target: ${block.target} appears nowhere in the job or its output; set a target only when the job states one`,
			);
		}
	});
}

/** Whether the captured number itself, not another number on the line, carries `%`. */
function isPercentCapture(captured: string, line: string, end: number): boolean {
	const compact = captured.trim().replace(/[,_]/g, "");
	const number = NUMBER_PREFIX.exec(compact);
	if (!number) return false;
	const suffix = compact.slice(number[0].length).trim();
	return suffix === "%" || (suffix === "" && /^\s*%/.test(line.slice(end)));
}

/** Runs the rules over the samples, requiring percentage evidence from every numeric feeding rule. */
function dryRun(
	spec: JobWidgetSpec,
	matcher: LineMatcher,
	samples: readonly JobWidgetSampleLines[],
	numeric: ReadonlyMap<string, string>,
	errors: string[],
): Map<string, boolean> {
	const groups = matcher.groupNames();
	let seen = false;
	let matches = 0;
	/** Rules that matched a `» <tool> <intent>` marker line. */
	const marked = new Set<number>();
	const numbers = new Set<string>();
	const percentages = new Map<string, boolean>();
	/** Numeric feeds still missing an unscaled percentage capture. */
	const unprovenPercentages = new Map<string, Set<number>>();
	spec.rules.forEach((rule, index) => {
		for (const { field, text, count } of ruleFields(rule)) {
			if (text) continue;
			// A match count is never a percentage, whether or not the samples hit it.
			if (count) {
				percentages.set(field, false);
				continue;
			}
			const feeds = unprovenPercentages.get(field) ?? new Set<number>();
			feeds.add(index);
			unprovenPercentages.set(field, feeds);
		}
	});
	/** Field → its first capture that held no number. */
	const words = new Map<string, string>();
	for (const sample of samples) {
		if (!sample.lines.some(line => line.trim().length > 0)) continue;
		seen = true;
		const hits = matcher.matchLines(sample.lines.join("\n"));
		let offset = 0;
		for (let hit = 0; hit < hits.rules.length; hit++) {
			const index = hits.rules[hit];
			const rule = spec.rules[index];
			const names = groups[index];
			const line = sample.lines[hits.lines[hit]];
			if (ruleReadsSource(rule.from, sample.id)) {
				matches += 1;
				if (sample.id === TOOLS_SOURCE_ID && line.startsWith(TOOL_CALL_MARK)) marked.add(index);
				names.forEach((field, position) => {
					const at = offset + position * 2;
					if (field === rule.key || field === rule.text || hits.spans[at] < 0) return;
					const captured = line.slice(hits.spans[at], hits.spans[at + 1]);
					if (Number.isFinite(parseWidgetValue(captured))) {
						numbers.add(field);
						const percentage = (rule.scale ?? 1) === 1 && isPercentCapture(captured, line, hits.spans[at + 1]);
						percentages.set(field, percentages.get(field) !== false && percentage);
						if (percentage) unprovenPercentages.get(field)?.delete(index);
					} else if (!words.has(field)) words.set(field, captured);
				});
			}
			offset += names.length * 2;
		}
	}
	for (const [field, feeds] of unprovenPercentages) {
		if (feeds.size > 0) percentages.set(field, false);
	}
	if (seen && matches === 0) {
		const wildcardMissesTools =
			samples.some(sample => sample.id === TOOLS_SOURCE_ID) && spec.rules.some(rule => rule.from.endsWith("*"));
		errors.push(
			`no rule matches any sample line; copy the exact text of lines that carry the numbers${wildcardMissesTools ? ` (a wildcard \`from\` never reads \`${TOOLS_SOURCE_ID}\`: name it)` : ""}`,
		);
	}
	for (const index of marked) {
		errors.push(
			`rules[${index}]: matches \`${TOOL_CALL_MARK}<tool> <intent>\` lines, which are omp's markers of the subagent's tool calls, not its output; match the literal text of the result lines that report progress, or skip if none do`,
		);
	}
	for (const [field, where] of numeric) {
		const word = words.get(field);
		if (word === undefined || numbers.has(field)) continue;
		errors.push(
			`${where}: field "${field}" needs numbers, but its group captured "${truncate(word, 40)}" in the samples; capture only the digits`,
		);
	}
	return percentages;
}

/** How rules feed a field: whether any feed is a number or keeps text, and the groups splitting it by key. */
interface FieldFeed {
	value: boolean;
	text: boolean;
	keyGroups: Set<string>;
}

function fieldFeeds(spec: JobWidgetSpec): Map<string, FieldFeed> {
	const fields = new Map<string, FieldFeed>();
	for (const rule of spec.rules) {
		for (const { field, text, count } of ruleFields(rule)) {
			const feed = fields.get(field) ?? { value: false, text: false, keyGroups: new Set<string>() };
			feed.value ||= !text && !count;
			feed.text ||= text;
			if (rule.key !== undefined) feed.keyGroups.add(rule.key);
			fields.set(field, feed);
		}
	}
	return fields;
}

/** Checks rules and references; returns the fields read as numbers, each with the first place reading it. */
function checkReferences(spec: JobWidgetSpec, errors: string[]): Map<string, string> {
	const feeds = fieldFeeds(spec);
	const numeric = new Map<string, string>();
	const checkField = (where: string, field: string, agg: JobWidgetAgg | undefined, key?: string): void => {
		const feed = feeds.get(field);
		if (!feed) {
			errors.push(`${where}: unknown field "${field}"; no rule has a group (?P<${field}>…) or count "${field}"`);
			return;
		}
		if (key !== undefined && feed.keyGroups.has(key)) {
			errors.push(
				`${where}.key: "${key}" is the name of the key group; set one of its values (one model, one job) or omit \`key\``,
			);
		}
		if (agg === undefined || !aggNeedsValue(agg)) return;
		if (!feed.value) {
			errors.push(`${where}: agg "${agg}" needs numbers, but field "${field}" only counts matches or keeps text`);
		} else if (!numeric.has(field)) {
			numeric.set(field, where);
		}
	};
	const checkRef = (where: string, ref: JobWidgetValueRef): void => checkField(where, ref.field, ref.agg, ref.key);
	spec.rules.forEach((rule, index) => {
		const where = `rules[${index}]`;
		const groups = patternGroupNames(rule.match);
		if (rule.text !== undefined && rule.text === rule.key) errors.push(`${where}.text: the key group is not a field`);
		for (const group of groups) {
			if (group !== rule.key && !FIELD_NAME.test(group)) {
				errors.push(`${where}.match: group "${group}" names a field, so it must match ${FIELD_NAME.source}`);
			}
		}
		if (ruleFields(rule).length === 0) {
			errors.push(`${where}: feeds no field; name a group (?P<field>…) besides the key, or set \`count\``);
		}
	});
	if (spec.headline) checkRef("headline", spec.headline);
	if (spec.stage) checkField("stage", spec.stage, undefined);
	spec.blocks.forEach((block, index) => {
		const where = `blocks[${index}] (${block.kind})`;
		switch (block.kind) {
			case "spark":
				checkField(where, block.field, "last", block.key);
				break;
			case "bars":
				checkField(where, block.field, block.agg);
				if (feeds.get(block.field)?.keyGroups.size === 0) errors.push(`${where}: bars need a rule with \`key\``);
				break;
			case "meter":
				checkField(where, block.field, block.agg, block.key);
				if (typeof block.total !== "number") checkRef(`${where}.total`, block.total);
				break;
			case "stat":
				block.items.forEach((item, itemIndex) => checkRef(`${where}.items[${itemIndex}]`, item));
				break;
			case "grid":
				checkField(where, block.field, undefined);
				if (feeds.get(block.field)?.keyGroups.size === 0) errors.push(`${where}: grid needs a rule with \`key\``);
				break;
			case "text":
				checkField(where, block.field, undefined);
				break;
		}
	});
	return numeric;
}

// ── Structural parsing ──────────────────────────────────────────────────────

/** Authors send `null` for an omitted optional; it reads as absent, as does an explicit `undefined`. */
function withoutNulls(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutNulls);
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const key in value) {
		if (value[key] != null) out[key] = withoutNulls(value[key]);
	}
	return out;
}

function parseSpec(value: unknown, errors: string[]): JobWidgetSpec | undefined {
	const shape = SpecShape(withoutNulls(value));
	if (shape instanceof type.errors) {
		for (const issue of shape) errors.push(issue.path.length > 0 ? issue.message : `spec ${issue.message}`);
		return undefined;
	}
	const title = text(shape.title, "title", errors, { cut: MAX_TITLE_CHARS, required: true });
	if (!shape.rules) errors.push("rules: required");
	if (!shape.blocks) errors.push("blocks: required");
	const rules = shape.rules?.map((rule, index) => parseRule(rule, `rules[${index}]`, errors));
	const blocks = shape.blocks?.map((block, index) => parseBlock(block, `blocks[${index}]`, errors));
	let headline: JobWidgetSpec["headline"];
	if (shape.headline) {
		const ref = parseValueRef(shape.headline, "headline", errors);
		const label = text(shape.headline.label, "headline.label", errors, { cut: MAX_LABEL_CHARS });
		if (ref) headline = label ? { ...ref, label } : ref;
	}
	const stage = shape.stage === undefined ? undefined : fieldName(shape.stage, "stage", errors);
	if (errors.length > 0 || title === undefined || !rules || !blocks) return undefined;
	if (rules.some(rule => !rule) || blocks.some(block => !block)) return undefined;
	return {
		title,
		rules: rules as JobWidgetRule[],
		blocks: blocks as JobWidgetBlockSpec[],
		...(headline ? { headline } : {}),
		...(stage ? { stage } : {}),
	};
}

function parseRule(rule: RuleShape, where: string, errors: string[]): JobWidgetRule | undefined {
	const from = text(rule.from, `${where}.from`, errors, { required: true });
	if (from !== undefined && !SOURCE_ID.test(from)) errors.push(`${where}.from: invalid source id "${from}"`);
	const match = text(rule.match, `${where}.match`, errors, { required: true });
	const group = (name: "key" | "text"): string | undefined => {
		const raw = text(rule[name], `${where}.${name}`, errors);
		if (raw !== undefined && !GROUP_NAME.test(raw)) errors.push(`${where}.${name}: invalid group name "${raw}"`);
		return raw;
	};
	const key = group("key");
	const textName = group("text");
	const count = rule.count === undefined ? undefined : fieldName(rule.count, `${where}.count`, errors);
	if (from === undefined || match === undefined) return undefined;
	// `key` and `text` name groups of the pattern; authors often name ones it lacks. A `text` on
	// a pattern with no groups at all means the matched text itself (`^(?:Installing|Building)`):
	// the pattern is wrapped in that group, which keeps what it matches and captures it whole.
	// Otherwise the role is dropped: a block reading the missing field (or needing keys) still
	// fails validation and goes back to the author, and a spec that never reads it stays usable.
	const groups = patternGroupNames(match);
	const wrap = textName !== undefined && FIELD_NAME.test(textName) && groups.size === 0;
	const keyGroup = key !== undefined && groups.has(key) ? key : undefined;
	const textGroup = textName !== undefined && (wrap || groups.has(textName)) ? textName : undefined;
	return {
		from,
		match: wrap ? `(?P<${textName}>${match})` : match,
		...(keyGroup !== undefined ? { key: keyGroup } : {}),
		...(textGroup !== undefined ? { text: textGroup } : {}),
		...(count !== undefined ? { count } : {}),
		...(rule.scale !== undefined ? { scale: rule.scale } : {}),
	};
}

/** The value-ref fields of a ref, or of a meter block read as one. */
type ValueRefInput = Pick<ValueRefShape, "key" | "unit" | "digits" | "better"> & { field?: string; agg?: JobWidgetAgg };

function parseValueRef(ref: ValueRefInput, where: string, errors: string[]): JobWidgetValueRef | undefined {
	const field = fieldName(ref.field, `${where}.field`, errors);
	const agg = requiredAgg(ref.agg, `${where}.agg`, errors);
	const key = text(ref.key, `${where}.key`, errors);
	const unit = text(ref.unit, `${where}.unit`, errors, { cut: MAX_UNIT_CHARS });
	if (field === undefined || agg === undefined) return undefined;
	return {
		field,
		agg,
		...(key !== undefined ? { key } : {}),
		...(unit !== undefined ? { unit } : {}),
		...(ref.digits !== undefined ? { digits: ref.digits } : {}),
		...(ref.better !== undefined ? { better: ref.better } : {}),
	};
}

function parseBlock(block: BlockShape, where: string, errors: string[]): JobWidgetBlockSpec | undefined {
	const before = errors.length;
	const label = (): string =>
		text(block.label, `${where}.label`, errors, { cut: MAX_LABEL_CHARS, required: true }) ?? "";
	const unit = (): string | undefined => text(block.unit, `${where}.unit`, errors, { cut: MAX_UNIT_CHARS });
	const field = (): string => fieldName(block.field, `${where}.field`, errors) ?? "";
	const key = (): string | undefined => text(block.key, `${where}.key`, errors);
	const optional = <T>(entry: T | undefined, name: string): Record<string, T> =>
		entry === undefined ? {} : { [name]: entry };
	let result: JobWidgetBlockSpec | undefined;
	switch (block.kind) {
		case "spark":
			result = {
				kind: "spark",
				field: field(),
				label: label(),
				...optional(key(), "key"),
				...optional(unit(), "unit"),
				...optional(block.better, "better"),
				...optional(block.target, "target"),
				...optional(
					text(block.targetLabel, `${where}.targetLabel`, errors, { cut: MAX_LABEL_CHARS }),
					"targetLabel",
				),
				...optional(block.min, "min"),
				...optional(block.max, "max"),
			};
			break;
		case "bars":
			result = {
				kind: "bars",
				field: field(),
				agg: requiredAgg(block.agg, `${where}.agg`, errors) ?? "last",
				label: label(),
				...optional(unit(), "unit"),
				...optional(block.max, "max"),
				...optional(block.better, "better"),
			};
			break;
		case "meter": {
			const whole = typeof block.total === "string" ? Number(block.total) : block.total;
			// A meter whose whole is unknown (absent, `"?"`, `null`) is a plain number: drawn as a
			// stat rather than sent back for a retry.
			if (whole === undefined || (typeof whole === "number" && Number.isNaN(whole))) {
				const ref = parseValueRef(block, where, errors);
				result = ref && { kind: "stat", items: [{ ...ref, label: label() }] };
				break;
			}
			let total: number | JobWidgetValueRef | undefined;
			if (typeof whole === "number") {
				if (!Number.isFinite(whole) || whole <= 0) errors.push(`${where}.total: expected a positive number`);
				else total = whole;
			} else {
				total = parseValueRef(whole, `${where}.total`, errors);
			}
			result = {
				kind: "meter",
				field: field(),
				agg: requiredAgg(block.agg, `${where}.agg`, errors) ?? "last",
				total: total ?? 1,
				label: label(),
				...optional(key(), "key"),
				...optional(unit(), "unit"),
			};
			break;
		}
		case "stat": {
			if (!block.items) errors.push(`${where}.items: required`);
			const items = (block.items ?? []).map((item, index) => {
				const itemWhere = `${where}.items[${index}]`;
				const ref = parseValueRef(item, itemWhere, errors);
				const itemLabel = text(item.label, `${itemWhere}.label`, errors, { cut: MAX_LABEL_CHARS, required: true });
				return ref && itemLabel !== undefined ? { ...ref, label: itemLabel } : undefined;
			});
			result = { kind: "stat", items: items.filter(item => item !== undefined) };
			break;
		}
		case "grid": {
			const tones: Record<string, TspTone> = {};
			if (!block.tones) errors.push(`${where}.tones: expected an object of status substring → tone`);
			else {
				const statuses = Object.keys(block.tones);
				if (statuses.length > MAX_GRID_TONES) errors.push(`${where}.tones: at most ${MAX_GRID_TONES} entries`);
				for (const status of statuses.slice(0, MAX_GRID_TONES)) {
					// An empty status would match every cell, colouring any text as a status.
					if (status.trim().length === 0) {
						errors.push(`${where}.tones: an empty status matches every cell; name the status word`);
					} else {
						tones[status] = block.tones[status];
					}
				}
			}
			result = { kind: "grid", field: field(), label: label(), tones };
			break;
		}
		case "text":
			result = { kind: "text", field: field() };
			break;
	}
	return errors.length === before ? result : undefined;
}

/** Trimmed text; blank reads as absent. Display text (`cut`) is shortened to fit rather than sent back for a retry. */
function text(
	value: string | undefined,
	where: string,
	errors: string[],
	options: { cut?: number; required?: boolean } = {},
): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		if (options.required) errors.push(`${where}: ${value === undefined ? "required" : "must not be empty"}`);
		return undefined;
	}
	return options.cut === undefined ? trimmed : truncate(trimmed, options.cut);
}

function fieldName(value: string | undefined, where: string, errors: string[]): string | undefined {
	const name = text(value, where, errors, { required: true });
	if (name !== undefined && !FIELD_NAME.test(name)) {
		errors.push(`${where}: "${name}" must match ${FIELD_NAME.source}`);
		return undefined;
	}
	return name;
}

function requiredAgg(value: JobWidgetAgg | undefined, where: string, errors: string[]): JobWidgetAgg | undefined {
	if (value === undefined) errors.push(`${where}: expected one of ${JOB_WIDGET_AGGS.join(", ")}`);
	return value;
}
