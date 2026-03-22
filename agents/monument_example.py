"""
MonumentBot — Monument Fortress strategy.

Unusual twist: everything revolves around the monuments.

Core idea:
  1. RUSH      — sprint soldiers straight to both monuments on turn 1, ignore economy
  2. FORTRESS  — monuments held; build cities adjacent to monuments for fortified income;
                 garrison with archers (range 2, hard to dislodge)
  3. CONTEST   — monument(s) lost; all available units converge to recapture, ignore expansion
  4. SIEGE     — both monuments held for 30+ turns; enough army to threaten enemy cities

Why this beats standard bots:
  - Each monument is worth ~20 score/turn.  Hold both for 250 turns = 5,000 bonus points.
  - Cities adjacent to monuments are very hard to take (defended by monument garrison).
  - Archers at the monument can fire on anything trying to contest it without moving.
  - Raiders plunder deep while archers and soldiers hold the monument cluster.

Files written next to this script:
  monument_weights.json      — current weights being tested
  monument_best_weights.json — best weights found so far
  monument_history.json      — per-game results log
"""

import asyncio, json, os, random, math
from collections import deque

SERVER_URL = os.environ.get("SERVER_URL", "ws://localhost:8080")
PASSWORD   = os.environ.get("PASSWORD", "player")
TEAM       = int(os.environ.get("TEAM", "0"))
NAME       = os.environ.get("BOT_NAME", "MonumentBot")
OPPONENT   = os.environ.get("OPPONENT", "unknown")

team_id = None

EVAL_EVERY     = 5
MUTATION_SIGMA = 0.15
HISTORY_WINDOW = 30

UNIT_COSTS    = {"SOLDIER": 20, "ARCHER": 25, "RAIDER": 15}
UNIT_MOVEMENT = {"SOLDIER": 1,  "ARCHER": 1,  "RAIDER": 2}
UNIT_MAX_HP   = {"SOLDIER": 2,  "ARCHER": 2,  "RAIDER": 1}
ADJ = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]

COUNTER = {"SOLDIER": "ARCHER", "ARCHER": "RAIDER", "RAIDER": "SOLDIER"}

LETHAL_THREATS = {
    "SOLDIER": {"ARCHER"},
    "ARCHER":  {"RAIDER"},
    "RAIDER":  {"ARCHER"},
}

SCRIPT_DIR         = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_FILE       = os.path.join(SCRIPT_DIR, "monument_weights.json")
BEST_WEIGHTS_FILE  = os.path.join(SCRIPT_DIR, "monument_best_weights.json")
HISTORY_FILE       = os.path.join(SCRIPT_DIR, "monument_history.json")

DEFAULT_WEIGHTS = {
    "w_monument_rush":      40.0,
    "w_monument_guard":     30.0,
    "w_monument_ring":      12.0,
    "w_forward":             5.0,
    "w_enemy_city":         22.0,
    "w_city_capture":      110.0,
    "w_raid_tile":           7.0,
    "w_plunder":            10.0,
    "w_archer_range":        6.0,
    "w_city_near_monument":  5.0,
    "archers_per_monument":  2.0,
    "soldiers_per_monument": 2.0,
    "raiders_per_monument":  0.5,
    "max_cities":            5.0,
    "gold_buffer":          28.0,
}

WEIGHT_SANITY = {
    "w_monument_rush":      (20,  60),
    "w_monument_guard":     (15,  50),
    "w_monument_ring":      (5,   25),
    "w_forward":            (2,   12),
    "w_enemy_city":         (10,  35),
    "w_city_capture":       (80, 150),
    "w_raid_tile":          (3,   15),
    "w_plunder":            (5,   20),
    "w_archer_range":       (3,   12),
    "w_city_near_monument": (2,   12),
    "archers_per_monument": (1,    4),
    "soldiers_per_monument":(1,    4),
    "raiders_per_monument": (0,    2),
    "max_cities":           (2,    7),
    "gold_buffer":          (20,  50),
}


def _clamp_weights(w: dict) -> dict:
    for k, (lo, hi) in WEIGHT_SANITY.items():
        if k in w:
            w[k] = max(lo, min(hi, w[k]))
    return w


def load_weights() -> dict:
    if os.path.exists(WEIGHTS_FILE):
        try:
            with open(WEIGHTS_FILE) as f:
                w = json.load(f)
            for k, v in DEFAULT_WEIGHTS.items():
                w.setdefault(k, v)
            return _clamp_weights(w)
        except Exception:
            pass
    return dict(DEFAULT_WEIGHTS)


def save_weights(w: dict):
    with open(WEIGHTS_FILE, "w") as f:
        json.dump(_clamp_weights(w), f, indent=2)


def load_best_weights() -> dict:
    if os.path.exists(BEST_WEIGHTS_FILE):
        try:
            with open(BEST_WEIGHTS_FILE) as f:
                w = json.load(f)
            for k, v in DEFAULT_WEIGHTS.items():
                w.setdefault(k, v)
            return _clamp_weights(w)
        except Exception:
            pass
    return dict(DEFAULT_WEIGHTS)


def save_best_weights(w: dict):
    with open(BEST_WEIGHTS_FILE, "w") as f:
        json.dump(_clamp_weights(w), f, indent=2)


def load_history() -> list:
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return []


def save_history(h: list):
    with open(HISTORY_FILE, "w") as f:
        json.dump(h, f, indent=2)


def filter_by_opponent(history: list, window: int) -> list:
    tagged = [g for g in history if g.get("opponent") == OPPONENT]
    if len(tagged) >= window // 2:
        return tagged[-window:]
    return history[-window:]


def compute_fitness(history: list, window: int) -> float:
    recent = filter_by_opponent(history, window)
    if not recent:
        return 0.0
    return sum(g["score_delta"] for g in recent) / len(recent)


def win_rate(history: list, window: int) -> float:
    recent = filter_by_opponent(history, window)
    if not recent:
        return 0.5
    return sum(1 for g in recent if g["outcome"] == "win") / len(recent)


def mutate(w: dict, sigma: float = MUTATION_SIGMA) -> dict:
    new_w = {}
    for k, v in w.items():
        noise = random.gauss(0, abs(v) * sigma + 0.5)
        if k in ("max_cities",):
            new_w[k] = max(1.0, v + noise)
        elif k in ("archers_per_monument", "soldiers_per_monument", "raiders_per_monument"):
            new_w[k] = max(0.0, v + noise)
        else:
            new_w[k] = max(0.0, v + noise)
    return new_w


def maybe_evolve(history: list, weights: dict, best_weights: dict) -> tuple:
    n = len(history)
    if n == 0 or n % EVAL_EVERY != 0:
        return weights, best_weights

    wr      = win_rate(history, HISTORY_WINDOW)
    fitness = compute_fitness(history, HISTORY_WINDOW)
    prev_fitness = compute_fitness(history[:-EVAL_EVERY], HISTORY_WINDOW)

    if fitness > prev_fitness:
        best_weights = dict(weights)
        save_best_weights(best_weights)

    adaptive_sigma = MUTATION_SIGMA * (1.0 + max(0.0, -fitness) / 5000.0)
    adaptive_sigma = min(adaptive_sigma, MUTATION_SIGMA * 3.0)

    new_w = mutate(best_weights, sigma=adaptive_sigma)
    save_weights(new_w)
    print(f"{'win' if wr >= 0.5 else 'loss'.upper()} Δ{fitness:+.0f} wr={wr:.0%} games={n}")
    return new_w, best_weights


WEIGHTS      = load_weights()
best_weights = load_best_weights()
history      = load_history()
_game_stats  = {"monument_turns": 0, "peak_territory": 0}


# ── helpers ────────────────────────────────────────────────────────────────────

def chebyshev(x1, y1, x2, y2):
    return max(abs(x1 - x2), abs(y1 - y2))


def compute_upkeep(n_units, n_cities):
    excess = max(0, n_units - n_cities)
    return 0.0 if excess == 0 else 2.0 * (1.5 ** excess - 1)


def estimate_gold(state, my_team):
    player   = next(p for p in state["players"] if p["id"] == my_team)
    n_tiles  = sum(1 for t in state["map"]["tiles"] if t.get("owner") == my_team)
    n_cities = sum(1 for c in state["cities"] if c["owner"] == my_team)
    n_units  = sum(1 for u in state["units"] if u["owner"] == my_team)
    income   = n_tiles * 0.5 + n_cities * 5.0
    upkeep   = compute_upkeep(n_units, n_cities)
    return player["gold"] + income - upkeep


def enemy_side_x(state, my_team):
    W  = state["map"]["width"]
    cx = W // 2
    my_cities = [c for c in state["cities"] if c["owner"] == my_team]
    if not my_cities:
        return W - 1 if my_team == 0 else 0
    cap = min(my_cities, key=lambda c: abs(c["x"] - cx))
    return W - 1 if cap["x"] < cx else 0


def connected_territory(state, my_team):
    tile_lut = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    visited, queue = set(), []
    for c in state["cities"]:
        if c["owner"] == my_team:
            pos = (c["x"], c["y"])
            visited.add(pos)
            queue.append(pos)
    while queue:
        x, y = queue.pop()
        for dx, dy in ADJ:
            nb = (x + dx, y + dy)
            if nb in visited:
                continue
            t = tile_lut.get(nb)
            if t and t.get("owner") == my_team:
                visited.add(nb)
                queue.append(nb)
    return visited


def bfs_distances(tile_lut, W, H, targets):
    """BFS from targets across FIELD tiles; returns distance map."""
    dist = {}
    queue = deque()
    for tx, ty in targets:
        if (tx, ty) not in dist:
            dist[(tx, ty)] = 0
            queue.append((tx, ty))
    while queue:
        x, y = queue.popleft()
        for dx, dy in ADJ:
            nx, ny = x + dx, y + dy
            if (nx, ny) in dist:
                continue
            if not (0 <= nx < W and 0 <= ny < H):
                continue
            tile = tile_lut.get((nx, ny))
            if tile and tile["type"] == "FIELD":
                dist[(nx, ny)] = dist[(x, y)] + 1
                queue.append((nx, ny))
    return dist


def in_zoc(unit, enemy_soldiers):
    if unit["type"] == "SOLDIER":
        return False
    for sx, sy in enemy_soldiers:
        if chebyshev(unit["x"], unit["y"], sx, sy) <= 2:
            return True
    return False


# ── strategic mode ─────────────────────────────────────────────────────────────

def monuments_held(state, my_team):
    return [m for m in state.get("monuments", []) if m.get("controlledBy") == my_team]


def monuments_not_held(state, my_team):
    return [m for m in state.get("monuments", []) if m.get("controlledBy") != my_team]


def detect_mode(state, my_team, gold, turn):
    """
    RUSH    — early turns (< 40) or monuments still uncaptured and we have no garrison
    CONTEST — at least one monument not held by us
    FORTRESS — all monuments held, defend and build cities around them
    SIEGE   — all monuments held for a sustained period + army large enough to threaten
    """
    all_monuments = state.get("monuments", [])
    held   = monuments_held(state, my_team)
    needed = monuments_not_held(state, my_team)
    my_units = [u for u in state["units"] if u["owner"] == my_team]
    n_soldiers = sum(1 for u in my_units if u["type"] == "SOLDIER")

    # RUSH: go grab monuments, doesn't matter what else is happening
    if turn < 40 or (needed and n_soldiers < 2):
        return "RUSH"

    # CONTEST: monument(s) not held — drop everything, recapture
    if needed:
        return "CONTEST"

    # SIEGE: all monuments held, enough army — threaten enemy cities
    enemy_cities = [c for c in state["cities"] if c["owner"] != my_team]
    if len(held) == len(all_monuments) and n_soldiers >= 4 and enemy_cities:
        return "SIEGE"

    return "FORTRESS"


# ── unit role assignment ───────────────────────────────────────────────────────

def assign_roles(state, my_team, mode):
    """
    monument_garrison — archer stays adjacent to monument, defends it
    monument_ring     — soldier stays 2-3 tiles from monument, intercepts threats
    rush_monument     — sprint toward nearest uncontrolled monument
    siege             — soldier pushes toward enemy city
    raid              — raider goes deep for plunder
    support           — archer follows behind soldiers
    """
    w         = WEIGHTS
    my_units  = [u for u in state["units"] if u["owner"] == my_team]
    held      = monuments_held(state, my_team)
    needed    = monuments_not_held(state, my_team)
    roles     = {}
    assigned  = set()

    # RUSH / CONTEST: sprint all soldiers toward uncontrolled monuments
    if mode in ("RUSH", "CONTEST") and needed:
        targets = sorted(needed, key=lambda m: min(
            chebyshev(u["x"], u["y"], m["x"], m["y"])
            for u in my_units if u["type"] == "SOLDIER"
        ) if any(u["type"] == "SOLDIER" for u in my_units) else 999)

        for mon in targets:
            for unit in sorted(my_units, key=lambda u: chebyshev(u["x"], u["y"], mon["x"], mon["y"])):
                pos = (unit["x"], unit["y"])
                if pos in assigned:
                    continue
                if unit["type"] == "SOLDIER":
                    roles[pos] = ("rush_monument", (mon["x"], mon["y"]))
                    assigned.add(pos)
                    break  # one soldier per monument initially

        # Raiders raid while soldiers rush
        for unit in my_units:
            pos = (unit["x"], unit["y"])
            if pos not in roles:
                if unit["type"] == "RAIDER":
                    roles[pos] = ("raid", None)
                elif unit["type"] == "ARCHER":
                    # Archers follow to reinforce monument
                    if needed:
                        mon = min(needed, key=lambda m: chebyshev(unit["x"], unit["y"], m["x"], m["y"]))
                        roles[pos] = ("rush_monument", (mon["x"], mon["y"]))
                    else:
                        roles[pos] = ("support", None)
        return roles

    # FORTRESS / SIEGE: assign garrison roles around held monuments
    # Each held monument gets: up to archers_per_monument archers + soldiers_per_monument ring
    archers_per = max(1, int(w["archers_per_monument"]))
    soldiers_per = max(1, int(w["soldiers_per_monument"]))

    for mon in held:
        mx, my = mon["x"], mon["y"]
        # Archer garrison — assign closest archers
        for _ in range(archers_per):
            candidates = [u for u in my_units
                          if u["type"] == "ARCHER" and (u["x"], u["y"]) not in assigned]
            if not candidates:
                break
            closest = min(candidates, key=lambda u: chebyshev(u["x"], u["y"], mx, my))
            pos = (closest["x"], closest["y"])
            roles[pos] = ("monument_garrison", (mx, my))
            assigned.add(pos)

        # Soldier ring — assign closest soldiers
        for _ in range(soldiers_per):
            candidates = [u for u in my_units
                          if u["type"] == "SOLDIER" and (u["x"], u["y"]) not in assigned]
            if not candidates:
                break
            closest = min(candidates, key=lambda u: chebyshev(u["x"], u["y"], mx, my))
            pos = (closest["x"], closest["y"])
            roles[pos] = ("monument_ring", (mx, my))
            assigned.add(pos)

    # SIEGE: unassigned soldiers push toward enemy cities
    if mode == "SIEGE":
        enemy_cities = [(c["x"], c["y"]) for c in state["cities"] if c["owner"] != my_team]
        for unit in my_units:
            pos = (unit["x"], unit["y"])
            if pos not in assigned:
                if unit["type"] == "SOLDIER":
                    roles[pos] = ("siege", None)
                elif unit["type"] == "RAIDER":
                    roles[pos] = ("raid", None)
                elif unit["type"] == "ARCHER":
                    roles[pos] = ("support", None)
    else:
        # FORTRESS: extras raid or support
        for unit in my_units:
            pos = (unit["x"], unit["y"])
            if pos not in assigned:
                if unit["type"] == "RAIDER":
                    roles[pos] = ("raid", None)
                elif unit["type"] == "ARCHER":
                    roles[pos] = ("support", None)
                else:
                    roles[pos] = ("monument_ring", (held[0]["x"], held[0]["y"]) if held else None)

    return roles


# ── movement scoring ───────────────────────────────────────────────────────────

def best_move(unit, state, my_team, unit_positions, ex, W, role_data):
    """
    Score every reachable tile given the unit's role and return best (tx, ty) or None.
    role_data = (role_name, target) where target may be (mx, my) or None.
    """
    w         = WEIGHTS
    role, target = role_data
    tile_lut  = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    H         = state["map"]["height"]
    movement  = UNIT_MOVEMENT[unit["type"]]

    enemy_cities  = [(c["x"], c["y"]) for c in state["cities"] if c["owner"] != my_team]
    enemy_units   = [(u["x"], u["y"]) for u in state["units"] if u["owner"] != my_team]
    own_cities    = [(c["x"], c["y"]) for c in state["cities"] if c["owner"] == my_team]
    all_monuments = [(m["x"], m["y"]) for m in state.get("monuments", [])]
    held_monuments = [(m["x"], m["y"]) for m in monuments_held(state, my_team)]
    needed_monuments = [(m["x"], m["y"]) for m in monuments_not_held(state, my_team)]
    enemy_city_set = set(enemy_cities)

    lethal_pos = [
        (u["x"], u["y"]) for u in state["units"]
        if u["owner"] != my_team and u["type"] in LETHAL_THREATS[unit["type"]]
    ]

    # Precompute BFS maps
    ec_dist   = bfs_distances(tile_lut, W, H, enemy_cities)    if enemy_cities   else {}
    eu_dist   = bfs_distances(tile_lut, W, H, enemy_units)     if enemy_units    else {}
    mon_dist  = bfs_distances(tile_lut, W, H, needed_monuments) if needed_monuments else {}
    held_dist = bfs_distances(tile_lut, W, H, held_monuments)  if held_monuments else {}
    tgt_dist  = bfs_distances(tile_lut, W, H, [target])        if target         else {}

    ux, uy = unit["x"], unit["y"]
    best_score, best_pos = -999, None

    for dx in range(-movement, movement + 1):
        for dy in range(-movement, movement + 1):
            if chebyshev(0, 0, dx, dy) > movement:
                continue
            if dx == 0 and dy == 0:
                continue
            tx, ty = ux + dx, uy + dy
            if not (0 <= tx < W and 0 <= ty < H):
                continue
            tile = tile_lut.get((tx, ty))
            if not tile or tile["type"] != "FIELD":
                continue
            if (tx, ty) in unit_positions:
                continue

            score = 0.0

            # ── avoid map edges ──────────────────────────────────────────────
            if ty == 0 or ty == H - 1:
                score -= 4.0
            if ty == 1 or ty == H - 2:
                score -= 2.0

            # ── role-specific scoring ────────────────────────────────────────

            if role == "rush_monument" and target:
                # Sprint to monument as fast as possible
                od = tgt_dist.get((ux, uy), 999)
                nd = tgt_dist.get((tx, ty), 999)
                score += (od - nd) * w["w_monument_rush"]
                # Also step onto enemy tiles on the way for extra points
                if tile.get("owner") not in (None, my_team):
                    score += w["w_raid_tile"]
                # Capture enemy city opportunistically
                if unit["type"] == "SOLDIER" and (tx, ty) in enemy_city_set:
                    score += w["w_city_capture"]

            elif role == "monument_garrison" and target:
                # Archers: stay adjacent (dist ≤ 2) to monument; don't wander
                mx, my_ = target
                nd = chebyshev(tx, ty, mx, my_)
                # Perfect position: distance 1-2 from monument
                if nd == 1:
                    score += w["w_monument_guard"]
                elif nd == 2:
                    score += w["w_monument_guard"] * 0.6
                else:
                    # Move toward monument
                    od = tgt_dist.get((ux, uy), 999)
                    nd_bfs = tgt_dist.get((tx, ty), 999)
                    score += (od - nd_bfs) * w["w_monument_guard"]
                # Archers reward range-2 position from enemies
                if enemy_units:
                    min_e = min(chebyshev(tx, ty, ex2, ey2) for ex2, ey2 in enemy_units)
                    if min_e == 2:
                        score += w["w_archer_range"]
                    elif min_e == 1:
                        score -= w["w_archer_range"]

            elif role == "monument_ring" and target:
                # Soldiers: form a perimeter 2-3 tiles from monument, intercept threats
                mx, my_ = target
                nd = chebyshev(tx, ty, mx, my_)
                # Optimal ring distance is 2-3
                if 2 <= nd <= 3:
                    score += w["w_monument_ring"]
                elif nd < 2:
                    score += w["w_monument_ring"] * 0.4  # don't crowd monument
                else:
                    od = tgt_dist.get((ux, uy), 999)
                    nd_bfs = tgt_dist.get((tx, ty), 999)
                    score += (od - nd_bfs) * w["w_monument_ring"]
                # Engage threats approaching the monument
                if enemy_units:
                    od2 = eu_dist.get((ux, uy), 999)
                    nd2 = eu_dist.get((tx, ty), 999)
                    score += (od2 - nd2) * 8.0
                if unit["type"] == "SOLDIER" and (tx, ty) in enemy_city_set:
                    score += w["w_city_capture"]

            elif role == "siege":
                # Soldiers push toward enemy cities from our monument stronghold
                score += (abs(ux - ex) - abs(tx - ex)) * w["w_forward"]
                if enemy_cities:
                    od = ec_dist.get((ux, uy), 999)
                    nd = ec_dist.get((tx, ty), 999)
                    score += (od - nd) * w["w_enemy_city"]
                if (tx, ty) in enemy_city_set:
                    score += w["w_city_capture"]
                if tile.get("owner") not in (None, my_team):
                    score += w["w_raid_tile"]

            elif role == "raid":
                # Raiders: plunder deep, avoid soldiers
                score += (abs(ux - ex) - abs(tx - ex)) * w["w_forward"]
                plunder_tiles = sum(
                    1 for pdx in range(-1, 2) for pdy in range(-1, 2)
                    if tile_lut.get((tx + pdx, ty + pdy), {}).get("owner") not in (None, my_team)
                )
                score += plunder_tiles * w["w_plunder"]
                if tile.get("owner") not in (None, my_team):
                    score += w["w_raid_tile"]
                # Avoid enemy soldiers
                enemy_sol_pos = [(u["x"], u["y"]) for u in state["units"]
                                 if u["owner"] != my_team and u["type"] == "SOLDIER"]
                adj_sol = sum(1 for sx, sy in enemy_sol_pos if chebyshev(tx, ty, sx, sy) <= 1)
                score -= adj_sol * 15.0

            elif role == "support":
                # Archers: follow behind the frontline, stay at range 2
                score += (abs(ux - ex) - abs(tx - ex)) * w["w_forward"] * 0.5
                if enemy_units:
                    min_e = min(chebyshev(tx, ty, ex2, ey2) for ex2, ey2 in enemy_units)
                    if min_e == 2:
                        score += w["w_archer_range"]
                    elif min_e == 1:
                        score -= w["w_archer_range"]

            # Light danger penalty for all roles
            if lethal_pos:
                nd = min(chebyshev(tx, ty, lx, ly) for lx, ly in lethal_pos)
                if nd <= 2:
                    score -= 4.0

            if score > best_score or (score == best_score and random.random() < 0.3):
                best_score, best_pos = score, (tx, ty)

    return best_pos if best_score > 0 else None


# ── city placement: monument-adjacent preference ───────────────────────────────

def monument_city_score(pos, state, my_team):
    """
    Score a candidate city tile.
    Bonus for proximity to monuments, penalty for distance from enemy side.
    """
    w     = WEIGHTS
    px, py = pos
    ex    = enemy_side_x(state, my_team)
    monuments = state.get("monuments", [])

    # Forward progress
    score = -abs(px - ex) * 1.5

    # Proximity to monuments: closer = better (build fortress around them)
    for mon in monuments:
        dist = chebyshev(px, py, mon["x"], mon["y"])
        # Very close (≤3): strong bonus — monument fortress position
        if dist <= 3:
            score += w["w_city_near_monument"] * (4 - dist)
        # Medium range (4-6): small bonus
        elif dist <= 6:
            score += w["w_city_near_monument"] * 0.5

    # Prefer cities that are spread out from each other
    my_cities = [c for c in state["cities"] if c["owner"] == my_team]
    if my_cities:
        min_gap = min(chebyshev(px, py, c["x"], c["y"]) for c in my_cities)
        score += min(min_gap, 6) * 1.5

    return score


# ── build unit priority based on mode ─────────────────────────────────────────

def build_priority(mode, state, my_team):
    """Return list of unit types in desired build order for this mode."""
    held = monuments_held(state, my_team)
    n_held = len(held)

    if mode in ("RUSH", "CONTEST"):
        return ["SOLDIER", "SOLDIER", "ARCHER"]   # rush soldiers first
    elif mode == "FORTRESS":
        # Archers garrison monuments, then soldiers ring, then raiders
        return ["ARCHER", "SOLDIER", "RAIDER"]
    elif mode == "SIEGE":
        return ["SOLDIER", "ARCHER", "RAIDER"]
    return ["SOLDIER", "ARCHER", "RAIDER"]


# ── main action generator ──────────────────────────────────────────────────────

def generate_actions(state, my_team, turn=0):
    w        = WEIGHTS
    actions  = []
    tile_lut = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    unit_pos = {(u["x"], u["y"]): u for u in state["units"]}
    city_pos = {(c["x"], c["y"]) for c in state["cities"]}
    my_units  = [u for u in state["units"]  if u["owner"] == my_team]
    my_cities = [c for c in state["cities"] if c["owner"] == my_team]
    W        = state["map"]["width"]
    H        = state["map"]["height"]
    ex       = enemy_side_x(state, my_team)

    gold = estimate_gold(state, my_team)

    mode  = detect_mode(state, my_team, gold, turn)
    roles = assign_roles(state, my_team, mode)

    enemy_soldiers = [(u["x"], u["y"]) for u in state["units"]
                      if u["owner"] != my_team and u["type"] == "SOLDIER"]

    # 1. EXPAND TERRITORY — grow corridors toward monuments via BFS
    monuments = state.get("monuments", [])
    # More aggressive expansion in early/contest modes to claim monument corridors fast
    expand_limit = 8 if mode in ("RUSH", "CONTEST") else 6 if mode == "FORTRESS" else 4
    max_exp = min(expand_limit, int(gold // 5))
    if max_exp > 0:
        conn = connected_territory(state, my_team)

        # BFS distance maps: how far is each tile from each monument?
        # We score candidates by how much they reduce BFS distance to the nearest monument.
        mon_positions = [(m["x"], m["y"]) for m in monuments]
        mon_bfs = bfs_distances(tile_lut, W, H, mon_positions) if mon_positions else {}

        # Also build per-monument BFS so we can reward tiles that close on ANY monument
        per_mon_bfs = []
        for mon in monuments:
            per_mon_bfs.append(bfs_distances(tile_lut, W, H, [(mon["x"], mon["y"])]))

        seen, candidates = set(), []
        for (cx, cy) in conn:
            for dx, dy in ADJ:
                nb = (cx + dx, cy + dy)
                if nb in seen or nb in conn:
                    continue
                seen.add(nb)
                tile = tile_lut.get(nb)
                if not tile or tile["type"] != "FIELD" or tile.get("owner") is not None:
                    continue

                exp_score = 0.0

                # Primary: reward tiles that are on the BFS corridor to the nearest monument.
                # The closer this tile is to a monument (via walkable path), the higher the score.
                nearest_mon_dist = mon_bfs.get(nb, 999)
                if nearest_mon_dist < 999:
                    exp_score += 40.0 / (nearest_mon_dist + 1)  # strong pull toward monument

                # Secondary: for each monument individually, reward reducing distance to it
                for bfs_map in per_mon_bfs:
                    nb_dist   = bfs_map.get(nb, 999)
                    # Check how this compares to neighbors already owned — reward progress
                    best_owned = min((bfs_map.get((cx2, cy2), 999)
                                      for (cx2, cy2) in conn), default=999)
                    if nb_dist < best_owned:
                        exp_score += 10.0  # this tile advances the corridor

                # Mild forward push — don't let it override monument direction
                exp_score -= abs(nb[0] - ex) * 0.2

                candidates.append((-exp_score, nb))

        candidates.sort()
        for _, (nx, ny) in candidates[:max_exp]:
            if gold < 5:
                break
            actions.append({"action": "EXPAND_TERRITORY", "x": nx, "y": ny})
            gold -= 5

    # 2. BUILD CITY — prefer tiles adjacent to monuments
    city_cost = round(80 * (1.5 ** max(0, len(my_cities) - 1)))
    if (gold >= city_cost + w["gold_buffer"] and
            len(my_cities) < int(w["max_cities"]) and
            mode not in ("RUSH", "CONTEST")):
        conn = connected_territory(state, my_team)
        candidates = []
        for pos in conn:
            tile = tile_lut.get(pos)
            if not tile or tile["type"] != "FIELD":
                continue
            if pos in city_pos or pos in unit_pos:
                continue
            candidates.append((monument_city_score(pos, state, my_team), pos))
        if candidates:
            _, (bx, by) = max(candidates)
            actions.append({"action": "BUILD_CITY", "x": bx, "y": by})
            gold -= city_cost
            city_pos.add((bx, by))
            my_cities.append({"x": bx, "y": by, "owner": my_team})

    # 3. BUILD UNITS — scale to monuments held, not cities
    held = monuments_held(state, my_team)
    n_held = max(1, len(held))  # at least 1 to avoid 0 targets
    unit_counts = {"SOLDIER": 0, "ARCHER": 0, "RAIDER": 0}
    for u in my_units:
        unit_counts[u["type"]] += 1

    want = {
        "SOLDIER": max(2, round(n_held * w["soldiers_per_monument"])),
        "ARCHER":  max(1, math.ceil(n_held * w["archers_per_monument"])),
        "RAIDER":  max(0, math.ceil(n_held * w["raiders_per_monument"])),
    }
    # In RUSH/CONTEST flood soldiers to take monuments fast
    if mode in ("RUSH", "CONTEST"):
        want["SOLDIER"] = max(want["SOLDIER"], 4)
        want["ARCHER"]  = max(want["ARCHER"], 1)

    priority = build_priority(mode, state, my_team)
    cities_used = set()
    n_units_now = len(my_units)

    # Reload gold (city build may have changed it)
    gold = estimate_gold(state, my_team)
    for a in actions:
        if a["action"] == "BUILD_CITY":
            gold -= city_cost

    for city in my_cities:
        key = (city["x"], city["y"])
        if key in unit_pos or key in cities_used:
            continue
        for utype in priority:
            if unit_counts[utype] >= want[utype]:
                continue
            cost = UNIT_COSTS[utype]
            if gold < cost:
                continue
            upkeep_after = compute_upkeep(n_units_now + 1, len(my_cities))
            if upkeep_after > gold - cost:
                continue
            actions.append({"action": "BUILD_UNIT",
                             "city_x": key[0], "city_y": key[1], "unit_type": utype})
            gold -= cost
            unit_counts[utype] += 1
            n_units_now += 1
            cities_used.add(key)
            break

    # 4. MOVE UNITS
    moving_pos = dict(unit_pos)

    for unit in my_units:
        can_move = unit.get("can_move_next_turn", unit.get("canMove", True))
        if not can_move:
            continue
        if in_zoc(unit, enemy_soldiers):
            continue
        pos = (unit["x"], unit["y"])
        role_data = roles.get(pos, ("support", None))
        mv = best_move(unit, state, my_team, set(moving_pos.keys()), ex, W, role_data)
        if mv:
            actions.append({
                "action": "MOVE",
                "from_x": unit["x"], "from_y": unit["y"],
                "to_x": mv[0], "to_y": mv[1],
            })
            del moving_pos[pos]
            moving_pos[mv] = unit

    return actions


# ── WebSocket client ───────────────────────────────────────────────────────────

async def main():
    global team_id, WEIGHTS, best_weights, history, _game_stats

    while True:
        try:
            import websockets
            async with websockets.connect(SERVER_URL) as ws:
                await ws.send(json.dumps({
                    "type": "AUTH", "password": PASSWORD,
                    "name": NAME, "preferredTeam": TEAM,
                }))

                async for raw in ws:
                    msg = json.loads(raw)

                    if msg["type"] == "AUTH_SUCCESS":
                        team_id    = msg["teamId"]
                        _game_stats = {"monument_turns": 0, "peak_territory": 0}

                    elif msg["type"] == "TURN_START":
                        state = msg["state"]
                        turn  = msg.get("turn", 0)
                        if team_id is not None:
                            mon_held = sum(1 for m in state.get("monuments", [])
                                          if m.get("controlledBy") == team_id)
                            if mon_held > 0:
                                _game_stats["monument_turns"] += 1
                            territory = sum(1 for t in state["map"]["tiles"]
                                            if t.get("owner") == team_id)
                            _game_stats["peak_territory"] = max(_game_stats["peak_territory"], territory)
                            try:
                                actions = generate_actions(state, team_id, turn)
                                await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": actions}))
                            except Exception as e:
                                print(f"[MonumentBot] Error: {e}")
                                await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": []}))

                    elif msg["type"] == "GAME_OVER":
                        winner    = msg.get("winner")
                        outcome   = "win" if winner == team_id else "loss" if winner is not None else "draw"
                        scores    = msg.get("scores", {})
                        my_score  = scores.get(str(team_id), 0)
                        opp_score = next((v for k, v in scores.items() if k != str(team_id)), 0)
                        score_delta = my_score - opp_score

                        history.append({
                            "outcome":         outcome,
                            "score_delta":     score_delta,
                            "opponent":        OPPONENT,
                            "monument_turns":  _game_stats["monument_turns"],
                            "peak_territory":  _game_stats["peak_territory"],
                        })
                        save_history(history)
                        WEIGHTS, best_weights = maybe_evolve(history, WEIGHTS, best_weights)

        except Exception as e:
            print(f"[MonumentBot] Connection error: {e} — reconnecting in 3s")
            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
