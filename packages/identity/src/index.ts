export type {
	AgentIdentity,
	EncryptedPayload,
	EncryptedKeyBundle,
	SerializedIdentity,
} from "./types.js";

export {
	createIdentity,
	loadIdentity,
	verifyMigrationProof,
} from "./identity.js";

export {
	edwardsToMontgomeryPub,
	edwardsToMontgomeryPriv,
	createDid,
	createPeerId,
	base58btcEncode,
	base58btcDecode,
	bytesToHex,
	hexToBytes,
} from "./crypto.js";
