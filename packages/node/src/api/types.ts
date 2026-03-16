/**
 * Configuration for the API server.
 */
export interface ApiServerConfig {
	/** Port to listen on. */
	port: number;
	/** Host to bind to. */
	host: string;
	/** Rate limit: max requests per minute per IP. */
	rateLimit: number;
}

/**
 * Credit balance for a node or agent.
 */
export interface CreditBalance {
	did: string;
	balance: number;
}
