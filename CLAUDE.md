# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## CLAUDE.md Rules

Keep this file clean and useful. When updating:
- **Status section** — update when a feature is completed or a new one is started. Use `[done]` / `[in progress]` / `[todo]`.
- **Current focus** — one short sentence describing what we are actively working on right now.
- **Do not** add implementation detail here — that belongs in code comments or plan files.
- **Do not** duplicate what is already obvious from the code or git log.
- Keep each bullet short enough to scan in under 5 seconds.

---

## Current Focus

Generating MCTS training data on Google Compute Engine (8-core VM `aibg-generator`), then training the NN locally with GPU.

---

## Status

### AI Pipeline
- [done] MCTS engine with macro-actions (`agents/mctsEngine.js`, `agents/macroActions.js`)
- [done] MCTS data generator (`training/mcts-generate.js`)
- [done] NN training script — PyTorch, residual backbone + LayerNorm (`training/train_nn.py`)
- [done] NN agent — pure JS inference, no deps (`agents/nnAgent.js`)
- [done] Self-play loop (`training/self-play-loop.js`)
- [in progress] Data generation on GCE VM — 8 parallel generators running
- [todo] Train NN v1 once ~1000 examples collected
- [todo] Evaluate NN agent vs smarterAgent
- [todo] Self-play iteration loop (NN-guided MCTS → better data → better NN)

### Infrastructure
- [done] Python venv at `venv/` (use `venv/bin/python` for all Python commands)
- [done] Google Cloud project `aibgx-training`, VM `aibg-generator` (europe-west1-b, 8 cores)
- [todo] Automate: copy data from VM → train locally → push new weights

### Agents available
- `dumb` — random moves
- `smarter` — heuristic (baseline, used as MCTS rollout policy)
- `smart2`, `econ` — heuristic variants
- `mcts` — MCTS search at game time (use `MCTS_TIME_MS=250`)
- `nn` — trained NN inference (~1ms/turn, falls back to smarter if no weights)

---

## Training Workflow

```bash
# 1. Generate data (run multiple in parallel, or on GCE VM)
node training/mcts-generate.js 20 tournament 500

# 2. Train (GPU auto-detected)
venv/bin/python training/train_nn.py training/data/mcts_nn_*.jsonl --epochs 100

# 3. Play with trained agent
node agents/client.js nn 0 NNBot

# 4. Full self-play loop (automates 1-3 in iterations)
node training/self-play-loop.js 3 20 500
```

### GCE VM Commands
```bash
# Check data generation progress
gcloud compute ssh aibg-generator --zone=europe-west1-b --project=aibgx-training \
  --command="wc -l ~/aibgx/training/data/mcts_nn_*.jsonl | tail -1 && echo running: \$(pgrep -c -f mcts-generate) generators"

# Copy data back when done
gcloud compute scp --recurse aibg-generator:~/aibgx/training/data/ training/ \
  --zone=europe-west1-b --project=aibgx-training

# SSH in
gcloud compute ssh aibg-generator --zone=europe-west1-b --project=aibgx-training

# Stop VM when done (saves money)
gcloud compute instances stop aibg-generator --zone=europe-west1-b --project=aibgx-training
```

---

## Project Overview

AIBG X — Civilization Clash is a turn-based 2-player strategy game for an AI hackathon. Teams write bots that connect via WebSocket, receive game state each turn, and respond with actions. The game is a civilizational duel: territorial control, economic management, and tactical combat over 350 turns.

---

## Commands

### Setup and Start

```bash
bash install_and_start.sh          # Install deps + start both servers (Linux/Mac)
install_and_start.bat              # Windows
```

After first install, start servers independently:

```bash
cd server && npm install           # One-time dependency install
node server/server.js              # Game server on ws://localhost:8080
node visuals/serve.js              # Frontend on http://localhost:3000
```

### Running Bots

```bash
node agents/client.js <agent> <team> [name]   # agent: dumb, smarter, smart2, econ, mcts, nn
node agents/client.js mcts 0 MCTSBot          # Team 0
node agents/client.js nn 1 NNBot              # Team 1

node agents/run-match.js [agent1] [agent2]    # Spawn both bots (server must be running)

python agents/python_example.py               # Python bot (pip install websockets)
```

### Testing

```bash
cd logic && node --test tests/*.test.js
node --test --watch tests/*.test.js           # Watch mode

cd server && node --test tests/*.test.js
```

### Formatting

```bash
cd server && npm run format         # Prettier (formats all JS/JSON/MD/HTML/CSS)
cd server && npm run format:check   # Check without writing
```

Prettier runs automatically on commit via husky pre-commit hook.

### Server Flags

```bash
node server/server.js --tournament --timeout=3000 --no-fog --port=9090 --max-saves=1000
```

| Flag            | Default      | Description                        |
| --------------- | ------------ | ---------------------------------- |
| `--mode=X`      | `blitz`      | `blitz`, `standard`, `tournament`  |
| `--tournament`  |              | Shorthand for tournament mode      |
| `--timeout=N`   | `2000`       | Turn timeout in ms                 |
| `--no-fog`      | fog on       | Full information mode              |
| `--protected`   | off          | Per-team passwords                 |
| `--port=N`      | `8080`       | WebSocket server port              |
| `--max-saves=N` | `20`         | Max saved replays in server/saves/ |

---

## Architecture

```
Logic (pure JS, zero deps)  →  Server (Node + ws)  →  Clients (bots, browser)
```

### Logic Layer (`logic/`)

- **`processor.js`** — `processTurn(state, {player0, player1})` → `{newState, errors, info}`. Phases: Income → Archer Fire → Movement → Melee → Build → Scoring.
- **`constants.js`** — Unit stats, damage multipliers, economy params, scoring, mode settings, terrain, vision radii.
- **`validation.js`** — `validateAction(state, playerId, action)` and geometry helpers (`isInZoC`, `getConnectedTerritory`, etc.).
- **`map-generator.js`** — Symmetrical island generation. Blitz (15×11), standard (25×15), tournament (25×23 with rivers and monuments).
- **`vision.js`** — `computeVision(state, playerId)` → `Set<"x,y">`.
- **`fog.js`** — `filterStateForPlayer`, `filterEventsForPlayer`. Monuments never filtered.

### Server Layer (`server/`)

- **`server.js`** — WebSocket listener, CLI arg parsing, message routing.
- **`game-manager.js`** — Owns game state, handles timeouts, fog filtering, auto-saves, auto-restart.
- **`connections.js`** — Auth, team assignment, broadcasting.

### Frontend (`visuals/`)

Vanilla JS, Canvas 2D, Tailwind CSS. No build step.

### Agents (`agents/`)

- **`client.js`** — WebSocket bot runner.
- **`mctsEngine.js`** — MCTS with UCB1/PUCT, rollout, NN value head support.
- **`macroActions.js`** — ~15-20 phase-aware macro-action presets (build+expand+move combos).
- **`nnAgent.js`** — Pure JS NN inference. Dual-path: residual backbone (new weights) or legacy backbone (old weights).

---

## Key Concepts

**Turn phases:** Income → Archer Fire → Movement → Melee → Build → Scoring

**Counter triangle:** Soldiers > Raiders > Archers > Soldiers (2× damage = one-shot kill)

**Zone of Control:** Enemy Soldiers freeze adjacent Archers and Raiders.

**Fog of war:** State filtered per player by vision before sending.

**Game modes:** `blitz` (small, fast), `standard`, `tournament` (3-lane, 25×23, used in competition).
