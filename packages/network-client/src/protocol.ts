import type { Stream } from "@libp2p/interface";

/** Protocol identifier for shard exchange. */
export const PROTOCOL_ID = "/ensoul/shard/1.0.0";

/**
 * Message types for the shard exchange protocol.
 */
export interface StoreMessage {
	type: "store";
	agentDid: string;
	version: number;
	shardIndex: number;
	stateRoot: string;
	originalLength: number;
	signature: string;
}

export interface RetrieveMessage {
	type: "retrieve";
	agentDid: string;
	version: number;
	shardIndex: number;
}

export interface LatestMessage {
	type: "latest";
	agentDid: string;
}

export interface ResponseMessage {
	type: "response";
	status: "ok" | "error" | "not_found";
	version?: number;
	stateRoot?: string;
	originalLength?: number;
	error?: string;
}

export type RequestMessage = StoreMessage | RetrieveMessage | LatestMessage;

/**
 * Serialize a message with optional binary payload.
 * Format: [4-byte BE header length][JSON header][binary payload]
 */
export function serializeMessage(
	msg: RequestMessage | ResponseMessage,
	payload?: Uint8Array,
): Uint8Array {
	const headerBytes = new TextEncoder().encode(JSON.stringify(msg));
	const body = payload ?? new Uint8Array(0);
	const result = new Uint8Array(4 + headerBytes.length + body.length);
	new DataView(result.buffer).setUint32(0, headerBytes.length, false);
	result.set(headerBytes, 4);
	result.set(body, 4 + headerBytes.length);
	return result;
}

/**
 * Deserialize a message from the wire format.
 */
export function deserializeMessage(data: Uint8Array): {
	header: RequestMessage | ResponseMessage;
	payload: Uint8Array;
} {
	if (data.length < 4) {
		throw new Error("Message too short");
	}
	const headerLen = new DataView(
		data.buffer,
		data.byteOffset,
	).getUint32(0, false);
	if (data.length < 4 + headerLen) {
		throw new Error("Incomplete message header");
	}
	const headerStr = new TextDecoder().decode(
		data.subarray(4, 4 + headerLen),
	);
	const header = JSON.parse(headerStr) as
		| RequestMessage
		| ResponseMessage;
	const payload = data.subarray(4 + headerLen);
	return { header, payload };
}

/**
 * Read all data from a stream into a single Uint8Array.
 */
export async function readStream(stream: Stream): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) {
		chunks.push(
			chunk instanceof Uint8Array ? chunk : chunk.subarray(),
		);
	}
	const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
	const combined = new Uint8Array(totalLen);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}
	return combined;
}

/**
 * Send a message over a stream and then half-close (close write side).
 */
export function writeStream(
	stream: Stream,
	msg: RequestMessage | ResponseMessage,
	payload?: Uint8Array,
): Promise<void> {
	const data = serializeMessage(msg, payload);
	stream.send(data);
	return stream.close();
}
