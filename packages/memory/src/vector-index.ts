/**
 * Pure JS in-memory vector index with cosine similarity search.
 * Maintains cached norms for fast queries.
 */
export class VectorIndex {
	private vectors: Map<string, Float32Array> = new Map();
	private norms: Map<string, number> = new Map();
	private dims: number;

	constructor(dimensions: number) {
		this.dims = dimensions;
	}

	/** Add or replace a vector for a given ID. */
	add(id: string, vector: Float32Array): void {
		if (vector.length !== this.dims) {
			throw new Error(
				`Vector dimension mismatch: expected ${this.dims}, got ${vector.length}`,
			);
		}
		this.vectors.set(id, vector);
		this.norms.set(id, computeNorm(vector));
	}

	/** Remove a vector by ID. */
	remove(id: string): boolean {
		this.norms.delete(id);
		return this.vectors.delete(id);
	}

	/** Check if a vector exists. */
	has(id: string): boolean {
		return this.vectors.has(id);
	}

	/** Number of vectors in the index. */
	get size(): number {
		return this.vectors.size;
	}

	/**
	 * Search for the most similar vectors to the query.
	 * Returns IDs sorted by descending cosine similarity.
	 */
	search(
		query: Float32Array,
		limit: number,
		minSimilarity = 0,
	): Array<{ id: string; similarity: number }> {
		if (query.length !== this.dims) {
			throw new Error(
				`Query dimension mismatch: expected ${this.dims}, got ${query.length}`,
			);
		}

		const queryNorm = computeNorm(query);
		if (queryNorm === 0) return [];

		const results: Array<{ id: string; similarity: number }> = [];

		for (const [id, vec] of this.vectors) {
			const vecNorm = this.norms.get(id) ?? 0;
			if (vecNorm === 0) continue;

			const dot = computeDot(query, vec);
			const similarity = dot / (queryNorm * vecNorm);

			if (similarity >= minSimilarity) {
				results.push({ id, similarity });
			}
		}

		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, limit);
	}

	/** Clear all vectors. */
	clear(): void {
		this.vectors.clear();
		this.norms.clear();
	}
}

function computeNorm(v: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < v.length; i++) {
		sum += v[i]! * v[i]!;
	}
	return Math.sqrt(sum);
}

function computeDot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		sum += a[i]! * b[i]!;
	}
	return sum;
}
