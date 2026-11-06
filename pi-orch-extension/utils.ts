export function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function isAbortLikeError(error: unknown): boolean {
	const message = formatErrorMessage(error).toLowerCase();
	return /\b(abort|aborted|cancel|cancelled|canceled|interrupt|interrupted)\b/.test(message);
}

export function slugifyText(value: string, maxLength: number, fallback: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength);
	return slug.length > 0 ? slug : fallback;
}

export type OverlappingPathPair = {
	a: number;
	b: number;
	paths: string[];
};

/**
 * Returns every pair of tasks whose declared path sets overlap, with the specific
 * colliding normalized paths. Two normalized paths collide when they are equal or
 * one is a proper prefix of the other at a "\/" boundary (directory containment).
 * Comparison is case-sensitive; an empty normalized path ("." or "") denotes the
 * repo root and overlaps every other path.
 */
export function findOverlappingPathPairs(pathSets: string[][]): OverlappingPathPair[] {
	const normalized = pathSets.map((set) => set.map(normalizeDeclaredPath));
	const result: OverlappingPathPair[] = [];
	for (let a = 0; a < normalized.length; a++) {
		for (let b = a + 1; b < normalized.length; b++) {
			const colliding = new Set<string>();
			for (const p of normalized[a]) {
				for (const q of normalized[b]) {
					if (p === q) {
						colliding.add(p);
					} else if (isPathPrefix(p, q)) {
						colliding.add(q);
					} else if (isPathPrefix(q, p)) {
						colliding.add(p);
					}
				}
			}
			if (colliding.size > 0) {
				result.push({ a, b, paths: [...colliding] });
			}
		}
	}
	return result;
}

function normalizeDeclaredPath(path: string): string {
	let normalized = path.trim();
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	normalized = normalized.replace(/\/{2,}/g, "/");
	if (normalized.length === 0 || normalized === "." || normalized === "/") {
		return "";
	}
	while (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

function isPathPrefix(prefix: string, path: string): boolean {
	if (prefix === path) {
		return false;
	}
	if (prefix.length === 0) {
		return true;
	}
	return path.startsWith(`${prefix}/`);
}
