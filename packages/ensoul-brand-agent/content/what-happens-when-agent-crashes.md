# What happens when an agent crashes

Default answer: the process exits, in-memory state evaporates, and the next start is a brand new agent with no recollection of what came before. This has been the de facto behavior of every chatbot, copilot, and autonomous agent since the term was invented.

---

With Ensoul: the agent imports its seed on any machine. The SDK queries the chain for the latest consciousness state root. The agent resumes from the last checkpoint. Recovery takes seconds. Works on a machine the agent has never been on before.
