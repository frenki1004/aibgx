# Quickstart

Two civilizations on a symmetrical island. Each player starts with one city and a small territory. You expand territory to earn gold, build cities to grow your economy, and train three unit types (Soldiers, Archers, Raiders) to fight for map control. Monuments on the map award bonus gold and score to whoever controls them. The game runs for a fixed number of turns; highest score wins. A player also loses immediately if all their cities are captured.

Your bot connects over WebSocket, receives the game state each turn, and responds with a list of actions (move units, build units, expand territory, build cities). See [Game Mechanics](#game-mechanics) for the full rules.

## Prerequisites

- **Node.js 22+** (built-in `WebSocket`, no dependencies needed for bots)

## 1. Start Everything

```bash
bash install_and_start.sh        # Linux / Mac / Git Bash
install_and_start.bat            # Windows
```

This installs server dependencies and launches two components:

- **Game server** (ws://localhost:8080) -- runs the game logic, handles bot connections
- **Frontend server** (http://localhost:3000) -- serves the browser-based spectator UI

Alternatively, after dependencies are installed (`cd server && npm install`), you can start them independently:

```bash
node server/server.js             # Game server (default: blitz, fog on)
node visuals/serve.js             # Frontend server
```

## 2. Open the Viewer

Open `http://localhost:3000` in your browser. It auto-connects as spectator.

## 3. Run Example Bots

```bash
# Terminal 1
node agents/client.js smart 0 MyBot

# Terminal 2
node agents/client.js dumb 1 Opponent
```

Game starts when both teams connect. Format: `node agents/client.js <agent> <team> <name>`

Agents: `dumb` (random), `smart`/`smarter` (heuristic), `smart2` (variant), `econ` (economy-focused).

## 4. Build Your Own Bot

Any language with WebSocket support works. Here is a complete Python bot that connects, authenticates, and plays (requires `pip install websockets`):

```python
import asyncio, json, random
import websockets

SERVER = "ws://localhost:8080"
TEAM = 0        # 0 or 1
NAME = "MyBot"

async def main():
    async with websockets.connect(SERVER) as ws:
        # Authenticate
        await ws.send(json.dumps({
            "type": "AUTH", "password": "player",
            "name": NAME, "preferredTeam": TEAM,
        }))

        team_id = None
        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "AUTH_SUCCESS":
                team_id = msg["teamId"]
                print(f"Connected as team {team_id}")

            elif msg["type"] == "TURN_START":
                actions = generate_actions(msg["state"], team_id)
                await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": actions}))

            elif msg["type"] == "GAME_OVER":
                w = msg["winner"]
                print(f"{'WON' if w == team_id else 'LOST' if w is not None else 'TIE'}")


def generate_actions(state, team_id):
    actions = []
    my_units = [u for u in state["units"] if u["owner"] == team_id]
    my_cities = [c for c in state["cities"] if c["owner"] == team_id]
    player = next(p for p in state["players"] if p["id"] == team_id)
    tiles = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    occupied = {(u["x"], u["y"]) for u in state["units"]}

    # Move each unit to a random valid adjacent tile
    dirs = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
    for unit in my_units:
        if not unit.get("canMove", True):
            continue
        random.shuffle(dirs)
        for dx, dy in dirs:
            tx, ty = unit["x"] + dx, unit["y"] + dy
            tile = tiles.get((tx, ty))
            if tile and tile["type"] == "FIELD" and (tx, ty) not in occupied:
                actions.append({
                    "action": "MOVE",
                    "from_x": unit["x"], "from_y": unit["y"],
                    "to_x": tx, "to_y": ty,
                })
                occupied.discard((unit["x"], unit["y"]))
                occupied.add((tx, ty))
                break

    # Build a soldier at each open city
    for city in my_cities:
        if (city["x"], city["y"]) in occupied:
            continue
        if player["gold"] >= 20:
            actions.append({
                "action": "BUILD_UNIT",
                "city_x": city["x"], "city_y": city["y"],
                "unit_type": "SOLDIER",
            })
            player["gold"] -= 20
            occupied.add((city["x"], city["y"]))

    return actions


asyncio.run(main())
```

Run it with `python mybot.py`. See [Building a Client](#building-a-client) for the full protocol and action reference.

## 5. Server Flags

```bash
node server/server.js --tournament --timeout=3000 --no-fog --port=9090
```

| Flag            | Default | Description                                     |
| --------------- | ------- | ----------------------------------------------- |
| `--port=N`      | `8080`  | WebSocket server port (also via `PORT` env)     |
| `--mode=X`      | `blitz` | `blitz`, `standard`, or `tournament`            |
| `--tournament`  |         | Shorthand for `--mode=tournament`               |
| `--standard`    |         | Shorthand for `--mode=standard`                 |
| `--timeout=N`   | `2000`  | Turn timeout in ms                              |
| `--protected`   | off     | Per-team passwords, no client setting overrides |
| `--no-fog`      | fog on  | Disable fog of war (full information mode)      |
| `--max-saves=N` | `20`    | Max saved replays                               |

## Next Steps

| Document                                | Covers                                              |
| --------------------------------------- | --------------------------------------------------- |
| [Game Mechanics](#game-mechanics)       | Units, combat, economy, scoring, turn phases, fog   |
| [Building a Client](#building-a-client) | Protocol, auth, permissions, actions, bot skeletons |
| [Using the UI](#using-the-ui)           | Spectator, replay, manual play, oversight           |
| [Data & Training](#data-extraction)     | Headless self-play, save harvesting, logic API      |
| [Server Reference](#server-reference)   | Server architecture, CLI flags, message types       |
