# Civilization Clash — Game Concept for MCTS Prompt

## Overview
2-player turn-based strategy game. Grid map (25x23 tournament). 350 turns max. Both players submit actions simultaneously each turn. 300ms response time limit. Highest score wins.

## Map
- Terrain: FIELD (passable, ownable), WATER/MOUNTAIN (impassable), MONUMENT (impassable but controllable by adjacent units)
- Tournament layout: 3 lanes separated by rivers, 2 monuments (top/bottom lanes), starting cities on opposite sides
- Fog of war: you only see within vision range of your units/cities/territory

## Units — Hard Counter Triangle
- SOLDIER: cost 20G, HP 2, move 1, melee. Zone of Control radius 2 (pins enemy archers/raiders). Captures cities. Immune to ZoC. Kills RAIDER in 1 hit (2x damage).
- ARCHER: cost 25G, HP 2, move 1, ranged dist 2. Fires BEFORE movement phase, can't move if it shot. Kills SOLDIER in 1 hit (2x damage).
- RAIDER: cost 15G, HP 1, move 2, melee. Plunders 3x3 enemy tiles (tiles go neutral, gains 3G/tile). Kills ARCHER in 1 hit (2x damage). Does 0 damage to soldiers.

Counter: Soldier→Raider, Archer→Soldier, Raider→Archer. All counters are instant kills.

## Actions Per Turn (all submitted simultaneously)
- MOVE: move a unit (soldiers/archers move 1 tile, raiders move up to 2, Chebyshev distance)
- BUILD_UNIT: spawn unit at an empty city (costs gold)
- BUILD_CITY: build city on owned field tile (80G × 1.5^n scaling cost)
- EXPAND_TERRITORY: claim neutral adjacent field tile (5G each, must connect to a city)
- PASS: do nothing

You submit ALL actions at once. Multiple moves, multiple builds, multiple expands — all in one turn.

## Turn Processing Order (simultaneous resolution)
1. Income: collect gold from tiles (0.5G/tile), cities (5G), deduct unit upkeep
2. Archer fire: archers shoot (before any movement happens)
3. Movement: units move, non-raiders entering enemy territory raid it and stop, raiders plunder 3x3
4. Melee combat: soldiers and raiders auto-attack all adjacent enemies (simultaneous damage)
5. Building: units spawn, cities built, territory expanded
6. Scoring: monument control checked, score awarded

## Economy
- Tile income: 0.5G/turn per owned tile
- City income: 5G/turn per city
- Monument income: 3G/turn per controlled monument
- Unit upkeep: 1 free unit per city. Excess costs geometric growth: upkeep = 1.0 × (1.5^excess - 1) / 0.5
- If gold goes negative: cheapest units auto-disband
- Expand cost: 5G per tile
- City cost: 80G × 1.5^n (n = cities already built, capital doesn't count). 1st=80, 2nd=120, 3rd=180

## Scoring
- Dealing damage: 5 points per hit
- Killing a unit: 7 points (replaces the 5)
- Unit death bonus (to owner): Soldier=10, Archer=12, Raider=3
- Monument: 3 points × total_cities_on_map per turn per controlled monument
- Victory: highest score at turn 350 (or instant win if enemy loses all cities)

## Key Strategic Concepts
- Economy phases: expand early, build cities, then army
- Counter-picking: scout enemy composition and build counters
- Zone of Control: soldiers pin archers/raiders at distance 2 — critical for protecting backline
- Raiders flank through side lanes to destroy enemy economy (plunder)
- Monuments are worth exponentially more as cities increase (3 × total_cities per turn)
- Upkeep breakpoints: going from 3 to 4 excess units jumps upkeep significantly

## State Space
- 25×23 grid = 575 tiles, each with: terrain type, owner (null/0/1)
- Up to ~20 units per side, each with: type, position, HP, canMove flag
- Up to ~6 cities per side
- 2 monuments with control state
- Global: gold, score, income per player
- Partial observability (fog of war)

## Action Space Complexity
- Variable-length multi-action turns: 5-50+ actions per turn
- Each unit can move in up to 8 directions (or 24 for raiders)
- Each city can build 1 of 3 unit types or nothing
- Expand frontier can be 10-50+ tiles
- This makes standard single-action MCTS difficult — need to handle action bundles

## Why MCTS is Interesting Here
- Deterministic combat (counter triangle is fixed, not probabilistic)
- Simultaneous actions (both players act at once — need to handle opponent modeling)
- Forward simulation is cheap: the game logic is pure JS, stateless, ~1ms per turn
- Branching factor is huge due to multi-action turns — need smart action sampling
- 300ms budget gives ~300 simulations if each takes ~1ms
- Could combine MCTS with heuristic rollout policy for deeper search
