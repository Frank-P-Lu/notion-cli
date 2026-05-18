import type { Command } from "commander";
import { withConnection } from "../mcp/with-connection.js";
import { printOutput } from "../output/json.js";
import { CliError, parseJsonData } from "../util/errors.js";
import { parseProps } from "../util/props.js";
import { readStdin } from "../util/stdin.js";
import { buildFetchCall } from "./fetch.js";

interface PageWriteOptions {
	title?: string;
	parent?: string;
	props?: string[];
	body?: string;
	data?: string;
}

function stripDataSourcePrefix(id: string): string {
	return id.replace(/^collection:\/\//, "");
}

export function parseParentRef(id: string): Record<string, string> {
	if (id.startsWith("collection://")) {
		return { data_source_id: stripDataSourcePrefix(id), type: "data_source_id" };
	}
	if (id === "workspace") {
		return { type: "workspace" };
	}
	return { page_id: id, type: "page_id" };
}

export function buildPageCreateCall(opts: PageWriteOptions): {
	tool: string;
	args: Record<string, unknown>;
} {
	if (opts.data) {
		return { tool: "notion-create-pages", args: parseJsonData(opts.data) };
	}
	const page: Record<string, unknown> = {};
	const properties: Record<string, unknown> = {};
	if (opts.title) properties.title = opts.title;
	if (opts.props?.length) Object.assign(properties, parseProps(opts.props));
	if (Object.keys(properties).length > 0) page.properties = properties;
	if (opts.body) page.content = opts.body;

	const args: Record<string, unknown> = { pages: [page] };
	if (opts.parent) {
		if (opts.parent === "workspace") {
			throw new CliError(
				'"workspace" is not a valid parent for page create',
				"notion-create-pages only accepts page_id or data_source_id as parent",
				"Use a page ID or collection://<ds-id> as --parent",
			);
		}
		args.parent = parseParentRef(opts.parent);
	}
	return { tool: "notion-create-pages", args };
}

export function buildPageUpdateCall(
	id: string,
	opts: Omit<PageWriteOptions, "parent">,
): {
	tool: string;
	args: Record<string, unknown>;
} {
	if (opts.data) {
		return { tool: "notion-update-page", args: parseJsonData(opts.data) };
	}

	const hasProps = !!(opts.title || opts.props?.length);
	const hasBody = !!opts.body;
	if (hasProps && hasBody) {
		throw new CliError(
			"Cannot use --body with --prop/--title in the same command",
			"Property update and content replacement are separate MCP operations",
			'Run two commands: "ncli page update <id> --prop ..." then "ncli page update <id> --body ..."',
		);
	}

	const args: Record<string, unknown> = { page_id: id };
	if (opts.title) {
		args.command = "update_properties";
		args.properties = {
			title: opts.title,
			...((opts.props?.length && parseProps(opts.props)) || {}),
		};
	} else if (opts.props?.length) {
		args.command = "update_properties";
		args.properties = parseProps(opts.props);
	}
	if (hasBody) {
		args.command = "replace_content";
		args.new_str = opts.body;
	}
	return { tool: "notion-update-page", args };
}

export function buildPageMoveCall(
	ids: string[],
	to: string,
): {
	tool: string;
	args: Record<string, unknown>;
} {
	return {
		tool: "notion-move-pages",
		args: {
			page_or_database_ids: ids,
			new_parent: parseParentRef(to),
		},
	};
}

export function buildPageDuplicateCall(id: string): {
	tool: string;
	args: Record<string, unknown>;
} {
	return { tool: "notion-duplicate-page", args: { page_id: id } };
}

interface FetchResult {
	content?: Array<{ type: string; text: string }>;
}

interface ParsedPageBody {
	blank: boolean;
	markdown: string;
}

const CONTENT_OPEN = "<content>\n";
const CONTENT_CLOSE = "\n</content>";
const BLANK_MARKER = "<blank-page>";

export function extractPageBody(result: FetchResult): ParsedPageBody {
	const text = result.content?.[0]?.text;
	if (typeof text !== "string") {
		throw new CliError(
			"Could not read page body",
			"notion-fetch response did not contain a text payload",
			"Try `ncli fetch <id> --raw` to inspect the response",
		);
	}
	let inner: string;
	try {
		const parsed = JSON.parse(text) as { text?: unknown };
		if (typeof parsed.text !== "string") throw new Error("missing text field");
		inner = parsed.text;
	} catch {
		throw new CliError(
			"Could not parse page body",
			"notion-fetch payload was not the expected JSON shape",
			"Try `ncli fetch <id> --raw` to inspect the response",
		);
	}
	if (inner.includes(BLANK_MARKER)) {
		return { blank: true, markdown: "" };
	}
	const openIdx = inner.indexOf(CONTENT_OPEN);
	const closeIdx = inner.lastIndexOf(CONTENT_CLOSE);
	if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
		throw new CliError(
			"Could not locate page content",
			"notion-fetch response had no <content> or <blank-page> section",
			"The target may not be a regular page — try `ncli fetch <id>` to inspect",
		);
	}
	return { blank: false, markdown: inner.slice(openIdx + CONTENT_OPEN.length, closeIdx) };
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + 1);
	}
	return count;
}

function isTransientLine(line: string): boolean {
	// Notion regenerates presigned URLs in image markdown (![](https://...)) on every
	// fetch, so anchoring on such a line never matches server-side. Skip them.
	return /^!\[[^\]]*]\(/.test(line.trim());
}

export function findAppendAnchor(markdown: string): string {
	const lines = markdown.split("\n");
	let lastStable = lines.length - 1;
	while (
		lastStable >= 0 &&
		(lines[lastStable].trim() === "" || isTransientLine(lines[lastStable]))
	) {
		lastStable--;
	}
	if (lastStable < 0) {
		throw new CliError(
			"Could not find a stable anchor",
			"Every trailing line is an image with a presigned URL that changes per fetch",
			"Add a plain-text line near the bottom of the page, then retry",
		);
	}
	let anchor = lines[lastStable];
	for (let i = lastStable - 1; i >= 0; i--) {
		if (countOccurrences(markdown, anchor) === 1) return anchor;
		anchor = `${lines[i]}\n${anchor}`;
	}
	return anchor;
}

export function buildPageAppendCall(
	id: string,
	parsed: ParsedPageBody,
	opts: { body?: string; data?: string },
): {
	tool: string;
	args: Record<string, unknown>;
} {
	if (opts.data) {
		return { tool: "notion-update-page", args: parseJsonData(opts.data) };
	}
	if (!opts.body || opts.body.trim() === "") {
		throw new CliError(
			"No content to append",
			"--body or --data is required",
			'Provide content: ncli page append <id> --body "# New section"',
		);
	}
	if (parsed.blank) {
		return {
			tool: "notion-update-page",
			args: { page_id: id, command: "replace_content", new_str: opts.body },
		};
	}
	const anchor = findAppendAnchor(parsed.markdown);
	return {
		tool: "notion-update-page",
		args: {
			page_id: id,
			command: "update_content",
			content_updates: [{ old_str: anchor, new_str: `${anchor}\n\n${opts.body}` }],
		},
	};
}

async function resolveBody(body: string | undefined): Promise<string | undefined> {
	if (body === "-") {
		return readStdin();
	}
	return body;
}

export function registerPageCommands(program: Command): void {
	const page = program.command("page").description("Create, update, move, or duplicate pages");

	page
		.command("create")
		.description("Create a page (--title, --parent, --prop Key=Value, --body)")
		.option("--title <title>", "Page title")
		.option("--parent <id>", "Parent page or database ID")
		.option(
			"--prop <key=value>",
			"Set property (repeatable)",
			(v: string, a: string[]) => [...a, v],
			[] as string[],
		)
		.option("--body <text>", 'Page content (use "-" for stdin)')
		.option("--data <json>", "Raw JSON arguments (overrides other flags)")
		.addHelpText(
			"after",
			`
Examples:
  ncli page create --title "Meeting Notes" --parent <page-id>
  ncli page create --parent collection://<ds-id> --title "Task" --prop "Status=Open"
  echo "# Content" | ncli page create --title "Doc" --body -

Parent types (auto-detected from prefix):
  <page-id>           → page parent
  collection://<id>   → data source parent (for DB pages)

For DB pages: run "ncli fetch <db-id>" first to get the data_source_id (collection://...) and schema.`,
		)
		.action(async (opts: PageWriteOptions & { prop?: string[] }, cmd: Command) => {
			opts.props = opts.prop;
			opts.body = await resolveBody(opts.body);
			const { tool, args } = buildPageCreateCall(opts);
			await withConnection(async (conn) => {
				const result = await conn.callTool(tool, args);
				printOutput(result as Record<string, unknown>, cmd.optsWithGlobals());
			});
		});

	page
		.command("update")
		.description("Update properties (--prop) or content (--body) of a page")
		.argument("<id>", "Page ID")
		.option("--title <title>", "New page title")
		.option(
			"--prop <key=value>",
			"Set property (repeatable)",
			(v: string, a: string[]) => [...a, v],
			[] as string[],
		)
		.option("--body <text>", 'Page content (use "-" for stdin)')
		.option("--data <json>", "Raw JSON arguments (overrides other flags)")
		.action(
			async (
				id: string,
				opts: Omit<PageWriteOptions, "parent"> & { prop?: string[] },
				cmd: Command,
			) => {
				opts.props = opts.prop;
				opts.body = await resolveBody(opts.body);
				const { tool, args } = buildPageUpdateCall(id, opts);
				await withConnection(async (conn) => {
					const result = await conn.callTool(tool, args);
					printOutput(result as Record<string, unknown>, cmd.optsWithGlobals());
				});
			},
		);

	page
		.command("move")
		.description("Move pages or databases to a new parent (--to)")
		.argument("<id...>", "Page IDs to move")
		.requiredOption("--to <parent-id>", "Target parent ID")
		.action(async (ids: string[], opts: { to: string }, cmd: Command) => {
			const { tool, args } = buildPageMoveCall(ids, opts.to);
			await withConnection(async (conn) => {
				const result = await conn.callTool(tool, args);
				printOutput(result as Record<string, unknown>, cmd.optsWithGlobals());
			});
		});

	page
		.command("duplicate")
		.description("Duplicate a page (async)")
		.argument("<id>", "Page ID to duplicate")
		.action(async (id: string, _opts: unknown, cmd: Command) => {
			const { tool, args } = buildPageDuplicateCall(id);
			await withConnection(async (conn) => {
				const result = await conn.callTool(tool, args);
				printOutput(result as Record<string, unknown>, cmd.optsWithGlobals());
			});
		});

	page
		.command("append")
		.description("Append markdown content to a page (preserves existing blocks)")
		.argument("<id>", "Page ID")
		.option("--body <text>", 'Markdown content to append (use "-" for stdin)')
		.option("--data <json>", "Raw JSON args for notion-update-page (overrides --body)")
		.addHelpText(
			"after",
			`
Examples:
  ncli page append <page-id> --body "# New section"
  ncli page append <page-id> --body $'- item 1\\n- item 2'
  echo "Appended paragraph" | ncli page append <page-id> --body -

Body is markdown — same syntax as "page update --body" (headings, lists, quotes, etc.).
Unlike "page update --body" (which replaces all content), append fetches the page, anchors
on the last unique chunk of existing content, and inserts the new body after it. For blank
pages, falls back to replace_content.`,
		)
		.action(async (id: string, opts: { body?: string; data?: string }, cmd: Command) => {
			opts.body = await resolveBody(opts.body);
			if (!opts.data && (!opts.body || opts.body.trim() === "")) {
				throw new CliError(
					"No content to append",
					"--body or --data is required",
					'Provide content: ncli page append <id> --body "# New section"',
				);
			}
			await withConnection(async (conn) => {
				let parsed: ParsedPageBody = { blank: false, markdown: "" };
				if (!opts.data) {
					const fetchCall = buildFetchCall(id);
					const fetchResult = await conn.callTool(fetchCall.tool, fetchCall.args);
					parsed = extractPageBody(fetchResult as FetchResult);
				}
				const { tool, args } = buildPageAppendCall(id, parsed, opts);
				const result = await conn.callTool(tool, args);
				printOutput(result as Record<string, unknown>, cmd.optsWithGlobals());
			});
		});
}
