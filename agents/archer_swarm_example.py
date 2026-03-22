"""
ArcherSwarmBot — Pure economy + archer flood strategy.

Unusual twist: NEVER builds soldiers or raiders. Only archers.

Core idea:
  1. EXPAND  — rush to build as many cities as possible (income scales income)
  2. MASS    — hoard gold, build archers until critical mass (8+)
  3. SWARM   — advance the entire archer line in formation, fire-then-kite
  4. KITE    — if raiders appear, retreat archers away and keep firing from range 2

Why archers only works:
  - Archers fire BEFORE moving — fire at range 2, then step back out of range 1.
  - A line of 8+ archers deals massive damage every turn before enemy can close.
  - Archers 2x vs soldiers — the most common unit type is countered by default.
  - No upkeep complexity: archers cost 25g, same HP as soldiers (2 HP).
  - ZoC doesn't apply to archers — they can always move freely.
  - Economy advantage: more cities = more archers = more firepower = avalanche.

Weaknesses and how we handle them:
  - Raiders 2x vs archers → KITE mode: detect raiders, pull back 2 tiles, keep firing.
  - Can't capture cities (need soldiers) → SIEGE mode: surround enemy city with archers,
    fire until all defending units dead, then one archer walks onto it (archers CAN capture).
  - No ZoC threat → enemy archers/raiders roam freely → counter with numbers.

Strategic phases:
  EXPAND  — < critical_cities cities; build cities over all else
  MASS    — enough cities, build archers until archer count >= mass_threshold
  SWARM   — march archers forward as a tight line
  KITE    — enemy raiders detected; retreat line, maintain range 2 gap
  SIEGE   — enemy city in range; concentrate fire to clear defenders, then capture

Files written next to this script: none (no learning — pure fixed strategy)
"""

import asyncio, json, os, random, math
from collections import deque

SERVER_URL = os.environ.get("SERVER_URL", "ws://localhost:8080")
PASSWORD   = os.environ.get("PASSWORD", "player")
TEAM       = int(os.environ.get("TEAM", "0"))
NAME       = os.environ.get("BOT_NAME", "ArcherSwarmBot")
OPPONENT   = os.environ.get("OPPONENT", "unknown")

team_id = None

EVAL_EVERY     = 5
MUTATION_SIGMA = 0.15
HISTORY_WINDOW = 30

UNIT_COSTS    = {"SOLDIER": 20, "ARCHER": 25, "RAIDER": 15}
UNIT_MOVEMENT = {"SOLDIER": 1,  "ARCHER": 1,  "RAIDER": 2}
UNIT_MAX_HP   = {"SOLDIER": 2,  "ARCHER": 2,  "RAIDER": 1}
ADJ = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]

SCRIPT_DIR        = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_FILE      = os.path.join(SCRIPT_DIR, "archer_swarm_weights.json")
BEST_WEIGHTS_FILE = os.path.join(SCRIPT_DIR, "archer_swarm_best_weights.json")
HISTORY_FILE      = os.path.join(SCRIPT_DIR, "archer_swarm_history.json")

DEFAULT_WEIGHTS = {
    "critical_cities":        4,
    "mass_threshold":         8,
    "gold_buffer":           30,
    "max_cities":             6,
    "kite_retreat_dist":      3,
    "w_forward":              8.0,
    "w_fire_pos":            15.0,
    "w_retreat_from_raider": 20.0,
    "w_cohesion":             6.0,
    "w_city_capture":       120.0,
    "w_approach_city":       18.0,
    "w_raid_tile":            5.0,
}

WEIGHT_SANITY = {
    "critical_cities":        (2,    5),
    "mass_threshold":         (4,   15),
    "gold_buffer":            (20,  50),
    "max_cities":             (3,    8),
    "kite_retreat_dist":      (2,    5),
    "w_forward":              (3,   15),
    "w_fire_pos":             (8,   30),
    "w_retreat_from_raider":  (10,  40),
    "w_cohesion":             (2,   15),
    "w_city_capture":         (80, 150),
    "w_approach_city":        (8,   30),
    "w_raid_tile":            (2,   12),
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
        if k in ("critical_cities", "mass_threshold", "max_cities", "kite_retreat_dist"):
            new_w[k] = max(1, round(v + noise))
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


def apply_weights(w: dict):
    """Push weight dict values into the module-level constants used by game logic."""
    global CRITICAL_CITIES, MASS_THRESHOLD, GOLD_BUFFER, MAX_CITIES, KITE_RETREAT_DIST
    global W_FORWARD, W_FIRE_POS, W_RETREAT_FROM_RAIDER, W_COHESION
    global W_CITY_CAPTURE, W_APPROACH_CITY, W_RAID_TILE
    CRITICAL_CITIES       = int(w["critical_cities"])
    MASS_THRESHOLD        = int(w["mass_threshold"])
    GOLD_BUFFER           = w["gold_buffer"]
    MAX_CITIES            = int(w["max_cities"])
    KITE_RETREAT_DIST     = int(w["kite_retreat_dist"])
    W_FORWARD             = w["w_forward"]
    W_FIRE_POS            = w["w_fire_pos"]
    W_RETREAT_FROM_RAIDER = w["w_retreat_from_raider"]
    W_COHESION            = w["w_cohesion"]
    W_CITY_CAPTURE        = w["w_city_capture"]
    W_APPROACH_CITY       = w["w_approach_city"]
    W_RAID_TILE           = w["w_raid_tile"]


_weights     = load_weights()
best_weights = load_best_weights()
history      = load_history()
_game_stats  = {"peak_territory": 0, "peak_archers": 0}
apply_weights(_weights)

# ── strategy constants (set by apply_weights on startup) ──────────────────────

CRITICAL_CITIES   = int(_weights["critical_cities"])
MASS_THRESHOLD    = int(_weights["mass_threshold"])
GOLD_BUFFER       = _weights["gold_buffer"]
MAX_CITIES        = int(_weights["max_cities"])
KITE_RETREAT_DIST = int(_weights["kite_retreat_dist"])

W_FORWARD             = _weights["w_forward"]
W_FIRE_POS            = _weights["w_fire_pos"]
W_RETREAT_FROM_RAIDER = _weights["w_retreat_from_raider"]
W_COHESION            = _weights["w_cohesion"]
W_CITY_CAPTURE        = _weights["w_city_capture"]
W_APPROACH_CITY       = _weights["w_approach_city"]
W_RAID_TILE           = _weights["w_raid_tile"]


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


# ── mode detection ─────────────────────────────────────────────────────────────

def detect_mode(state, my_team, gold, turn):
    """
    EXPAND — build economy first
    MASS   — have enough cities, stockpile archers
    KITE   — raiders approaching our archers
    SIEGE  — enemy city very close
    SWARM  — default advance mode
    """
    my_cities  = [c for c in state["cities"] if c["owner"] == my_team]
    my_archers = [u for u in state["units"] if u["owner"] == my_team and u["type"] == "ARCHER"]
    enemy_units = [u for u in state["units"] if u["owner"] != my_team]
    enemy_raiders = [u for u in enemy_units if u["type"] == "RAIDER"]
    enemy_cities = [c for c in state["cities"] if c["owner"] != my_team]

    # EXPAND: fewer cities than target
    if len(my_cities) < CRITICAL_CITIES:
        return "EXPAND"

    # KITE: any raider within danger range of an archer
    if enemy_raiders:
        for archer in my_archers:
            for raider in enemy_raiders:
                if chebyshev(archer["x"], archer["y"], raider["x"], raider["y"]) <= KITE_RETREAT_DIST:
                    return "KITE"

    # SIEGE: enemy city reachable by archers (within 4 tiles)
    if enemy_cities and my_archers:
        for archer in my_archers:
            for city in enemy_cities:
                if chebyshev(archer["x"], archer["y"], city["x"], city["y"]) <= 4:
                    return "SIEGE"

    # MASS: need more archers before advancing
    if len(my_archers) < MASS_THRESHOLD:
        return "MASS"

    return "SWARM"


# ── movement scoring ───────────────────────────────────────────────────────────

def best_move(unit, state, my_team, occupied, ex, W, mode):
    tile_lut = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    H        = state["map"]["height"]

    enemy_units  = [(u["x"], u["y"]) for u in state["units"] if u["owner"] != my_team]
    enemy_raiders = [(u["x"], u["y"]) for u in state["units"]
                     if u["owner"] != my_team and u["type"] == "RAIDER"]
    enemy_cities  = [(c["x"], c["y"]) for c in state["cities"] if c["owner"] != my_team]
    my_archers    = [(u["x"], u["y"]) for u in state["units"]
                     if u["owner"] == my_team and u["type"] == "ARCHER"
                     and not (u["x"] == unit["x"] and u["y"] == unit["y"])]
    enemy_city_set = set(enemy_cities)

    # BFS maps
    ec_dist = bfs_distances(tile_lut, W, H, enemy_cities) if enemy_cities else {}
    eu_dist = bfs_distances(tile_lut, W, H, enemy_units)  if enemy_units  else {}
    er_dist = bfs_distances(tile_lut, W, H, enemy_raiders) if enemy_raiders else {}

    ux, uy = unit["x"], unit["y"]
    best_score, best_pos = -9999, None

    for dx in range(-1, 2):
        for dy in range(-1, 2):
            if dx == 0 and dy == 0:
                continue
            tx, ty = ux + dx, uy + dy
            if not (0 <= tx < W and 0 <= ty < H):
                continue
            tile = tile_lut.get((tx, ty))
            if not tile or tile["type"] != "FIELD":
                continue
            if (tx, ty) in occupied:
                continue

            score = 0.0

            # ── avoid map edges ──────────────────────────────────────────────
            if ty == 0 or ty == H - 1:
                score -= 4.0
            if ty == 1 or ty == H - 2:
                score -= 2.0

            if mode == "KITE":
                # ── KITE: retreat from raiders, maintain range-2 gap ────────
                if enemy_raiders:
                    old_r = er_dist.get((ux, uy), 999)
                    new_r = er_dist.get((tx, ty), 999)
                    # Reward moving AWAY from raiders
                    score += (new_r - old_r) * W_RETREAT_FROM_RAIDER
                    # Strongly penalise moving within 1 tile of a raider
                    if new_r <= 1:
                        score -= 50.0
                    elif new_r == 2:
                        score -= 20.0
                # Still try to face enemy at range 2 from non-raiders
                non_raider_enemies = [(u["x"], u["y"]) for u in state["units"]
                                      if u["owner"] != my_team and u["type"] != "RAIDER"]
                if non_raider_enemies:
                    min_e = min(chebyshev(tx, ty, ex2, ey2) for ex2, ey2 in non_raider_enemies)
                    if min_e == 2:
                        score += W_FIRE_POS * 0.5
                # Maintain formation cohesion even while retreating
                if my_archers:
                    avg_y = sum(ay for ax, ay in my_archers) / len(my_archers)
                    score -= abs(ty - avg_y) * W_COHESION * 0.3

            elif mode == "SIEGE":
                # ── SIEGE: close in on enemy city, one archer captures ───────
                if enemy_cities:
                    old_d = ec_dist.get((ux, uy), 999)
                    new_d = ec_dist.get((tx, ty), 999)
                    score += (old_d - new_d) * W_APPROACH_CITY
                # Step onto enemy city = instant capture
                if (tx, ty) in enemy_city_set:
                    score += W_CITY_CAPTURE
                # Maintain range 2 from remaining defenders (fire before capturing)
                if enemy_units:
                    min_e = min(chebyshev(tx, ty, ex2, ey2) for ex2, ey2 in enemy_units)
                    if min_e == 2:
                        score += W_FIRE_POS
                    elif min_e == 1:
                        score -= W_FIRE_POS  # don't walk into melee range
                # Step on enemy tiles for income
                if tile.get("owner") not in (None, my_team):
                    score += W_RAID_TILE

            else:
                # ── SWARM (also MASS/EXPAND movement): advance the line ──────
                # Forward progress toward enemy side
                score += (abs(ux - ex) - abs(tx - ex)) * W_FORWARD

                # Core archer tactic: stay at exactly range 2 from enemies
                if enemy_units:
                    min_e = min(chebyshev(tx, ty, ex2, ey2) for ex2, ey2 in enemy_units)
                    if min_e == 2:
                        score += W_FIRE_POS         # perfect fire position
                    elif min_e == 1:
                        score -= W_FIRE_POS * 2     # walked into melee — very bad
                    elif min_e == 3:
                        score += W_FIRE_POS * 0.3   # one step away from ideal

                # Formation cohesion: stay Y-aligned with other archers
                # This forms a horizontal firing line that maximises threat coverage
                if my_archers:
                    avg_y = sum(ay for ax, ay in my_archers) / len(my_archers)
                    score -= abs(ty - avg_y) * W_COHESION
                    # Penalise X-spread within the line (stay together)
                    avg_x = sum(ax for ax, ay in my_archers) / len(my_archers)
                    x_spread = abs(tx - avg_x) - abs(ux - avg_x)
                    score -= max(0, x_spread) * W_COHESION * 0.5

                # Step on enemy tiles
                if tile.get("owner") not in (None, my_team):
                    score += W_RAID_TILE

                # Opportunistic city capture
                if (tx, ty) in enemy_city_set:
                    score += W_CITY_CAPTURE

                # MASS mode: don't advance past the midpoint yet
                if mode == "MASS":
                    midx = abs(ux - ex)
                    new_midx = abs(tx - ex)
                    W_map = state["map"]["width"]
                    safe_line = W_map // 3   # stay on our side of the map
                    if ex == W_map - 1 and tx > W_map // 2 - safe_line:
                        score -= 30.0
                    elif ex == 0 and tx < W_map // 2 + safe_line:
                        score -= 30.0

            if score > best_score or (score == best_score and random.random() < 0.3):
                best_score, best_pos = score, (tx, ty)

    return best_pos if best_score > -9999 else None


# ── main action generator ──────────────────────────────────────────────────────

def generate_actions(state, my_team, turn=0):
    actions  = []
    tile_lut = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    unit_pos = {(u["x"], u["y"]): u for u in state["units"]}
    city_pos = {(c["x"], c["y"]) for c in state["cities"]}
    my_units  = [u for u in state["units"]  if u["owner"] == my_team]
    my_cities = [c for c in state["cities"] if c["owner"] == my_team]
    my_archers = [u for u in my_units if u["type"] == "ARCHER"]
    W        = state["map"]["width"]
    H        = state["map"]["height"]
    ex       = enemy_side_x(state, my_team)

    gold = estimate_gold(state, my_team)
    mode = detect_mode(state, my_team, gold, turn)

    # 1. EXPAND TERRITORY — always expand forward, prioritise toward enemy
    expand_limit = 6 if mode == "EXPAND" else 4
    max_exp = min(expand_limit, int(gold // 5))
    if max_exp > 0:
        conn = connected_territory(state, my_team)
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
                fwd = abs(nb[0] - ex)
                candidates.append((fwd, nb))
        candidates.sort()
        for _, (nx, ny) in candidates[:max_exp]:
            if gold < 5:
                break
            actions.append({"action": "EXPAND_TERRITORY", "x": nx, "y": ny})
            gold -= 5

    # 2. BUILD CITY — in EXPAND mode, build aggressively toward enemy side
    city_cost = round(80 * (1.5 ** max(0, len(my_cities) - 1)))
    if (gold >= city_cost + GOLD_BUFFER and len(my_cities) < MAX_CITIES):
        conn = connected_territory(state, my_team)
        candidates = []
        for pos in conn:
            tile = tile_lut.get(pos)
            if not tile or tile["type"] != "FIELD":
                continue
            if pos in city_pos or pos in unit_pos:
                continue
            # Score: push toward enemy, spread from existing cities
            fwd_score = -abs(pos[0] - ex)
            gap = min((chebyshev(pos[0], pos[1], c["x"], c["y"]) for c in my_cities), default=0)
            candidates.append((fwd_score + min(gap, 5) * 2, pos))
        if candidates:
            _, (bx, by) = max(candidates)
            actions.append({"action": "BUILD_CITY", "x": bx, "y": by})
            gold -= city_cost
            city_pos.add((bx, by))
            my_cities.append({"x": bx, "y": by, "owner": my_team})

    # 3. BUILD ARCHERS — ONLY archers, always
    n_archers   = len(my_archers)
    n_units_now = len(my_units)

    # How many archers do we want?
    # EXPAND: minimal — just 1-2 to scout/hold territory
    # MASS: flood archers until threshold
    # SWARM/KITE/SIEGE: replace fallen archers
    if mode == "EXPAND":
        want_archers = max(2, len(my_cities))
    elif mode == "MASS":
        want_archers = MASS_THRESHOLD + len(my_cities)
    else:
        # SWARM/KITE/SIEGE: maintain 2 archers per city, at least mass_threshold
        want_archers = max(MASS_THRESHOLD, len(my_cities) * 2)

    # Reload gold after city build
    gold = estimate_gold(state, my_team)
    for a in actions:
        if a["action"] == "BUILD_CITY":
            gold -= city_cost

    cities_used = set()
    for city in my_cities:
        if n_archers >= want_archers:
            break
        key = (city["x"], city["y"])
        if key in unit_pos or key in cities_used:
            continue
        cost = UNIT_COSTS["ARCHER"]
        if gold < cost + GOLD_BUFFER:
            continue
        upkeep_after = compute_upkeep(n_units_now + 1, len(my_cities))
        if upkeep_after > gold - cost:
            continue
        actions.append({"action": "BUILD_UNIT",
                         "city_x": key[0], "city_y": key[1], "unit_type": "ARCHER"})
        gold -= cost
        n_archers += 1
        n_units_now += 1
        cities_used.add(key)

    # 4. MOVE ARCHERS
    # Sort: archers closest to danger move first (respond to threats quickly)
    enemy_raiders = [(u["x"], u["y"]) for u in state["units"]
                     if u["owner"] != my_team and u["type"] == "RAIDER"]

    def danger_sort(u):
        if enemy_raiders:
            return min(chebyshev(u["x"], u["y"], rx, ry) for rx, ry in enemy_raiders)
        return 999

    moving_pos = dict(unit_pos)

    for unit in sorted(my_archers, key=danger_sort):
        can_move = unit.get("can_move_next_turn", unit.get("canMove", True))
        if not can_move:
            continue
        mv = best_move(unit, state, my_team, set(moving_pos.keys()), ex, W, mode)
        if mv:
            actions.append({
                "action": "MOVE",
                "from_x": unit["x"], "from_y": unit["y"],
                "to_x": mv[0], "to_y": mv[1],
            })
            del moving_pos[(unit["x"], unit["y"])]
            moving_pos[mv] = unit

    return actions


# ── WebSocket client ───────────────────────────────────────────────────────────

async def main():
    global team_id, _weights, best_weights, history, _game_stats

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
                        _game_stats = {"peak_territory": 0, "peak_archers": 0}

                    elif msg["type"] == "TURN_START":
                        state = msg["state"]
                        turn  = msg.get("turn", 0)
                        if team_id is not None:
                            territory = sum(1 for t in state["map"]["tiles"]
                                            if t.get("owner") == team_id)
                            n_archers = sum(1 for u in state["units"]
                                            if u.get("owner") == team_id and u.get("type") == "ARCHER")
                            _game_stats["peak_territory"] = max(_game_stats["peak_territory"], territory)
                            _game_stats["peak_archers"]   = max(_game_stats["peak_archers"], n_archers)
                            try:
                                actions = generate_actions(state, team_id, turn)
                                await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": actions}))
                            except Exception as e:
                                print(f"[ArcherSwarmBot] Error: {e}")
                                await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": []}))

                    elif msg["type"] == "GAME_OVER":
                        winner    = msg.get("winner")
                        outcome   = "win" if winner == team_id else "loss" if winner is not None else "draw"
                        scores    = msg.get("scores", {})
                        my_score  = scores.get(str(team_id), 0)
                        opp_score = next((v for k, v in scores.items() if k != str(team_id)), 0)
                        score_delta = my_score - opp_score

                        history.append({
                            "outcome":        outcome,
                            "score_delta":    score_delta,
                            "opponent":       OPPONENT,
                            "peak_territory": _game_stats["peak_territory"],
                            "peak_archers":   _game_stats["peak_archers"],
                        })
                        save_history(history)
                        _weights, best_weights = maybe_evolve(history, _weights, best_weights)
                        apply_weights(_weights)

        except Exception as e:
            print(f"[ArcherSwarmBot] Connection error: {e} — reconnecting in 3s")
            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
