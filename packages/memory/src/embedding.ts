import type { EmbeddingProvider } from "./types.js";

/** Dimensionality for the keyword-based fallback embedder. */
const FALLBACK_DIMS = 256;

/** Simple stop words to filter out. */
const STOP_WORDS = new Set([
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "shall", "can", "to", "of", "in", "for",
	"on", "with", "at", "by", "from", "as", "into", "through", "during",
	"before", "after", "and", "but", "or", "nor", "not", "so", "yet",
	"both", "either", "neither", "each", "every", "all", "any", "few",
	"more", "most", "other", "some", "such", "no", "only", "own", "same",
	"than", "too", "very", "just", "it", "its", "this", "that", "these",
	"those", "i", "me", "my", "we", "our", "you", "your", "he", "him",
	"his", "she", "her", "they", "them", "their", "what", "which", "who",
]);

/**
 * FNV-1a hash of a string, returns a 32-bit unsigned integer.
 */
function fnv1a(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Tokenize text: lowercase, split on non-alphanumeric, remove stop words.
 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Keyword-based fallback embedding provider.
 * Generates a bag-of-words sparse vector by hashing tokens into buckets.
 * No external API calls needed — works entirely offline.
 */
export class KeywordFallbackEmbedder implements EmbeddingProvider {
	readonly dimensions: number = FALLBACK_DIMS;

	async embed(text: string): Promise<Float32Array> {
		const vec = new Float32Array(FALLBACK_DIMS);
		const tokens = tokenize(text);

		for (const token of tokens) {
			const bucket = fnv1a(token) % FALLBACK_DIMS;
			vec[bucket] = (vec[bucket] ?? 0) + 1;
		}

		// L2-normalize
		let norm = 0;
		for (let i = 0; i < FALLBACK_DIMS; i++) {
			const v = vec[i] ?? 0;
			norm += v * v;
		}
		norm = Math.sqrt(norm);
		if (norm > 0) {
			for (let i = 0; i < FALLBACK_DIMS; i++) {
				vec[i] = (vec[i] ?? 0) / norm;
			}
		}

		return vec;
	}
}
