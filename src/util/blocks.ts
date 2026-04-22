/**
 * Convert markdown-like text into Notion block objects suitable for
 * the REST API `PATCH /v1/blocks/{id}/children` endpoint.
 *
 * Supported syntax:
 *   # Heading 1
 *   ## Heading 2
 *   ### Heading 3
 *   - Bullet list item
 *   1. Numbered list item
 *   > Quote / callout
 *   --- (divider)
 *   Plain paragraph (everything else)
 */

interface RichText {
	type: "text";
	text: { content: string };
}

interface NotionBlock {
	object: "block";
	type: string;
	[key: string]: unknown;
}

function richText(content: string): RichText[] {
	return [{ type: "text", text: { content } }];
}

function paragraphBlock(text: string): NotionBlock {
	return {
		object: "block",
		type: "paragraph",
		paragraph: { rich_text: richText(text) },
	};
}

function headingBlock(level: 1 | 2 | 3, text: string): NotionBlock {
	const type = `heading_${level}` as const;
	return {
		object: "block",
		type,
		[type]: { rich_text: richText(text) },
	};
}

function bulletedListItemBlock(text: string): NotionBlock {
	return {
		object: "block",
		type: "bulleted_list_item",
		bulleted_list_item: { rich_text: richText(text) },
	};
}

function numberedListItemBlock(text: string): NotionBlock {
	return {
		object: "block",
		type: "numbered_list_item",
		numbered_list_item: { rich_text: richText(text) },
	};
}

function quoteBlock(text: string): NotionBlock {
	return {
		object: "block",
		type: "quote",
		quote: { rich_text: richText(text) },
	};
}

function dividerBlock(): NotionBlock {
	return {
		object: "block",
		type: "divider",
		divider: {},
	};
}

export function textToBlocks(text: string): NotionBlock[] {
	const lines = text.split("\n");
	const blocks: NotionBlock[] = [];

	for (const line of lines) {
		const trimmed = line.trimEnd();

		// Skip empty lines
		if (trimmed === "") continue;

		// Divider
		if (/^---+$/.test(trimmed)) {
			blocks.push(dividerBlock());
			continue;
		}

		// Headings
		const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
		if (headingMatch) {
			const level = headingMatch[1].length as 1 | 2 | 3;
			blocks.push(headingBlock(level, headingMatch[2]));
			continue;
		}

		// Bullet list
		const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
		if (bulletMatch) {
			blocks.push(bulletedListItemBlock(bulletMatch[1]));
			continue;
		}

		// Numbered list
		const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
		if (numberedMatch) {
			blocks.push(numberedListItemBlock(numberedMatch[1]));
			continue;
		}

		// Quote
		const quoteMatch = trimmed.match(/^>\s+(.+)$/);
		if (quoteMatch) {
			blocks.push(quoteBlock(quoteMatch[1]));
			continue;
		}

		// Default: paragraph
		blocks.push(paragraphBlock(trimmed));
	}

	return blocks;
}
