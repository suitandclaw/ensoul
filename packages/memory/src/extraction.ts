import type {
	ConversationMessage,
	ExtractedFact,
	ExtractionProvider,
	ConflictResolution,
	MemoryEntry,
} from "./types.js";

/**
 * Keyword-based fallback extractor.
 * Extracts facts by splitting sentences and detecting capitalized entities.
 * Used when no LLM provider is configured.
 */
export class KeywordFallbackExtractor implements ExtractionProvider {
	async extractFacts(
		messages: ConversationMessage[],
	): Promise<ExtractedFact[]> {
		const facts: ExtractedFact[] = [];

		for (const msg of messages) {
			if (msg.role === "system") continue;

			const sentences = splitSentences(msg.content);
			for (const sentence of sentences) {
				if (sentence.length < 5) continue;

				const entities = extractEntities(sentence);
				const relationships = extractRelationships(
					sentence,
					entities,
				);

				facts.push({
					content: sentence.trim(),
					confidence: 0.5,
					entities,
					relationships,
				});
			}
		}

		return facts;
	}

	async resolveConflict(
		_newFact: ExtractedFact,
		existing: MemoryEntry[],
	): Promise<ConflictResolution> {
		// Simple heuristic: if very similar content exists, noop; otherwise add
		if (existing.length === 0) {
			return { action: "add" };
		}
		return { action: "noop" };
	}
}

/**
 * Split text into sentences.
 */
function splitSentences(text: string): string[] {
	return text
		.split(/[.!?\n]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Extract entities from a sentence (capitalized words, quoted strings).
 */
function extractEntities(
	sentence: string,
): Array<{ name: string; type: string }> {
	const entities: Array<{ name: string; type: string }> = [];
	const seen = new Set<string>();

	// Capitalized words (likely proper nouns)
	const capitalizedPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g;
	let match: RegExpExecArray | null;
	while ((match = capitalizedPattern.exec(sentence)) !== null) {
		const name = match[0];
		if (!seen.has(name)) {
			seen.add(name);
			entities.push({ name, type: "entity" });
		}
	}

	// Quoted strings
	const quotedPattern = /"([^"]+)"/g;
	while ((match = quotedPattern.exec(sentence)) !== null) {
		const name = match[1]!;
		if (!seen.has(name)) {
			seen.add(name);
			entities.push({ name, type: "quoted" });
		}
	}

	return entities;
}

/**
 * Extract simple relationships from entities in a sentence.
 * Pairs consecutive entities with a generic "related_to" predicate.
 */
function extractRelationships(
	_sentence: string,
	entities: Array<{ name: string; type: string }>,
): Array<{ subject: string; predicate: string; object: string }> {
	const relationships: Array<{
		subject: string;
		predicate: string;
		object: string;
	}> = [];

	for (let i = 0; i + 1 < entities.length; i++) {
		relationships.push({
			subject: entities[i]!.name,
			predicate: "related_to",
			object: entities[i + 1]!.name,
		});
	}

	return relationships;
}
