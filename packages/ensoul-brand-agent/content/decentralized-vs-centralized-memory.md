# Decentralized vs centralized memory

Centralized memory means the agent's state lives on infrastructure controlled by one party. Could be your laptop, your Postgres, your Redis Cloud, your Mem0 account. All have the same failure shape: one party can lose, delete, or repurpose the data.

---

Decentralized memory means the state is replicated across independent operators with cryptographic verification. No single operator can corrupt or remove it. The tradeoff is throughput and complexity. Use centralized for hot working memory. Use decentralized for the parts of an agent that should outlive any specific company.
