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

Econ agent parallel training infrastructure done. Original weights held up after 30-game run (already well-optimized from novi). Next: longer run or targeted param search.

---

## Status

### AI Pipeline
- [done] MCTS engine with macro-actions (`agents/mctsEngine.js`, `agents/macroActions.js`)
- [done] MCTS data generator — inline games (`training/mcts-generate.js`)
- [done] NN architecture — residual backbone + LayerNorm, auto input_dim (`training/train_nn.py`)
- [done] NN agent — pure JS inference + data capture mode (`agents/nnAgent.js`, `agents/mctsNNAgent.js`)
- [done] Eval harness — JS vs Python + JS vs JS (`training/eval-match.js`)
- [done] AlphaZero loop — bootstrap vs hybrid, then self-play iters (`training/alphazero-loop.js`)
- [in progress] Bootstrap: 8/20 games done, 442 examples in `training/data/iter_0/`
- [todo] Complete bootstrap → train nn_v0 → 5 self-play iterations

### Econ Param Tuning
- [done] Parallel training orchestrator — 2 workers, independent weight evolution (`training/train-econ.js`)
- [done] Head-to-head eval harness — 2 weight files, N games (`training/eval-econ.js`)
- [done] econ_example.py supports env var file paths (`ECON_WEIGHTS_FILE`, `ECON_BEST_FILE`, `ECON_HISTORY_FILE`)
- [done] 30-game run: 90% win rate both workers; original weights remain best (strong baseline from novi)
- [todo] Longer run (200+ games) or targeted grid search to beat the baseline

### AlphaZero Loop Design
- **Bootstrap (iter 0):** MCTS (no NN) vs hybrid Python bot → data → train `nn_v0.json`
- **Iterations 1–5:** MCTS+NN_prev self-play → data (this iter only, no accumulation) → train `nn_vN.json` → eval new vs prev + vs hybrid
- Data written live during games via `WRITE_DATA` env var in `mctsNNAgent.js`
- Models saved as `training/models/nn_v0.json`, `nn_v1.json`, etc.

### NN Architecture
- Input: 520 features (auto-detected from data)
- Backbone: `input_proj(520→256)` → `ResBlock×3(256)` → `output_proj(256→128)`
- Heads: build (6×4), move (20×9), expand (16), city (binary), value (win prob)
- Python venv at `venv/` — always use `venv/bin/python` for training

### Agents available
- `dumb` — random moves
- `smarter` — heuristic (baseline, used as MCTS rollout policy)
- `smart2`, `econ` — heuristic variants
- `mcts` — MCTS search at game time
- `nn` — trained NN inference (~1ms/turn)
- `mctsnn` — MCTS + NN value function (main competition bot)

---

## Training Workflow

### AlphaZero Loop (main workflow)
```bash
# Resume bootstrap (already 8/20 games done — loop skips existing files)
node training/alphazero-loop.js --bootstrap=20 --games=5 --sims=200 --workers=4 --iters=5 2>&1 | tee /tmp/alphazero.log

# Tail in another terminal
tail -f /tmp/alphazero.log

# If nn_v0.json already exists, skip bootstrap:
node training/alphazero-loop.js --bootstrap=20 --games=5 --sims=200 --workers=4 --iters=5 --skip-bootstrap 2>&1 | tee /tmp/alphazero.log
```

### Manual steps (one-off)
```bash
# Train on a specific iter's data only
venv/bin/python training/train_nn.py training/data/iter_0/*.jsonl --epochs 100 --output training/models/

# Eval current NN vs hybrid
node training/eval-match.js --vs=hybrid --games=4 --weights=training/models/nn_v0.json

# Eval new NN vs previous NN
node training/eval-match.js --vs=nn --games=4 --weights=training/models/nn_v1.json --prev-weights=training/models/nn_v0.json

# Play with the latest NN
NN_WEIGHTS=training/models/nn_v1.json node agents/client.js mctsnn 0 NNBot
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
