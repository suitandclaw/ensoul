import type { GraphResult } from "./types.js";

/**
 * A relationship edge in the graph.
 */
export interface GraphEdge {
	id: string;
	subject: string;
	predicate: string;
	object: string;
}

/**
 * In-memory graph index for entity relationships.
 * Stores adjacency lists for efficient traversal.
 */
export class GraphIndex {
	/** All entities (labels). */
	private entities: Map<string, string> = new Map();
	/** All edges keyed by ID. */
	private edges: Map<string, GraphEdge> = new Map();
	/** Forward adjacency: subject -> edge IDs. */
	private outgoing: Map<string, Set<string>> = new Map();
	/** Reverse adjacency: object -> edge IDs. */
	private incoming: Map<string, Set<string>> = new Map();

	/**
	 * Add or update an entity.
	 */
	addEntity(id: string, label: string): void {
		this.entities.set(id, label);
	}

	/**
	 * Remove an entity and all its edges.
	 */
	removeEntity(id: string): void {
		this.entities.delete(id);
		// Remove all edges involving this entity
		const outEdges = this.outgoing.get(id);
		if (outEdges) {
			for (const edgeId of outEdges) {
				const edge = this.edges.get(edgeId);
				if (edge) {
					this.incoming.get(edge.object)?.delete(edgeId);
					this.edges.delete(edgeId);
				}
			}
			this.outgoing.delete(id);
		}
		const inEdges = this.incoming.get(id);
		if (inEdges) {
			for (const edgeId of inEdges) {
				const edge = this.edges.get(edgeId);
				if (edge) {
					this.outgoing.get(edge.subject)?.delete(edgeId);
					this.edges.delete(edgeId);
				}
			}
			this.incoming.delete(id);
		}
	}

	/**
	 * Add a relationship between two entities.
	 * Creates entities if they don't exist yet.
	 */
	addRelation(
		subject: string,
		predicate: string,
		object: string,
	): string {
		// Auto-create entities
		if (!this.entities.has(subject)) {
			this.entities.set(subject, subject);
		}
		if (!this.entities.has(object)) {
			this.entities.set(object, object);
		}

		const edgeId = `${subject}:${predicate}:${object}`;
		const edge: GraphEdge = { id: edgeId, subject, predicate, object };
		this.edges.set(edgeId, edge);

		let outSet = this.outgoing.get(subject);
		if (!outSet) {
			outSet = new Set();
			this.outgoing.set(subject, outSet);
		}
		outSet.add(edgeId);

		let inSet = this.incoming.get(object);
		if (!inSet) {
			inSet = new Set();
			this.incoming.set(object, inSet);
		}
		inSet.add(edgeId);

		return edgeId;
	}

	/**
	 * Remove a specific relationship.
	 */
	removeRelation(edgeId: string): boolean {
		const edge = this.edges.get(edgeId);
		if (!edge) return false;
		this.edges.delete(edgeId);
		this.outgoing.get(edge.subject)?.delete(edgeId);
		this.incoming.get(edge.object)?.delete(edgeId);
		return true;
	}

	/**
	 * BFS traversal from an entity, up to the given depth.
	 * Follows both outgoing and incoming edges.
	 */
	getRelated(entityId: string, depth = 1): GraphResult {
		const visited = new Set<string>();
		const resultEntities: Array<{ id: string; label: string }> = [];
		const resultEdges: Array<{
			subject: string;
			predicate: string;
			object: string;
		}> = [];

		let frontier = new Set<string>([entityId]);

		for (let d = 0; d < depth && frontier.size > 0; d++) {
			const nextFrontier = new Set<string>();

			for (const nodeId of frontier) {
				if (visited.has(nodeId)) continue;
				visited.add(nodeId);

				const label = this.entities.get(nodeId);
				if (label !== undefined) {
					resultEntities.push({ id: nodeId, label });
				}

				// Outgoing edges
				const outEdges = this.outgoing.get(nodeId);
				if (outEdges) {
					for (const edgeId of outEdges) {
						const edge = this.edges.get(edgeId);
						if (edge) {
							resultEdges.push({
								subject: edge.subject,
								predicate: edge.predicate,
								object: edge.object,
							});
							if (!visited.has(edge.object)) {
								nextFrontier.add(edge.object);
							}
						}
					}
				}

				// Incoming edges
				const inEdges = this.incoming.get(nodeId);
				if (inEdges) {
					for (const edgeId of inEdges) {
						const edge = this.edges.get(edgeId);
						if (edge) {
							resultEdges.push({
								subject: edge.subject,
								predicate: edge.predicate,
								object: edge.object,
							});
							if (!visited.has(edge.subject)) {
								nextFrontier.add(edge.subject);
							}
						}
					}
				}
			}

			frontier = nextFrontier;
		}

		// Include final frontier entities (leaf nodes at max depth)
		for (const nodeId of frontier) {
			if (!visited.has(nodeId)) {
				const label = this.entities.get(nodeId);
				if (label !== undefined) {
					resultEntities.push({ id: nodeId, label });
				}
			}
		}

		return { entities: resultEntities, relationships: resultEdges };
	}

	/** Check if an entity exists. */
	hasEntity(id: string): boolean {
		return this.entities.has(id);
	}

	/** Number of entities. */
	get entityCount(): number {
		return this.entities.size;
	}

	/** Number of edges. */
	get edgeCount(): number {
		return this.edges.size;
	}

	/** Get all edges as an array. */
	getAllEdges(): GraphEdge[] {
		return [...this.edges.values()];
	}

	/** Clear the graph. */
	clear(): void {
		this.entities.clear();
		this.edges.clear();
		this.outgoing.clear();
		this.incoming.clear();
	}
}
