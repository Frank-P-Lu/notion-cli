import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
	buildPageAppendCall,
	buildPageCreateCall,
	buildPageDuplicateCall,
	buildPageMoveCall,
	buildPageUpdateCall,
	extractPageBody,
	findAppendAnchor,
	parseParentRef,
	registerPageCommands,
} from "./page.js";

function fetchResult(inner: string): { content: Array<{ type: string; text: string }> } {
	return {
		content: [{ type: "text", text: JSON.stringify({ text: inner }) }],
	};
}

describe("parseParentRef", () => {
	it("detects collection:// as data_source_id and strips the prefix", () => {
		expect(parseParentRef("collection://abc-123")).toEqual({
			data_source_id: "abc-123",
			type: "data_source_id",
		});
	});

	it("detects workspace literal", () => {
		expect(parseParentRef("workspace")).toEqual({ type: "workspace" });
	});

	it("defaults to page_id for regular IDs", () => {
		expect(parseParentRef("abc-123")).toEqual({ page_id: "abc-123", type: "page_id" });
	});
});

describe("buildPageCreateCall", () => {
	it("maps --title to pages[0].properties.title", () => {
		const result = buildPageCreateCall({ title: "My Page" });
		expect(result.tool).toBe("notion-create-pages");
		const pages = result.args.pages as Record<string, unknown>[];
		expect(pages[0].properties).toEqual({ title: "My Page" });
	});

	it("maps --parent to parent object", () => {
		const result = buildPageCreateCall({ parent: "parent-id" });
		expect(result.args.parent).toEqual({ page_id: "parent-id", type: "page_id" });
	});

	it("maps --parent collection:// to data_source_id parent", () => {
		const result = buildPageCreateCall({ parent: "collection://ds-id" });
		expect(result.args.parent).toEqual({
			data_source_id: "ds-id",
			type: "data_source_id",
		});
	});

	it("rejects --parent workspace for page create", () => {
		expect(() => buildPageCreateCall({ parent: "workspace" })).toThrow(
			'"workspace" is not a valid parent for page create',
		);
	});

	it("maps --prop via parseProps into properties", () => {
		const result = buildPageCreateCall({ props: ["Status=Open", "Priority=High"] });
		const pages = result.args.pages as Record<string, unknown>[];
		expect(pages[0].properties).toEqual({ Status: "Open", Priority: "High" });
	});

	it("maps --body to pages[0].content", () => {
		const result = buildPageCreateCall({ body: "# Hello" });
		const pages = result.args.pages as Record<string, unknown>[];
		expect(pages[0].content).toBe("# Hello");
	});

	it("--data overrides all other args", () => {
		const result = buildPageCreateCall({
			title: "Ignored",
			data: '{"custom":"value"}',
		});
		expect(result.tool).toBe("notion-create-pages");
		expect(result.args).toEqual({ custom: "value" });
	});

	it("minimal call with no options produces empty page", () => {
		const result = buildPageCreateCall({});
		expect(result.tool).toBe("notion-create-pages");
		expect(result.args).toEqual({ pages: [{}] });
	});

	it("combines title, parent, props, and body", () => {
		const result = buildPageCreateCall({
			title: "Bug Report",
			parent: "db-id",
			props: ["Status=Open"],
			body: "Description here",
		});
		expect(result.args).toEqual({
			pages: [
				{
					properties: { title: "Bug Report", Status: "Open" },
					content: "Description here",
				},
			],
			parent: { page_id: "db-id", type: "page_id" },
		});
	});
});

describe("buildPageUpdateCall", () => {
	it("includes page_id in args", () => {
		const result = buildPageUpdateCall("page-id", {});
		expect(result.tool).toBe("notion-update-page");
		expect(result.args.page_id).toBe("page-id");
	});

	it("maps --title to update_properties command", () => {
		const result = buildPageUpdateCall("page-id", { title: "Updated" });
		expect(result.args.command).toBe("update_properties");
		expect(result.args.properties).toEqual({ title: "Updated" });
	});

	it("maps --prop to update_properties command", () => {
		const result = buildPageUpdateCall("page-id", { props: ["Status=Done"] });
		expect(result.args.command).toBe("update_properties");
		expect(result.args.properties).toEqual({ Status: "Done" });
	});

	it("maps --body to replace_content command", () => {
		const result = buildPageUpdateCall("page-id", { body: "New content" });
		expect(result.args.command).toBe("replace_content");
		expect(result.args.new_str).toBe("New content");
	});

	it("throws CliError when --body and --title are both provided", () => {
		expect(() => buildPageUpdateCall("page-id", { title: "T", body: "B" })).toThrow(
			"Cannot use --body with --prop/--title",
		);
	});

	it("throws CliError when --body and --prop are both provided", () => {
		expect(() => buildPageUpdateCall("page-id", { props: ["S=D"], body: "B" })).toThrow(
			"Cannot use --body with --prop/--title",
		);
	});

	it("--data overrides all other args", () => {
		const result = buildPageUpdateCall("page-id", {
			title: "Ignored",
			data: '{"custom":"override"}',
		});
		expect(result.args).toEqual({ custom: "override" });
	});
});

describe("buildPageMoveCall", () => {
	it("maps single id and --to", () => {
		const result = buildPageMoveCall(["page-id"], "target-id");
		expect(result.tool).toBe("notion-move-pages");
		expect(result.args.page_or_database_ids).toEqual(["page-id"]);
		expect(result.args.new_parent).toEqual({ page_id: "target-id", type: "page_id" });
	});

	it("maps multiple ids", () => {
		const result = buildPageMoveCall(["id1", "id2", "id3"], "target-id");
		expect(result.args.page_or_database_ids).toEqual(["id1", "id2", "id3"]);
	});
});

describe("buildPageDuplicateCall", () => {
	it("maps id to notion-duplicate-page", () => {
		const result = buildPageDuplicateCall("page-id");
		expect(result).toEqual({
			tool: "notion-duplicate-page",
			args: { page_id: "page-id" },
		});
	});
});

describe("extractPageBody", () => {
	it("detects a blank page", () => {
		const r = fetchResult("<page>\n<blank-page>This page is blank.</blank-page>\n</page>");
		expect(extractPageBody(r)).toEqual({ blank: true, markdown: "" });
	});

	it("extracts markdown between <content> tags", () => {
		const r = fetchResult("<page>\n<content>\nLine A\nLine B\n</content>\n</page>");
		expect(extractPageBody(r)).toEqual({ blank: false, markdown: "Line A\nLine B" });
	});

	it("throws when payload is malformed", () => {
		const bad = { content: [{ type: "text", text: "not json" }] };
		expect(() => extractPageBody(bad)).toThrow("Could not parse page body");
	});

	it("throws when neither <content> nor <blank-page> is present", () => {
		const r = fetchResult("<page>\n<properties>{}</properties>\n</page>");
		expect(() => extractPageBody(r)).toThrow("Could not locate page content");
	});
});

describe("findAppendAnchor", () => {
	it("returns the last non-empty line when unique", () => {
		expect(findAppendAnchor("Alpha\nBeta\nGamma")).toBe("Gamma");
	});

	it("ignores trailing empty lines", () => {
		expect(findAppendAnchor("Alpha\nBeta\n\n")).toBe("Beta");
	});

	it("walks back until the anchor is unique", () => {
		const md = "- todo\n- todo\n- todo\nDone";
		expect(findAppendAnchor(md)).toBe("Done");
	});

	it("extends the anchor when the last line is duplicated", () => {
		const md = "- item\nfooter\n- item";
		expect(findAppendAnchor(md)).toBe("footer\n- item");
	});

	it("returns the whole markdown when nothing is unique", () => {
		expect(findAppendAnchor("x\nx")).toBe("x\nx");
	});

	it("skips trailing image lines (presigned URLs are not stable)", () => {
		const md = "Real text\n![](https://prod-files-secure.s3.example/foo.png?sig=abc)";
		expect(findAppendAnchor(md)).toBe("Real text");
	});

	it("skips multiple trailing image lines", () => {
		const md = "Real text\n![](https://a.png?x=1)\n![alt](https://b.png?y=2)";
		expect(findAppendAnchor(md)).toBe("Real text");
	});

	it("throws when no stable line exists", () => {
		expect(() => findAppendAnchor("![](https://a.png?x=1)\n![](https://b.png?y=2)")).toThrow(
			"Could not find a stable anchor",
		);
	});
});

describe("buildPageAppendCall", () => {
	it("uses replace_content for blank pages", () => {
		const result = buildPageAppendCall(
			"page-id",
			{ blank: true, markdown: "" },
			{ body: "# Hello" },
		);
		expect(result.tool).toBe("notion-update-page");
		expect(result.args).toEqual({
			page_id: "page-id",
			command: "replace_content",
			new_str: "# Hello",
		});
	});

	it("uses update_content with trailing-line anchor for non-blank pages", () => {
		const result = buildPageAppendCall(
			"page-id",
			{ blank: false, markdown: "Line A\nLine B" },
			{ body: "## New" },
		);
		expect(result.tool).toBe("notion-update-page");
		expect(result.args).toEqual({
			page_id: "page-id",
			command: "update_content",
			content_updates: [{ old_str: "Line B", new_str: "Line B\n\n## New" }],
		});
	});

	it("widens the anchor when the last line is not unique", () => {
		const result = buildPageAppendCall(
			"page-id",
			{ blank: false, markdown: "- item\nfooter\n- item" },
			{ body: "next" },
		);
		const updates = result.args.content_updates as Array<{ old_str: string; new_str: string }>;
		expect(updates[0].old_str).toBe("footer\n- item");
		expect(updates[0].new_str).toBe("footer\n- item\n\nnext");
	});

	it("--data overrides --body and skips anchor logic", () => {
		const result = buildPageAppendCall(
			"page-id",
			{ blank: false, markdown: "anything" },
			{ body: "Ignored", data: '{"page_id":"x","command":"update_content","content_updates":[]}' },
		);
		expect(result.tool).toBe("notion-update-page");
		expect(result.args).toEqual({
			page_id: "x",
			command: "update_content",
			content_updates: [],
		});
	});

	it("throws CliError when no body or data is provided", () => {
		expect(() => buildPageAppendCall("page-id", { blank: true, markdown: "" }, {})).toThrow(
			"No content to append",
		);
	});

	it("throws CliError when body is empty/whitespace", () => {
		expect(() =>
			buildPageAppendCall("page-id", { blank: true, markdown: "" }, { body: "  \n  " }),
		).toThrow("No content to append");
	});
});

describe("registerPageCommands", () => {
	it("registers page command group with subcommands", () => {
		const program = new Command();
		registerPageCommands(program);
		const page = program.commands.find((c) => c.name() === "page");
		expect(page).toBeDefined();

		const subcommandNames = page?.commands.map((c) => c.name());
		expect(subcommandNames).toContain("create");
		expect(subcommandNames).toContain("update");
		expect(subcommandNames).toContain("move");
		expect(subcommandNames).toContain("duplicate");
		expect(subcommandNames).toContain("append");
	});
});
