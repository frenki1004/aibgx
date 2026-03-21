# Game Mechanics

Two players compete on a tile-based island map. The map is a grid of tiles, each with a terrain type (field, mountain, water, or monument). Field tiles can be owned by a player (territory) or be neutral. Owning territory generates gold income.

Each player starts with one **city** and some surrounding territory. Cities produce gold income, let you build units, and determine how many units you can sustain before upkeep costs grow. You can expand your territory by claiming adjacent neutral tiles, and build additional cities on tiles you own.

There are three **unit** types: Soldiers (melee, capture cities, project zone of control), Archers (ranged attack), and Raiders (fast, plunder enemy territory). They form a hard counter triangle where each type kills one other type in a single hit.

**Monuments** are special impassable tiles on the map. A player controls a monument by having units adjacent to it. The controller receives bonus gold and score each turn.

Both players submit actions simultaneously each turn. After a fixed number of turns, the player with the highest score wins. A player also loses immediately if they lose all their cities.

Fog of war is on by default: each player only sees tiles within their units' and cities' vision range.

## Game Modes

|                   | Standard | Blitz   | Tournament |
| ----------------- | -------- | ------- | ---------- |
| **Map Size**      | 25 x 15  | 15 x 11 | 25 x 23    |
| **Max Turns**     | 200      | 50      | 350        |
| **Starting Gold** | 20       | 50      | 40         |

Server defaults to blitz. Use `--mode=standard` or `--mode=tournament`.

## Map

### Terrain

| Terrain  | Passable | Controllable | Income                      |
| -------- | -------- | ------------ | --------------------------- |
| Field    | Yes      | Yes          | 0.5G / turn                 |
| Mountain | No       | No           | -                           |
| Water    | No       | No           | -                           |
| Monument | No       | No           | See [Monuments](#monuments) |

### Symmetry

All maps use **180-degree point symmetry** around a center tile. Everything at position (x, y) on Player 0's side has a mirror at (W-1-x, H-1-y) on Player 1's side. Both players face identical geography.

### Standard / Blitz

Single-lane island with **1 monument at the map center**. Starting cities on opposite sides.

- **Standard** (25x15): cities at (2, 7) and (22, 7), monument at (12, 7)
- **Blitz** (15x11): cities at (2, 5) and (12, 5), monument at (7, 5)

### Tournament (Competition Format)

The competition uses tournament mode. The map (25x23) has **3 lanes** separated by wavy water rivers, with **2 monuments** in the side lanes.

- **Top lane** (y ~ 0-6): monument at (12, 4)
- **Mid lane** (y ~ 8-14): no monument
- **Bottom lane** (y ~ 16-22): monument at (12, 18)
- **Rivers** at approximately y=7 and y=15, spanning x=6 to x=18
- Starting cities at **(2, 11)** and **(22, 11)**, both in the mid lane
- **Base areas** (x <= 5 and x >= 19) have no rivers, so units can switch between all 3 lanes near their base

### Monuments

Monuments are impassable tiles. Control is determined by adjacent units (Chebyshev distance 1):

- **One team adjacent**: that team controls it
- **Both teams adjacent**: control assigned randomly (50/50)
- **Nobody adjacent**: previous controller keeps it

Each monument's controller receives **3 gold per turn** and **3 score per city on the map** per turn. With 2 monuments (tournament mode), both can be controlled simultaneously by different players.

## Distance

The game uses **Chebyshev distance**: `max(|dx|, |dy|)`. Diagonals cost the same as cardinal moves.

**Distance 1** (8 surrounding tiles, king moves):

```
[1][1][1]
[1][X][1]
[1][1][1]
```

Used for: movement (soldiers, archers), melee range, monument control, territory adjacency.

**Distance 2** (5x5 square, 24 tiles):

```
[2][2][2][2][2]
[2][1][1][1][2]
[2][1][X][1][2]
[2][1][1][1][2]
[2][2][2][2][2]
```

Used for: archer range, soldier Zone of Control, raider movement.

## Units

|                     | Soldier              | Archer                     | Raider               |
| ------------------- | -------------------- | -------------------------- | -------------------- |
| **Cost**            | 20G                  | 25G                        | 15G                  |
| **HP**              | 2                    | 2                          | 1                    |
| **Damage**          | 1                    | 1                          | 1                    |
| **Movement**        | 1                    | 1                          | 2                    |
| **Attack**          | Melee (all adjacent) | Ranged (1 target, range 2) | Melee (all adjacent) |
| **Zone of Control** | Range 2              | -                          | -                    |
| **ZoC Immune**      | Yes                  | No                         | No                   |
| **Captures Cities** | Yes                  | No                         | No                   |
| **Plunder**         | -                    | -                          | 3x3 area, 3G/tile    |
| **Death Score**     | 10                   | 12                         | 3                    |

### Soldier

Projects Zone of Control at range 2. Enemy archers and raiders inside it cannot move. Immune to enemy ZoC. The only unit that can capture cities (move onto an enemy city to take it). Auto-attacks all adjacent enemies in the melee phase.

### Archer

Shoots one enemy per turn within Chebyshev distance 2. Fires in the Archer phase (before movement). Cannot move on turns it shoots. Does not melee. Vulnerable to ZoC.

Target selection: nearest by Manhattan distance, then lowest HP, then random.

### Raider

Movement 2 (Chebyshev). Moves freely through enemy territory (does **not** stop like other units). Each turn, **plunders** a 3x3 area (Chebyshev distance 1) around its position: enemy tiles become neutral, and the raider's owner gains **3G per tile plundered**. Plunder does not affect city tiles. Auto-attacks all adjacent enemies in melee. Cannot capture cities. Vulnerable to ZoC.

## Counter Triangle

Units have damage multipliers against each other:

| Attacker / Target | Soldier | Archer | Raider |
| ----------------- | ------- | ------ | ------ |
| **Soldier**       | 1x      | 1x     | **2x** |
| **Archer**        | **2x**  | 1x     | 1x     |
| **Raider**        | **0x**  | **2x** | 1x     |

- **Soldiers crush raiders**: 2x damage = instant kill (1HP raider)
- **Archers pierce soldiers**: 2x damage = instant kill from range 2 (2HP soldier, takes 2 damage)
- **Raiders assassinate archers**: 2x damage = instant kill in melee (2HP archer, takes 2 damage)
- **Raiders bounce off soldiers**: 0 damage. Soldiers are armored.

Every counter is a **one-shot kill**.

## Turn Phases

Both players submit actions before processing begins. Phases run in this order:

1. **Income** - collect gold from owned tiles (0.5G each) and cities (5G each). Deduct unit upkeep. If gold goes negative, disband cheapest units until solvent.
2. **Archer Fire** - all archers with targets in range fire. Damage applied immediately (sequential, shuffled order). Archers that fire cannot move this turn. Dead units removed.
3. **Movement** - MOVE actions processed. ZoC evaluated once at the start of this phase (pinned units stay pinned even if the enemy soldier moves away later). Move order is interleaved between players (random who goes first). Non-raiders entering enemy territory raid it (tile becomes neutral) and stop. Raiders move freely and plunder 3x3 area. Soldiers capture enemy cities on entry.
4. **Melee** - soldiers and raiders auto-attack all adjacent enemies. Damage is calculated first, then applied simultaneously. Dead units removed.
5. **Build** - BUILD_UNIT, BUILD_CITY, EXPAND_TERRITORY processed. Unit/city builds first, then expand actions interleaved between players (random priority). Gold deducted. New units spawn with `canMove: false`.
6. **Scoring** - monument control determined, monument gold and score awarded, game end conditions checked.

## Combat

All melee damage is **simultaneous**. During Phase 4, all melee hits are calculated first, then applied at once. Two units can kill each other in the same turn.

Archer damage (Phase 2) is **sequential** in a shuffled order. This means an archer can kill a target before another archer shoots it.

### Zone of Control

Soldiers project ZoC at Chebyshev distance 2. Enemy archers and raiders in ZoC cannot move. Soldiers are immune to ZoC. Trapped units can still attack; they just cannot move. ZoC is evaluated once at the start of the movement phase, before any moves are processed.

### Melee

Soldiers and raiders auto-attack **all** adjacent enemies (distance 1) in Phase 4. Not targeted; every adjacent enemy takes damage. Archers do not melee.

## Economy

### Income (Phase 1)

| Source           | Per Turn |
| ---------------- | -------- |
| Owned field tile | 0.5G     |
| City             | 5G       |

### Unit Upkeep

Each city supports **1 unit for free**. Beyond that, upkeep grows geometrically:

```
excess = max(0, total_units - cities * 1)
upkeep = 1.0 * (1.50^excess - 1) / (1.50 - 1)
```

| Excess units | Upkeep/turn |
| ------------ | ----------- |
| 0            | 0G          |
| 1            | 1.0G        |
| 2            | 2.5G        |
| 3            | 4.8G        |
| 4            | 8.1G        |
| 6            | 20.8G       |
| 8            | 49.3G       |
| 10           | 113.3G      |

If gold goes negative, the cheapest units are automatically disbanded until the player is solvent. Upkeep is deducted during the Income phase.

### Expand Territory

**5G** per tile. Target must be neutral, controllable (field), and adjacent to your territory (distance 1). The adjacent territory must be **connected to one of your cities**. Cut-off territory (isolated by enemy raids or captures) cannot be expanded from. Expansions chain within a turn: each new tile counts as your territory for subsequent expansions.

### Build City

**Geometric cost: 80G x 1.5^n** where n = number of cities you have already built (capital does not count). Must be on a field tile you own, with no unit or city on it. Produces 5G/turn.

| Next City | Cost |
| --------- | ---- |
| 1st built | 80G  |
| 2nd built | 120G |
| 3rd built | 180G |
| 4th built | 270G |

### Build Unit

Spawned at your cities. City tile must be unoccupied. New units cannot move on their spawn turn.

| Unit    | Cost |
| ------- | ---- |
| Soldier | 20G  |
| Archer  | 25G  |
| Raider  | 15G  |

## Scoring

| Event            | Score | Recipient |
| ---------------- | ----- | --------- |
| Non-lethal hit   | 5     | Attacker  |
| Lethal hit       | 7     | Attacker  |
| Own Soldier dies | 10    | Owner     |
| Own Archer dies  | 12    | Owner     |
| Own Raider dies  | 3     | Owner     |

Each combat hit awards score to the attacker: 5 for a non-lethal hit, 7 for a hit that kills. These do not stack; a killing blow awards 7, not 5+7. When a unit dies, its owner also gets its death score.

### Monument Rewards

Each controlled monument gives its controller **3 gold per turn** (flat) and **3 score per city on the map** per turn. Gold is flat; score scales with total cities across both players. Both are awarded during the scoring phase.

## Victory Conditions

1. **Score**: highest score after all turns wins
2. **Elimination**: lose all cities and you lose immediately
3. **Tie**: equal scores after all turns

## Fog of War

By default, fog of war is **enabled**. Each player only sees tiles within their vision range. Use `--no-fog` to disable.

### Vision Sources

| Source    | Radius (Chebyshev) |
| --------- | ------------------ |
| Territory | 0 (tile itself)    |
| Soldier   | 2                  |
| Archer    | 3                  |
| Raider    | 2                  |
| City      | 5                  |

### What is Visible

- **Player stats**: always visible (both players' gold, score, and unit counts in `state.players`)
- **Terrain types**: always visible (map layout is public)
- **Monuments**: always visible including controller (tripwire: you always know when an enemy takes your monument, even without vision nearby)
- **Own units/cities/territory**: always visible
- **Enemy units**: hidden outside your vision
- **Enemy cities**: hidden outside your vision
- **Territory ownership**: hidden outside your vision (shows as neutral)

### Server Behavior

When fog is enabled, `state.units`, `state.cities`, and `state.map.tiles[].owner` are **filtered per player**. Bots only receive information within their vision. `state.monuments` is **never filtered**. The state includes `_fogEnabled: true` and `_visibleTiles: ["x,y", ...]`.

Events (COMBAT, DEATH, PLUNDER, etc.) are also filtered. You only see events involving your own units or occurring within your vision.

### Spectators

Spectators see everything (full state). The spectator state includes `_vision0` and `_vision1` arrays showing each player's vision boundaries.
