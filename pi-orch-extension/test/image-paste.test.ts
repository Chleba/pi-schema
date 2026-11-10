import { describe, expect, it } from "vitest";

import { findPastedImagePaths } from "../image-paste.ts";

describe("findPastedImagePaths", () => {
	it("finds clipboard image paths in text", () => {
		expect(findPastedImagePaths("see /tmp/clipboard-abc123.png")).toEqual(["/tmp/clipboard-abc123.png"]);
		expect(findPastedImagePaths("a /home/u/pi-clipboard-x-1.png and /tmp/clipboard-y.jpeg")).toEqual([
			"/home/u/pi-clipboard-x-1.png",
			"/tmp/clipboard-y.jpeg",
		]);
	});

	it("supports file:// URLs", () => {
		expect(findPastedImagePaths("file:///tmp/clipboard-z.webp")).toEqual(["file:///tmp/clipboard-z.webp"]);
	});

	it("ignores text without clipboard images", () => {
		expect(findPastedImagePaths("no paths here")).toEqual([]);
		expect(findPastedImagePaths("/usr/local/bin")).toEqual([]);
	});

	// Regression: the old pattern allowed "/" to be consumed both by the inner
	// [^\s'"]+ and by the (?:...\/)* terminator, so any non-matching multi-segment
	// path triggered exponential backtracking and froze pi at 100% CPU right
	// after submitting the first message.
	it("does not backtrack exponentially on long non-matching paths", () => {
		const input = `look at /${"a/".repeat(30)}end.txt please`;
		const startedAt = Date.now();
		expect(findPastedImagePaths(input)).toEqual([]);
		expect(Date.now() - startedAt).toBeLessThan(1000);
	});

	// matchAll starts from the regex's lastIndex; earlier .match() calls on the
	// shared global pattern used to leave it dangling, skipping later matches.
	it("scans from the start even after a prior successful match", () => {
		findPastedImagePaths("/tmp/clipboard-first.png");
		expect(findPastedImagePaths("pre /tmp/clipboard-second.png")).toEqual(["/tmp/clipboard-second.png"]);
	});
});
