# AIBG - Civilization Clash

Turn-based 2-player strategy game for the 10th edition of **Artificial Intelligence Battleground (AIBG)**, a 20-hour hackathon organised by BEST Zagreb, 2026. Teams compete by writing bots that connect over WebSocket, receive the game state each turn, and respond with actions. This edition the topic is a civilizational duel. Two civilizations clash on a symmetrical island map through territorial control, economic management, and tactical combat. Every civilization has it's own perspective. Will your bot be the ultimate civilization and dominate the rest?

## Game Overview

The competition uses tournament mode: a 25x23 map with 3 lanes separated by water rivers and 2 monuments in the side lanes. Both players start with one city in the mid lane. Fog of war is on by default, you only see tiles near your units and cities.

Owned territory generates 0.5 gold per tile per turn; cities produce 5 gold per turn. You spend gold to expand territory (5G/tile), build new cities (80G, scaling x1.5 each), and train units. Unit upkeep grows geometrically past 1 free unit per city.

Three types form a hard counter triangle where every counter is a one-shot kill:

- **Soldiers** (20G) melee, 2 HP. Project Zone of Control that freezes enemy archers and raiders. The only unit that captures cities. Crush raiders (2x), bounce off archers (take 2x damage).
- **Archers** (25G) ranged (distance 2), 2 HP. Fire before movement, cannot move on turns they shoot. Pierce soldiers (2x), vulnerable to raiders in melee.
- **Raiders** (15G) fast (movement 2), 1 HP. Plunder enemy territory for gold (3G/tile, 3x3 area). Assassinate archers (2x), deal 0 damage to soldiers.

Both players submit actions simultaneously. Each turn processes 6 phases in order: Income, Archer Fire, Movement, Melee, Build, Scoring. The game runs for 350 turns.

Victory: Highest score wins. Monuments award bonus gold and score to whoever controls them. A player also loses immediately if all their cities are captured.

See [Game Mechanics](docs/game-mechanics.md) for the full rules.

## Quick Start

```bash
# Install dependencies and start both servers
bash install_and_start.sh          # Linux/Mac/Git Bash
install_and_start.bat              # Windows

# Connect two bots (in separate terminals)
node agents/client.js dumb 0 # terminal 1
node agents/client.js smart 1 # terminal 2

# Open the frontend
# http://localhost:3000
```

The game starts automatically when both players connect. The server auto-restarts new games after each one finishes.

## Running Example Bots

```bash
# JavaScript
node agents/client.js [agent] [team] [name]
node agents/client.js smarter 0 MyBot

# Python (pip install websockets)
python agents/python_example.py
```

Any language with WebSocket support works. See [Building a Client](docs/building-a-client.md) for the full JSON protocol and bot skeletons.

## Server Flags

```bash
node server/server.js [flags]
```

| Flag           | Default | Description                       |
| -------------- | ------- | --------------------------------- |
| `--mode=X`     | `blitz` | `blitz`, `standard`, `tournament` |
| `--tournament` |         | Shorthand for tournament mode     |
| `--no-fog`     | fog on  | Disable fog of war                |
| `--timeout=N`  | `2000`  | Turn timeout in ms                |
| `--protected`  | off     | Per-team passwords, no overrides  |

See [Server Reference](docs/server-reference.md) for the full list.

## Project Structure

```
Civilisation-Clash/
├── install_and_start.sh/.bat  # One-command setup and launch
├── logic/                     # Game engine (standalone, zero dependencies)
│   ├── index.js               # Main exports
│   ├── constants.js            # All game constants (unit stats, economy, scoring)
│   ├── processor.js            # Turn processing (6 phases)
│   ├── validation.js           # Action validation + geometry helpers
│   ├── map-generator.js        # Map generation (standard/blitz/tournament)
│   ├── vision.js               # Fog of war vision computation
│   ├── fog.js                  # State/event filtering for fog
│   ├── terminal.js             # ASCII state rendering
│   └── tests/                  # Unit tests
├── server/                     # WebSocket game server
│   ├── server.js               # WebSocket listener + message router
│   ├── game-manager.js         # Game lifecycle, turns, saves, fog
│   ├── connections.js          # Auth, broadcasting, per-team messaging
│   ├── passwords.json          # Auth passwords
│   └── saves/                  # Auto-saved game replays
├── agents/                     # Bot clients
│   ├── client.js               # WebSocket bot runner (JS)
│   ├── python_example.py       # Example bot (Python)
│   ├── dumbAgent.js            # Random-move bot
│   ├── smarterAgent.js         # Smarter bot
│   └── ...                     # Other agent strategies
├── visuals/                    # Browser-based frontend
│   ├── serve.js                # Static file server (node visuals/serve.js)
│   ├── index.html              # Main page
│   ├── js/                     # App logic, canvas renderer, UI panels
│   ├── css/                    # Tailwind + custom styles
│   └── assets/                 # Unit sprites, icons
└── docs/                       # Documentation
    ├── quickstart.md            # Setup and first game
    ├── game-mechanics.md        # Game rules and mechanics
    ├── building-a-client.md     # WebSocket protocol + bot building
    ├── architecture.md          # Repository structure
    ├── server-reference.md      # Server internals + CLI flags
    ├── data-extraction.md       # Headless play + save harvesting
    └── using-the-ui.md          # Spectator, replay, manual play
```

## Documentation

| Document                                       | Contents                                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| [Quickstart](docs/quickstart.md)               | Setup, run bots, server flags                                  |
| [Game Mechanics](docs/game-mechanics.md)       | Rules, units, combat, economy, fog of war                      |
| [Building a Client](docs/building-a-client.md) | WebSocket protocol, auth, actions, events, bot skeletons       |
| [Repository Structure](docs/architecture.md)   | File map, architecture, per-file descriptions                  |
| [Using the UI](docs/using-the-ui.md)           | Spectator, manual play, oversight, replay, keyboard shortcuts  |
| [Server Reference](docs/server-reference.md)   | Server architecture, CLI flags, message types                  |
| [Data Extraction](docs/data-extraction.md)     | Headless simulation, cross-language self-play, save harvesting |

## License [![CC BY-NC-SA 4.0][cc-by-nc-sa-shield]][cc-by-nc-sa]

[cc-by-nc-sa]: http://creativecommons.org/licenses/by-nc-sa/4.0/
[cc-by-nc-sa-image]: https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png
[cc-by-nc-sa-shield]: https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-cyan.svg

This work is licensed under a
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License][cc-by-nc-sa].

## Development

Developed with <3 by **BEST Zagreb** for our _(AIBG X)_ (2016) event!
