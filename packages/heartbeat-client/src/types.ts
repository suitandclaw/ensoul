// Heartbeat payload per spec Section 1.
// Duplicated from packages/api/telemetry/types.ts for decoupling.

export interface HeartbeatPayload {
  version: 1;
  chain_id: string;
  did: string;
  timestamp: number;
  height: number;
  catching_up: boolean;
  peers: number;
  cometbft_version: string;
  abci_version: string;
  uptime_seconds?: number;
  restart_count?: number;
  disk_used_pct?: number;
  mem_used_pct?: number;
}

export interface SignedHeartbeat extends HeartbeatPayload {
  signature: string;
}

export interface Identity {
  did: string;
  seed: string;
}
