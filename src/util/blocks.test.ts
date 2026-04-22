import { describe, expect, it } from "vitest";
import { textToBlocks } from "./blocks.js";

describe("textToBlocks", () => {
	it("converts a plain paragraph", () => {
		const blocks = textToBlocks("Hello world");
		expect(blocks).toEqual([
			{
				object: "block",
				type: "paragraph",
				paragraph: { rich_text: [{ type: "text", text: { content: "Hello world" } }] },
			},
		]);
	});

	it("converts headings (h1, h2, h3)", () => {
		const blocks = textToBlocks("# Title\n## Subtitle\n### Section");
		expect(blocks).toHaveLength(3);
		expect(blocks[0].type).toBe("heading_1");
		expect(blocks[1].type).toBe("heading_2");
		expect(blocks[2].type).toBe("heading_3");
	});

	it("converts bullet list items (- and *)", () => {
		const blocks = textToBlocks("- Item A\n* Item B");
		expect(blocks).toHaveLength(2);
		expect(blocks[0].type).toBe("bulleted_list_item");
		expect(blocks[1].type).toBe("bulleted_list_item");
		expect((blocks[0].bulleted_list_item as Record<string, unknown[]>).rich_text[0]).toEqual({
			type: "text",
			text: { content: "Item A" },
		});
	});

	it("converts numbered list items", () => {
		const blocks = textToBlocks("1. First\n2. Second");
		expect(blocks).toHaveLength(2);
		expect(blocks[0].type).toBe("numbered_list_item");
		expect(blocks[1].type).toBe("numbered_list_item");
	});

	it("converts quotes", () => {
		const blocks = textToBlocks("> Important note");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("quote");
	});

	it("converts dividers", () => {
		const blocks = textToBlocks("---");
		expect(blocks).toEqual([{ object: "block", type: "divider", divider: {} }]);
	});

	it("skips empty lines", () => {
		const blocks = textToBlocks("Line 1\n\nLine 2");
		expect(blocks).toHaveLength(2);
		expect(blocks[0].type).toBe("paragraph");
		expect(blocks[1].type).toBe("paragraph");
	});

	it("handles mixed content", () => {
		const text = "# Header\n\n- bullet\n1. numbered\n> quote\n---\nParagraph";
		const blocks = textToBlocks(text);
		const types = blocks.map((b) => b.type);
		expect(types).toEqual([
			"heading_1",
			"bulleted_list_item",
			"numbered_list_item",
			"quote",
			"divider",
			"paragraph",
		]);
	});

	it("returns empty array for empty string", () => {
		expect(textToBlocks("")).toEqual([]);
	});

	it("returns empty array for whitespace-only string", () => {
		expect(textToBlocks("  \n  \n  ")).toEqual([]);
	});
});
