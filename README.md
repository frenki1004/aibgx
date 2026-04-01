# AIBG X: Civilization Clash

> Solutions by **Sinovi Broda** for the 10th edition of **Artificial Intelligence Battleground (AIBG)** — a 20-hour hackathon organised by [BEST Zagreb](https://best.hr/), 2026.

## What is AIBG?

AIBG (Artificial Intelligence Battleground) is an annual hackathon by BEST Zagreb where teams compete by writing bots that play a competitive game. After a 20-hour programming phase, the bots face off in a tournament. Tech company representatives observe and evaluate the teams during the event.

## The Game: Civilization Clash

This year's topic was a **turn-based 2-player strategy game** on a tile-based island map. Two civilizations clash through territorial control, economic management, and tactical combat.

**Key mechanics:**
- **Map**: 25x23 grid with 3 lanes separated by water rivers and 2 monuments in the side lanes
- **Economy**: Owned territory generates gold; cities produce income; gold is spent on expansion, cities, and units
- **Units**: Three types forming a hard counter triangle — Soldiers (melee, capture cities), Archers (ranged), Raiders (fast, plunder territory)
- **Fog of war**: Each player only sees tiles near their units and cities
- **Victory**: Highest score after 350 turns wins, or eliminate all enemy cities for an instant win

Both players submit actions simultaneously each turn. Bots connect over WebSocket, receive the game state, and respond with actions.

For the full rules, see [docs/game-mechanics.md](docs/game-mechanics.md) and [docs/topic-manual.md](docs/topic-manual.md).

## Branches

The [`master`](../../tree/master) branch contains the **game platform** — the complete game engine, WebSocket server, spectator frontend, documentation, and example bots. I built this as part of the AIBG X topic team. All bot solutions branch off from it.

We explored three distinct approaches, each tackling the problem from a different angle.

### `simun` — AlphaZero-style MCTS + Neural Network

**Branch:** [`simun`](../../tree/simun)

An AlphaZero-inspired self-improving loop combining Monte Carlo Tree Search with a lightweight neural network.

**How it works:**
1. **MCTS Engine** runs 200–500 simulations per turn using macro-actions (~30–50 strategic turn templates like "economy mode" or "soldier push") to keep the branching factor manageable
2. **Neural Network** (~380K params) — a multi-head MLP trained on MCTS expert data, outputting 5 decision heads: unit builds, move directions, expansion count, city builds, and win probability
3. **Self-improvement loop**: MCTS generates expert data → NN trains on it → NN guides better MCTS → repeat
4. **Deployment**: The trained NN runs pure policy inference at ~1ms per turn (no search needed at game time)

Key files: `agents/mctsEngine.js`, `agents/nnAgent.js`, `training/train_nn.py`, `agents/macroActions.js`

---

### `fabijan` — MCTS + Residual NN on Cloud

**Branch:** [`fabijan`](../../tree/fabijan)

A similar MCTS + neural network pipeline, but with a heavier training setup targeting Google Cloud VMs for data generation.

**How it works:**
1. **MCTS with PUCT** (AlphaZero-style selection) using macro-actions to reduce the action space
2. **Residual neural network** (~439K params) with LayerNorm, trained on self-play data generated in bulk on cloud infrastructure
3. **Data generation**: Parallelized MCTS self-play producing thousands of training examples (state, visit distributions, outcomes)
4. **Pure JS inference** at runtime — no Python dependencies needed for the deployed bot

Key files: `agents/mctsEngine.js`, `agents/nnAgent.js`, `training/train_nn.py`, `training/mcts-generate.js`

---

### `novi` — Evolutionary Multi-Strategy Bots (Python)

**Branch:** [`novi`](../../tree/novi)

A completely different approach: three hand-crafted bot personalities trained via evolutionary weight optimization.

**The three strategies:**
- **Aggressive** — floods the map with soldiers, pins enemies via zone-of-control, captures cities relentlessly
- **Economic** — prioritizes city building and monument control for gold income, uses raiders for plundering
- **Hybrid** — adapts dynamically between modes (DEFEND / FINISH / PRESSURE / CONTEST / GREED) based on game state

**How training works:**
- Each bot scores moves using weighted heuristics (forward pressure, enemy engagement, city threats, monument control, etc.)
- An automated training harness runs games against rotating opponents (smart, smart2, smarter, econ, dumb)
- Weights that maintain >55% win-rate are kept; underperformers are mutated via Gaussian mutation (σ=0.12)
- Best weights are preserved in `*_best_weights.json`

Key files: `agents/aggressive_example.py`, `agents/econ_example.py`, `agents/hybrid_example.py`, `train.py`

## Running the Project

```bash
# Install dependencies and start game + frontend servers
bash install_and_start.sh          # Linux / Mac / Git Bash
install_and_start.bat              # Windows

# Connect two bots (separate terminals)
node agents/client.js dumb 0       # Terminal 1
node agents/client.js smarter 1    # Terminal 2

# Open the frontend at http://localhost:3000
```

See [docs/quickstart.md](docs/quickstart.md) for full setup instructions, and [docs/building-a-client.md](docs/building-a-client.md) for the WebSocket protocol.

## Project Structure

```
├── agents/          # Bot clients (JS + Python)
├── logic/           # Game engine (standalone, zero dependencies)
├── server/          # WebSocket game server
├── training/        # NN training pipeline + data generation
├── visuals/         # Browser-based spectator frontend
└── docs/            # Full documentation
```

## License

[![CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-cyan.svg)](http://creativecommons.org/licenses/by-nc-sa/4.0/)

The game platform is licensed under [CC BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/), developed by **BEST Zagreb** for AIBG X (2026).
