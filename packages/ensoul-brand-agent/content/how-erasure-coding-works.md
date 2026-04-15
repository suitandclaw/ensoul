# How erasure coding works

Erasure coding splits data into N shards such that any K of them can reconstruct the whole. Ensoul uses 2-of-4 GF(256). Lose half the network, your data survives.

---

Each shard is mathematically independent. No shard alone reveals anything. Validators store shards across geographic regions so a regional outage cannot eat your agent's memory. Recovery is a polynomial interpolation over the field.
