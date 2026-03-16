export type {
	NetworkClient,
	StoreReceipt,
	NodeConfig,
	NodeStats,
	ErasureConfig,
	Attestation,
} from "./types.js";

export { NetworkClientImpl, createNode } from "./client.js";

export { encode, decode, gfMul, gfDiv, gfInv } from "./erasure.js";

export {
	PROTOCOL_ID,
	serializeMessage,
	deserializeMessage,
	writeStream,
	readStream,
} from "./protocol.js";

export type {
	StoreMessage,
	RetrieveMessage,
	LatestMessage,
	ResponseMessage,
	RequestMessage,
} from "./protocol.js";
