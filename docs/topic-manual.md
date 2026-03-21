# AIBG X: Civilisation Clash. Topic Manual

Welcome to the tenth edition of BEST Zagreb’s annual Artificial Intelligence Battleground hackathon. As you might have heard, this competition revolves around creating artificial intelligence agents that are used to play a competitive turn-based game for two players. After the programming phase (which lasts for 20 full hours), the agents will face off against each other and the teams that built the 3 highest ranking agents will receive monetary prizes. However, you’re not doing this for the prize alone, as tech company representatives will observe and evaluate your work during the hackathon. Play your proverbial cards right and you might just land a job…

Please read this document in its entirety and pay special attention to section 2, General overview, as it contains explanations of (hopefully) everything relevant about the game’s internal logic. Of course, if you have any questions, or find any bugs, you can ask the topic team, and we’ll try our BEST (pun pun) to answer them.

---

## 1. Game Overview

Two players compete on a symmetrical island map. Each player starts with one city and a small territory. You expand territory to earn gold, build cities to grow your economy, and train units to fight for map control. Monuments on the map award bonus gold and score. After a fixed number of turns, the player with the highest score wins. A player also loses immediately if all their cities are captured.

Fog of war is enabled by default: each player only sees tiles within their units' and cities' vision range.

**Tournament settings**: 25x23 map, 350 turns, 40 starting gold.

---

## 2. Game Mechanics

### 2.1 Map

The map is a grid of tiles, each with a terrain type:

| Terrain  | Passable | Controllable | Income    |
| -------- | -------- | ------------ | --------- |
| Field    | Yes      | Yes          | 0.5G/turn |
| Mountain | No       | No           | None      |
| Water    | No       | No           | None      |
| Monument | No       | No           | Special   |

All maps use **180-degree point symmetry** around the center. Everything at position (x, y) on Player 0's side has a mirror at (W-1-x, H-1-y) on Player 1's side.

**Tournament map (25x23):** The map has 3 lanes separated by wavy water rivers.

- **Top lane** (y 0-6): monument at (12, 4)
- **Mid lane** (y 8-14): no monument
- **Bottom lane** (y 16-22): monument at (12, 18)
- **Rivers** at approximately y=7 and y=15, spanning x=6 to x=18
- Starting cities at **(2, 11)** and **(22, 11)**, both in the mid lane
- **Base areas** (x <= 5 and x >= 19) have no rivers, allowing units to switch between all 3 lanes near their base

### 2.2 Distance

The game uses **Chebyshev distance**: `max(|dx|, |dy|)`. Diagonal moves cost the same as cardinal moves.

- **Distance 1** (8 surrounding tiles): used for movement (soldiers, archers), melee range, monument control, territory adjacency
- **Distance 2** (24 surrounding tiles): used for archer range, soldier Zone of Control, raider movement

### 2.3 Units

|                     | Soldier              | Archer                     | Raider               |
| ------------------- | -------------------- | -------------------------- | -------------------- |
| **Cost**            | 20G                  | 25G                        | 15G                  |
| **HP**              | 2                    | 2                          | 1                    |
| **Damage**          | 1                    | 1                          | 1                    |
| **Movement**        | 1                    | 1                          | 2                    |
| **Attack**          | Melee (all adjacent) | Ranged (1 target, range 2) | Melee (all adjacent) |
| **Zone of Control** | Range 2              | None                       | None                 |
| **ZoC Immune**      | Yes                  | No                         | No                   |
| **Captures Cities** | Yes                  | No                         | No                   |
| **Plunder**         | None                 | None                       | 3x3 area, 3G/tile    |
| **Vision**          | 2                    | 3                          | 2                    |
| **Death Score**     | 10                   | 12                         | 3                    |

**Soldier.** Melee unit. Projects Zone of Control at range 2. Enemy archers and raiders inside ZoC cannot move. Soldiers are immune to enemy ZoC. The only unit that can capture cities (move onto an enemy city to take it). Auto-attacks all adjacent enemies in the melee phase.

**Archer.** Ranged unit. Shoots one enemy per turn within Chebyshev distance 2. Fires in the Archer phase (before movement). Cannot move on turns it shoots. Does not melee. Target selection: nearest by Manhattan distance, then lowest HP, then random. Vulnerable to ZoC.

**Raider.** Fast melee unit. Movement 2 (Chebyshev). Moves freely through enemy territory (does not stop like other units). Each turn, plunders a 3x3 area around its position: enemy tiles become neutral and the raider's owner gains 3G per tile plundered. Plunder does not affect city tiles. Auto-attacks all adjacent enemies in melee. Cannot capture cities. Vulnerable to ZoC.

### 2.4 Counter Triangle

Each unit has base damage of 1, modified by type matchups. The table below shows actual damage dealt and outcome:

| Attacker / Target | Soldier (2 HP)   | Archer (2 HP)    | Raider (1 HP)    |
| ----------------- | ---------------- | ---------------- | ---------------- |
| **Soldier**       | 1 dmg            | 1 dmg            | **2 dmg (kill)** |
| **Archer**        | **2 dmg (kill)** | 1 dmg            | 1 dmg (kill)     |
| **Raider**        | **0 dmg**        | **2 dmg (kill)** | 1 dmg (kill)     |

- **Soldiers crush raiders**: 2 damage kills the 1 HP raider instantly
- **Archers pierce soldiers**: 2 damage kills the 2 HP soldier from range
- **Raiders assassinate archers**: 2 damage kills the 2 HP archer in melee
- **Raiders bounce off soldiers**: 0 damage. Soldiers are armored.

Every counter is a **one-shot kill**. Note that raiders (1 HP) also die to any unmodified 1-damage hit from archers or other raiders.

### 2.5 Turn Phases

Both players submit actions before processing begins. Phases run in this order:

1. **Income.** Collect gold from owned tiles (0.5G each) and cities (5G each). Deduct unit upkeep. If gold goes negative, disband cheapest units until solvent.
2. **Archer Fire.** All archers with targets in range fire. Damage applied immediately (sequential, shuffled order). Archers that fire cannot move this turn. Dead units removed.
3. **Movement.** MOVE actions processed. ZoC evaluated once at the start of this phase (pinned units stay pinned even if the enemy soldier moves away). Move order is interleaved between players (random who goes first). Non-raiders entering enemy territory raid it (tile becomes neutral) and stop. Raiders move freely and plunder a 3x3 area. Soldiers capture enemy cities on entry.
4. **Melee.** Soldiers and raiders auto-attack all adjacent enemies. Damage is calculated first, then applied simultaneously. Dead units removed.
5. **Build.** BUILD_UNIT, BUILD_CITY, EXPAND_TERRITORY processed. Unit and city builds first, then expand actions interleaved between players (random priority). Gold deducted. New units spawn with `canMove: false`.
6. **Scoring.** Monument control determined, monument gold and score awarded, game end conditions checked.

### 2.6 Economy

**Income (Phase 1)**

| Source           | Per Turn |
| ---------------- | -------- |
| Owned field tile | 0.5G     |
| City             | 5G       |

**Unit Upkeep**

Each city supports 1 unit for free. Beyond that, upkeep grows geometrically:

```
excess = max(0, total_units - cities * 1)
upkeep = 1.0 * (1.50^excess - 1) / (1.50 - 1)
```

| Excess Units | Upkeep/Turn |
| ------------ | ----------- |
| 0            | 0G          |
| 1            | 1.0G        |
| 2            | 2.5G        |
| 3            | 4.8G        |
| 4            | 8.1G        |
| 6            | 20.8G       |
| 8            | 49.3G       |
| 10           | 113.3G      |

If gold goes negative, the cheapest units are automatically disbanded until the player is solvent.

**Expand Territory:** 5G per tile. Target must be neutral, controllable (field), and adjacent (distance 1) to your territory. The adjacent territory must be connected to one of your cities. Expansions chain within a turn (each new tile counts for subsequent expansions).

**Build City:** Geometric cost: 80G x 1.5^n, where n is the number of cities you have already built (the capital does not count). Must be on a field tile you own, with no unit or city on it.

| Next City | Cost |
| --------- | ---- |
| 1st built | 80G  |
| 2nd built | 120G |
| 3rd built | 180G |
| 4th built | 270G |

**Build Unit:** Spawned at your cities. City tile must be unoccupied. New units cannot move on their spawn turn.

| Unit    | Cost |
| ------- | ---- |
| Soldier | 20G  |
| Archer  | 25G  |
| Raider  | 15G  |

### 2.7 Combat

All melee damage (Phase 4) is **simultaneous**. All melee hits are calculated first, then applied at once. Two units can kill each other in the same turn.

Archer damage (Phase 2) is **sequential** in a shuffled order. An archer can kill a target before another archer shoots at it.

**Zone of Control.** Soldiers project ZoC at Chebyshev distance 2. Enemy archers and raiders inside ZoC cannot move. Soldiers are immune to ZoC. Trapped units can still attack. ZoC is evaluated once at the start of the movement phase, before any moves are processed.

**Melee.** Soldiers and raiders auto-attack all adjacent enemies (distance 1) in Phase 4. Every adjacent enemy takes damage. Archers do not melee.

### 2.8 Monuments

Monuments are impassable tiles. Control is determined by adjacent units (Chebyshev distance 1):

- **One team adjacent**: that team controls it
- **Both teams adjacent**: control assigned randomly (50/50)
- **Nobody adjacent**: previous controller keeps it

Each monument's controller receives **3 gold per turn** and **3 score per city on the map** per turn. The score scales with total cities across both players. In tournament mode, there are 2 monuments that can be controlled simultaneously by different players.

### 2.9 Scoring

| Event            | Score | Recipient    |
| ---------------- | ----- | ------------ |
| Non-lethal hit   | 5     | Attacker     |
| Lethal hit       | 7     | Attacker     |
| Own soldier dies | 10    | Unit's owner |
| Own archer dies  | 12    | Unit's owner |
| Own raider dies  | 3     | Unit's owner |

A killing blow awards 7 points (not 5+7). When a unit dies, its owner also receives the death score for that unit type.

### 2.10 Fog of War

Fog of war is enabled by default. Each player only sees tiles within their vision range.

**Vision Sources**

| Source    | Radius (Chebyshev) |
| --------- | ------------------ |
| Territory | 0 (tile itself)    |
| Soldier   | 2                  |
| Archer    | 3                  |
| Raider    | 2                  |
| City      | 5                  |

**What is visible:**

- Player stats (gold, score, unit counts) for both players: always visible
- Terrain types (map layout): always visible
- Monuments (including controller): always visible
- Your own units, cities, and territory: always visible

**What is hidden outside your vision:**

- Enemy units
- Enemy cities
- Territory ownership (shows as neutral)

Events are also filtered. You only see events involving your own units or occurring within your vision. Monument events are always visible.

### 2.11 Victory Conditions

1. **Score**: highest score after all turns wins
2. **Elimination**: lose all cities and you lose immediately
3. **Tie**: equal scores after all turns

---

## 3. Getting Started

### Prerequisites

- **Node.js 22+** (built-in WebSocket, no dependencies needed for bots)

### One-Command Setup

```bash
bash install_and_start.sh        # Linux / Mac / Git Bash
install_and_start.bat            # Windows
```

This installs server dependencies and launches two components:

- **Game server** at ws://localhost:8080 (runs game logic, handles bot connections)
- **Frontend server** at http://localhost:3000 (browser-based spectator UI)

### Running Servers Manually

After dependencies are installed (`cd server && npm install`):

```bash
node server/server.js             # Game server (default: blitz, fog on)
node visuals/serve.js             # Frontend server
```

### Server Flags

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

---

## 4. Running Example Bots

### JavaScript

```bash
node agents/client.js <agent> <team> <name>
```

Available agents: `dumb` (random), `smarter` (heuristic), `smart2` (variant), `econ` (economy-focused).

Example (two terminals):

```bash
# Terminal 1
node agents/client.js smart2 0 MyBot

# Terminal 2
node agents/client.js dumb 1 Opponent
```

The game starts when both teams connect.

### Python

Requires `pip install websockets`:

```bash
python agents/python_example.py
```

---

## 5. Building Your Bot

Any language with WebSocket support works. The protocol is JSON over WebSocket.

### 5.1 Connection

Connect to `ws://localhost:8080` (override with `SERVER_URL` environment variable). Authentication password is `player` in open mode. In protected mode (`--protected`), each team has a unique password from `server/passwords.json`.

### 5.2 Authentication

Send immediately after connection opens:

```json
{
  "type": "AUTH",
  "password": "player",
  "name": "MyBot",
  "preferredTeam": 0
}
```

`preferredTeam` is `0` or `1`. The server assigns the requested team if available, otherwise the other. You must authenticate within 5 seconds or the connection is closed.

On success, the server responds:

```json
{
  "type": "AUTH_SUCCESS",
  "teamId": 0,
  "name": "MyBot"
}
```

### 5.3 Game Loop

The game loop works as follows:

1. **Connect** and send AUTH
2. Receive **AUTH_SUCCESS** with your assigned team ID
3. Wait for **GAME_STARTED** (sent when both players connect)
4. Each turn:
   - Receive **TURN_START** with the current game state and timeout
   - Compute your actions
   - Send **SUBMIT_ACTIONS** with your action list
   - Receive **ACTIONS_RECEIVED** confirming which actions passed validation
   - Receive **TURN_RESULT** with updated state and events
5. Receive **GAME_OVER** with the winner and reason

The server auto-restarts a new game after 3 seconds. Keep your bot running. If you miss the turn timeout, the turn processes without your actions.

### 5.4 Submitting Actions

```json
{
  "type": "SUBMIT_ACTIONS",
  "actions": [ ... ]
}
```

Invalid actions are dropped silently. The ACTIONS_RECEIVED response tells you which actions failed and why.

### 5.5 Action Types

**MOVE.** Move a unit to an adjacent tile.

```json
{ "action": "MOVE", "from_x": 3, "from_y": 7, "to_x": 4, "to_y": 7 }
```

Units are identified by position, not by ID. Max distance: 1 for soldiers and archers, 2 for raiders.

**BUILD_UNIT.** Build a unit at one of your cities.

```json
{ "action": "BUILD_UNIT", "city_x": 2, "city_y": 7, "unit_type": "SOLDIER" }
```

Unit types: `SOLDIER` (20G), `ARCHER` (25G), `RAIDER` (15G). City tile must be unoccupied.

**BUILD_CITY.** Build a new city on a tile you own.

```json
{ "action": "BUILD_CITY", "x": 20, "y": 12 }
```

**EXPAND_TERRITORY.** Claim a neutral field tile adjacent to your territory.

```json
{ "action": "EXPAND_TERRITORY", "x": 5, "y": 8 }
```

Costs 5G per tile. Adjacent territory must be connected to one of your cities.

**PASS.** Do nothing. Always valid.

```json
{ "action": "PASS" }
```

### 5.6 Game State

The `state` object in TURN_START and TURN_RESULT contains:

- `turn`, `maxTurns`, `gameOver`, `winner`: turn counter and game status
- `players`: array of both players' stats (id, gold, score, income, name). Always visible, even under fog.
- `map.width`, `map.height`: map dimensions
- `map.tiles`: flat array of all tiles, each with `x`, `y`, `type` (FIELD, MOUNTAIN, WATER, MONUMENT), and `owner` (null, 0, or 1)
- `units`: array of units, each with `x`, `y`, `owner`, `type`, `hp`, `canMove`
- `cities`: array of cities, each with `x`, `y`, `owner`
- `monuments`: array of monuments, each with `x`, `y`, `controlledBy` (never filtered by fog)

When fog is enabled, `units`, `cities`, and tile `owner` values are filtered to your vision. The state also includes `_fogEnabled: true` and `_visibleTiles` (array of `"x,y"` strings).

### 5.7 Further Reference

For the full protocol specification (all message types, event types, bot skeletons in JavaScript and Python), see `docs/building-a-client.md`.

---

## 7. Code Submission

At the end of the 20-hour hackathon, you will need to submit your source code to the provided google drive folder in your perspective folder.

---

## 8. Final Words

We wish you luck! Remember: the first rule of AIBG is to have fun and be yourself!

- AIBG X Topic Team, BEST ZAGREB
