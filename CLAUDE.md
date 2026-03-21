# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AIBG X — Civilization Clash is a turn-based 2-player strategy game for an AI hackathon. Teams write bots that connect via WebSocket, receive game state each turn, and respond with actions. The game is a civilizational duel: territorial control, economic management, and tactical combat over 350 turns.

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
node agents/client.js <agent> <team> [name]   # agent: dumb, smart, smarter, smart2, econ
node agents/client.js smart 0 MyBot           # Team 0
node agents/client.js dumb 1 Opponent         # Team 1

node agents/run-match.js [agent1] [agent2]    # Spawn both bots (server must be running)

python agents/python_example.py               # Python bot (pip install websockets)
```

### Testing

```bash
# Logic tests (no dependencies needed)
cd logic && node --test tests/*.test.js
node --test --watch tests/*.test.js           # Watch mode

# Server tests
cd server && node --test tests/*.test.js
```

### Formatting

```bash
cd server && npm run format         # Prettier (formats all JS/JSON/MD/HTML/CSS)
cd server && npm run format:check   # Check without writing
```

Prettier runs automatically on commit via husky pre-commit hook.

### Headless Simulation (no server)

```bash
# Run a match directly via logic (JS)
node agents/run-match.js dumb smart   # Requires server running

# Pure headless (no server, no WebSocket):
# Use logic/index.js directly — see docs/data-extraction.md
```

### Server Flags

```bash
node server/server.js --tournament --timeout=3000 --no-fog --port=9090 --max-saves=1000
```

| Flag            | Default      | Description                       |
| --------------- | ------------ | --------------------------------- |
| `--mode=X`      | `blitz`      | `blitz`, `standard`, `tournament` |
| `--tournament`  |              | Shorthand for tournament mode     |
| `--timeout=N`   | `2000`       | Turn timeout in ms                |
| `--no-fog`      | fog on       | Full information mode             |
| `--protected`   | off          | Per-team passwords, no overrides  |
| `--port=N`      | `8080`       | WebSocket server port             |
| `--max-saves=N` | `20`         | Max saved replays in server/saves/|

## Architecture

Three independent layers:

```
Logic (pure JS, zero deps)  →  Server (Node + ws)  →  Clients (bots, browser)
```

### Logic Layer (`logic/`)

Stateless pure functions, no dependencies, no Node built-ins beyond what `node --test` needs.

- **`processor.js`** — `processTurn(state, {player0, player1})` → `{newState, errors, info}`. Runs 6 phases: Income → Archer Fire → Movement → Melee → Build → Scoring. Does **not** mutate input.
- **`constants.js`** — All game constants: unit stats, damage multipliers, economy params, scoring, mode settings (`MODES.blitz/standard/tournament`), terrain, vision radii.
- **`validation.js`** — `validateAction(state, playerId, action)` and geometry helpers (`isInZoC`, `getConnectedTerritory`, `isAdjacentToOwnTerritory`, etc.).
- **`map-generator.js`** — Symmetrical island generation via Perlin noise. Three modes: blitz (15×11), standard (25×15), tournament (25×23 with rivers and monuments).
- **`vision.js`** — `computeVision(state, playerId)` → `Set<"x,y">` from units, cities, and territory.
- **`fog.js`** — `filterStateForPlayer` and `filterEventsForPlayer`: removes info outside vision. Monuments are never filtered.
- **`index.js`** — Re-exports everything. Use `require('./logic')` or `require('../logic')`.

### Server Layer (`server/`)

- **`server.js`** — WebSocket listener, CLI arg parsing, message routing. Defines all message type constants (`AUTH`, `TURN_START`, `SUBMIT_ACTIONS`, `GAME_OVER`, etc.).
- **`game-manager.js`** — Owns game state. Calls `createInitialState()` and `processTurn()`. Handles timeouts (default 2s), fog filtering, auto-saves to `server/saves/`, auto-restart (3s after game over), pause/resume, and oversight mode.
- **`connections.js`** — Auth, team assignment, broadcasting. Supports open mode (shared password) and protected mode (per-team passwords from `passwords.json`). Methods: `send`, `broadcast`, `sendToTeam`, `broadcastToSpectators`, `sendToOversight`.
- **`passwords.json`** — Auth passwords for players, spectator, oversight, and per-team protected mode.

### Frontend (`visuals/`)

Vanilla JS, Canvas 2D, Tailwind CSS. No build step.

- **`app.js`** — WebSocket connection to game server, state management, mode switching (spectator / manual play / oversight / replay).
- **`canvas/renderer.js`** — Isometric rendering, fog visualization, vision borders. Keys 1/2/3 switch fog view modes.
- **`canvas/isometric.js`** — Coordinate math for 64×32 isometric tiles, zoom, pan.
- **`game/manual-play.js`** / **`game/oversight.js`** — Human play and bot action review modes.
- **`game/pathfinding.js`** — Client-side pathfinding for manual play.

### Agents (`agents/`)

- **`client.js`** — WebSocket bot runner: `node agents/client.js <agent> <team> [name]`. Loads agent module, handles AUTH/TURN_START/GAME_OVER.
- **`run-match.js`** — Spawns two `client.js` processes. Requires server already running.
- Agent modules (`dumbAgent`, `smarterAgent`, `smart2Agent`, `econAgent`) each export a function `(state, teamId) → actions[]`.

## Key Concepts

**Turn phases (in order):** Income → Archer Fire → Movement → Melee → Build → Scoring

**Unit counter triangle:** Soldiers crush Raiders → Raiders assassinate Archers → Archers pierce Soldiers. Each counter is a one-shot kill (2× damage).

**Zone of Control (ZoC):** Enemy Soldiers freeze adjacent Archers and Raiders — checked in `validation.js:isInZoC`.

**Fog of war:** Each player's state is filtered by vision before being sent. The logic layer's `filterStateForPlayer` is called by the server; for headless simulation, call it manually.

**Game modes:** `blitz` (default, small map, fast), `standard`, `tournament` (3-lane map with rivers, 25×23, used in competition).

## Headless Self-Play

The `logic/` module works standalone without a server. Full API in `docs/data-extraction.md`. For cross-language simulation, `logic/simulate.js` (described in that doc) provides a JSON-lines stdin/stdout bridge.
