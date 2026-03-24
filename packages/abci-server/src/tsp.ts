/**
 * Tendermint Socket Protocol (TSP) server.
 *
 * CometBFT communicates with ABCI apps using length-prefixed protobuf
 * messages over a TCP or Unix socket. The protocol:
 *
 *   1. Each message is prefixed with a varint-encoded length
 *   2. The message itself is a protobuf-encoded Request or Response
 *   3. CometBFT sends Request messages, the app sends Response messages
 *   4. Multiple concurrent connections (consensus, mempool, info, snapshot)
 *
 * This module implements the low-level TCP server and message framing.
 * The ABCI method dispatch is handled by the Application class.
 */

import * as net from "node:net";
import protobuf from "protobufjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = join(SCRIPT_DIR, "..", "proto");

/** Loaded protobuf types (initialized once). */
let RequestType: protobuf.Type;
let ResponseType: protobuf.Type;
let protoRoot: protobuf.Root;

/**
 * Load and parse the CometBFT ABCI protobuf definitions.
 */
export async function loadProto(): Promise<protobuf.Root> {
	if (protoRoot) return protoRoot;

	const root = new protobuf.Root();
	root.resolvePath = (origin: string, target: string): string => {
		// If target is already absolute, use it
		if (target.startsWith("/")) return target;
		// Resolve relative to proto dir, not to origin file
		if (target.startsWith("tendermint/") || target.startsWith("google/")) {
			return join(PROTO_DIR, target);
		}
		// Default: resolve relative to origin
		return join(dirname(origin), target);
	};

	await root.load(join(PROTO_DIR, "tendermint", "abci", "types.proto"));
	protoRoot = root;
	RequestType = root.lookupType("tendermint.abci.Request");
	ResponseType = root.lookupType("tendermint.abci.Response");

	return root;
}

/**
 * Encode a varint (protobuf-style unsigned LEB128).
 */
function encodeVarint(value: number): Buffer {
	const bytes: number[] = [];
	while (value > 0x7f) {
		bytes.push((value & 0x7f) | 0x80);
		value >>>= 7;
	}
	bytes.push(value & 0x7f);
	return Buffer.from(bytes);
}

/**
 * Try to decode a varint from a buffer at the given offset.
 * Returns [value, bytesConsumed] or null if incomplete.
 */
function decodeVarint(buf: Buffer, offset: number): [number, number] | null {
	let value = 0;
	let shift = 0;
	let pos = offset;

	while (pos < buf.length) {
		const byte = buf[pos]!;
		value |= (byte & 0x7f) << shift;
		pos++;
		if ((byte & 0x80) === 0) {
			return [value, pos - offset];
		}
		shift += 7;
		if (shift > 35) throw new Error("Varint too long");
	}
	return null; // Incomplete
}

/** Callback type for handling decoded ABCI requests. */
export type RequestHandler = (
	request: protobuf.Message,
	requestField: string,
) => Promise<Record<string, unknown>>;

/**
 * Start a TSP server that listens for CometBFT ABCI connections.
 *
 * @param port - TCP port to listen on (default 26658)
 * @param handler - Async function that processes each ABCI Request and returns a Response
 * @param log - Optional logger
 * @returns The TCP server instance
 */
export function startTSPServer(
	port: number,
	handler: RequestHandler,
	log?: (msg: string) => void,
): net.Server {
	const logger = log ?? ((msg: string) => process.stdout.write(`[tsp] ${msg}\n`));

	const server = net.createServer((socket) => {
		logger(`Connection from ${socket.remoteAddress}:${socket.remotePort}`);

		let buffer = Buffer.alloc(0);
		let processing = false;
		const pendingChunks: Buffer[] = [];

		socket.on("data", (chunk: Buffer) => {
			pendingChunks.push(chunk);
			if (!processing) {
				processing = true;
				void drainAndProcess().finally(() => { processing = false; });
			}
		});

		async function drainAndProcess(): Promise<void> {
			while (pendingChunks.length > 0) {
				buffer = Buffer.concat([buffer, ...pendingChunks.splice(0)]);
				await processBuffer();
			}
		}

		async function processBuffer(): Promise<void> {
			while (buffer.length > 0) {
				// Read varint length prefix
				const varintResult = decodeVarint(buffer, 0);
				if (!varintResult) break; // Incomplete varint

				const [msgLen, varintLen] = varintResult;
				const totalLen = varintLen + msgLen;

				if (buffer.length < totalLen) break; // Incomplete message

				// Extract message bytes
				const msgBytes = buffer.subarray(varintLen, totalLen);
				buffer = buffer.subarray(totalLen);

				try {
					// Decode the Request wrapper
					const request = RequestType.decode(msgBytes);

					// Find which oneof field is actually set.
					// Use the protobufjs internal representation: the "value"
					// field name is stored on the decoded message object.
					// We check which field has a non-default value by looking
					// at the raw decoded message (NOT toObject with defaults).
					const reqAny = request as unknown as Record<string, unknown>;
					let requestField = "";
					const oneofFields = RequestType.oneofs?.["value"]?.fieldsArray ?? [];
					for (const field of oneofFields) {
						if (reqAny[field.name] != null) {
							requestField = field.name;
							break;
						}
					}

					// Fallback: iterate fields if oneof not found
					if (!requestField) {
						for (const field of RequestType.fieldsArray) {
							if (reqAny[field.name] != null) {
								requestField = field.name;
								break;
							}
						}
					}

					if (!requestField) {
						logger("Empty request received, skipping");
						continue;
					}

					// Handle the request
					const responseObj = await handler(request, requestField);

					// Encode the Response
					const responseMsg = ResponseType.create(responseObj);
					const responseBytes = ResponseType.encode(responseMsg).finish();

					// Write length-prefixed response
					const lenPrefix = encodeVarint(responseBytes.length);
					socket.write(Buffer.concat([lenPrefix, Buffer.from(responseBytes)]));
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger(`Error processing request: ${msg}`);
				}
			}
		}

		socket.on("error", (err) => {
			logger(`Socket error: ${err.message}`);
		});

		socket.on("close", () => {
			logger("Connection closed");
		});
	});

	server.listen(port, () => {
		logger(`ABCI server listening on port ${port}`);
	});

	return server;
}

/**
 * Get the loaded protobuf root (must call loadProto first).
 */
export function getProtoRoot(): protobuf.Root {
	if (!protoRoot) throw new Error("Proto not loaded. Call loadProto() first.");
	return protoRoot;
}
