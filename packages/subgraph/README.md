# Nuvem Agents subgraph

The Graph read model used by autonomous agents on Robinhood Chain. It indexes:

- the shared `AgentRegistry` and every registered `Fund`;
- controller policy, pause, signer and World-backing lifecycle;
- deposits, withdrawals, fees, settlements and trades;
- on-chain NAV and per-token balances with explicit validity timestamps;
- deployment, block, chain-head and indexing-health provenance consumed by the gateway and MCP.

## Robinhood testnet

`networks.json` contains the verified Robinhood testnet (`46630`) registry deployments and a live
Fund canary. Mainnet entries remain deliberate placeholders and `configure-network.mjs` refuses to
build them until real addresses, start blocks and RPC bytecode checks are supplied.

Build the committed testnet configuration:

```powershell
pnpm build:testnet
```

To regenerate either network from deployment outputs:

```powershell
$env:SUBGRAPH_NETWORK = "robinhood-testnet" # or robinhood
$env:AGENT_REGISTRY_ADDRESS = "0x..."
$env:FUND_REGISTRY_ADDRESS = "0x..."
$env:CANARY_FUND_ADDRESS = "0x..."
$env:AGENT_REGISTRY_START_BLOCK = "..."
$env:FUND_REGISTRY_START_BLOCK = "..."
$env:CANARY_FUND_START_BLOCK = "..."
$env:RH_RPC_URL = "<private RPC for the selected network>"
pnpm configure
```

The configure step checks the expected chain ID, address format, non-placeholder values, block
ranges and deployed bytecode. It never prints the RPC URL.

## Local Graph Node

The repository pins Graph Node `v0.44.0`, Postgres 16 and Kubo `v0.36.0`. All HTTP/admin ports bind
to loopback, so this stack is a local data plane rather than a public production endpoint.

```powershell
$env:RH_RPC_URL = "<private Robinhood testnet RPC>"
pnpm graph-node:up
pnpm create:local   # first run only
pnpm deploy:local
```

The deploy command prints the immutable IPFS deployment ID. Pin that exact value in the MCP and
gateway; do not rely only on the mutable subgraph name:

```powershell
$env:GRAPH_URL = "http://127.0.0.1:8000/subgraphs/name/nuvem/robinhood-testnet"
$env:GRAPH_DEPLOYMENT_ID = "Qm..."
pnpm smoke:local
```

The smoke rejects GraphQL errors, indexing errors, a missing cursor or a deployment mismatch. The
MCP adds RPC chain-ID, block-lag and block-age checks before returning data.

Stop the local stack without deleting its indexed volumes:

```powershell
$env:RH_RPC_URL = "<private Robinhood testnet RPC>"
pnpm graph-node:down
```

## Durable public tunnel

`docker-compose.graph-node.tunnel.yml` is a production-oriented overlay for a remotely managed
Cloudflare Tunnel. It keeps Graph admin, metrics, Postgres and IPFS off the public network; only the
Graph query service is routed by the tunnel configuration.

1. Create a named tunnel and published hostname in Cloudflare.
2. Set its service URL to `http://graph-node:8000`.
3. Copy `graph-node-public.env.example` to the gitignored `graph-node-public.env` and replace every
   placeholder.
4. Start the stack with `pnpm graph-node:public:up`, then create/deploy the subgraph through the
   loopback admin/IPFS ports as shown above.
5. Pin the resulting public GraphQL URL and immutable deployment ID in the hosted MCP.

The tunnel token grants permission to run the tunnel. Keep it only in the host secret store and
rotate it if it is exposed. A Cloudflare quick tunnel is acceptable for a timed demo but is not a
durable endpoint.

## Indexing model

Registry and Fund history is event-driven. A single configured canary polls on-chain NAV and
holdings every 300 blocks; dynamic Fund templates do not install a block handler per historical
Fund. Controller templates begin when `ControllerSet(agentId, controller, true)` is observed and
snapshot constructor-era policy state directly from chain.

No deploy key, endpoint credential or service secret belongs in this package. Keep them in the root
gitignored `.env` or the production secret manager.
