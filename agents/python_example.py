"""
Improved Python bot with self-learning via weight evolution.

How it learns:
  - All scoring decisions are driven by a WEIGHTS dict
  - After every game the result (win/loss/score) is written to learn_history.json
  - Every EVAL_EVERY games the fitness (mean score_delta) is evaluated:
      * If fitness improved → save as new best weights
      * Mutate is always applied to the BEST weights seen so far (not the current
        possibly-bad ones), so the search never drifts far from a known good config
      * Mutation sigma scales with recent performance: losing badly → explore more
      * Directional hints nudge weights toward fixing the diagnosed loss cause:
          - Elimination losses  → more military, less gold buffer
          - Score losses w/ few monuments → stronger monument weights
          - Score losses w/ low territory → expand more
  - In-game stats (monument control turns, peak territory, peak cities) are
    recorded per game and used to diagnose loss causes at eval time

Run:
  python3 agents/python_example.py

Files written next to this script:
  learn_weights.json      — current weights (being tested)
  learn_best_weights.json — best weights found so far (always kept safe)
  learn_history.json      — per-game results + stats log
"""

import asyncio, json, os, random, math

SERVER_URL = os.environ.get("SERVER_URL", "ws://localhost:8080")
PASSWORD   = os.environ.get("PASSWORD", "player")
TEAM       = int(os.environ.get("TEAM", "0"))
NAME       = os.environ.get("BOT_NAME", "PyBot")
OPPONENT   = os.environ.get("OPPONENT", "unknown")   # set by train.py on each rotation

team_id = None

UNIT_COSTS    = {"SOLDIER": 20, "ARCHER": 25, "RAIDER": 15}
UNIT_MOVEMENT = {"SOLDIER": 1,  "ARCHER": 1,  "RAIDER": 2}
UNIT_MAX_HP   = {"SOLDIER": 2,  "ARCHER": 2,  "RAIDER": 1}
ADJ = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]

# Counter triangle: COUNTER[enemy_type] = unit_type_that_beats_it
# Archer 2x vs Soldier, Raider 2x vs Archer, Soldier 2x vs Raider
COUNTER = {"SOLDIER": "ARCHER", "ARCHER": "RAIDER", "RAIDER": "SOLDIER"}

# Which enemy types can kill this unit in one hit (used for danger assessment)
LETHAL_THREATS = {
    "SOLDIER": {"ARCHER"},   # archers one-shot soldiers
    "ARCHER":  {"RAIDER"},   # raiders one-shot archers
    "RAIDER":  {"ARCHER"},   # archers one-shot raiders (soldiers do 0)
}

# ── learning constants ─────────────────────────────────────────────────────────
EVAL_EVERY      = 10     # evaluate weights every N games
KEEP_THRESHOLD  = 0.55   # keep weights if win-rate >= this
MUTATION_SIGMA  = 0.12   # std-dev of Gaussian weight perturbation (as fraction)
HISTORY_WINDOW  = 20     # games to look back when evaluating win-rate

SCRIPT_DIR           = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_FILE         = os.path.join(SCRIPT_DIR, "learn_weights.json")
BEST_WEIGHTS_FILE    = os.path.join(SCRIPT_DIR, "learn_best_weights.json")
HISTORY_FILE         = os.path.join(SCRIPT_DIR, "learn_history.json")

DEFAULT_WEIGHTS = {
    "w_forward":        8.0,   # reward for pushing toward enemy side
    "w_enemy_city":    15.0,   # reward for soldiers approaching enemy city
    "w_enemy_unit":     5.0,   # reward for approaching any enemy unit
    "w_monument":       6.0,   # reward for approaching uncontrolled monument
    "w_raid_tile":      8.0,   # bonus for stepping onto enemy territory
    "w_city_capture": 100.0,   # bonus for soldiers stepping onto enemy city
    "w_monument_guard":20.0,   # reward per step closer for monument guard units
    "w_plunder":       10.0,   # reward per enemy tile in raider's 3x3 plunder area
    "w_zoc_offense":    8.0,   # reward for soldiers moving within ZoC range of enemy archers/raiders
    "w_archer_range":   6.0,   # reward for archers staying at fire range 2; penalty for range 1 (melee)
    "max_cities":       4.0,   # build cities up to this count
    "soldiers_per_city":2.0,   # target soldiers = this * num_cities
    "archers_per_city": 1.0,   # target archers = ceil(this * num_cities); was 0.5 (never built with 1 city)
    "raiders_per_city": 0.5,   # target raiders = ceil(this * num_cities); was 0.33
    "max_expands":      5.0,   # max territory expansions per turn
    "gold_buffer":     30.0,   # keep this much gold in reserve before building a city
}

# ── weight persistence ─────────────────────────────────────────────────────────

def _clamp_weights(w: dict) -> dict:
    """Clamp all weights to their sane ranges in-place and return w."""
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


def load_history() -> list:
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return []


def save_history(history: list):
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)


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


def filter_by_opponent(history: list, window: int) -> list:
    """
    Return the last `window` games filtered to the current OPPONENT.
    Falls back to all recent games if no opponent-tagged entries exist
    (e.g. when running manually without train.py).
    """
    tagged = [g for g in history if g.get("opponent") == OPPONENT]
    if len(tagged) >= window // 2:
        return tagged[-window:]
    return history[-window:]   # fallback: use all recent games


def compute_fitness(history: list, window: int) -> float:
    """
    Continuous fitness: mean score_delta over recent games vs current opponent.
    Much more informative than binary win/loss — winning by 20,000 vs 100 matters.
    """
    recent = filter_by_opponent(history, window)
    if not recent:
        return 0.0
    return sum(g["score_delta"] for g in recent) / len(recent)


def win_rate(history: list, window: int) -> float:
    recent = filter_by_opponent(history, window)
    if not recent:
        return 0.5
    wins = sum(1 for g in recent if g["outcome"] == "win")
    return wins / len(recent)


# Reasonable bounds for each weight — warn if evolution drifts outside these
WEIGHT_SANITY = {
    "w_forward":         (3,   20),
    "w_enemy_city":      (8,   40),
    "w_enemy_unit":      (1,   15),
    "w_monument":        (2,   15),
    "w_raid_tile":       (2,   20),
    "w_city_capture":    (70, 150),   # must stay high — capturing cities is critical
    "w_monument_guard":  (8,   40),
    "w_plunder":         (2,   25),
    "w_zoc_offense":     (2,   20),   # was drifting to 49 — cap tightened
    "w_archer_range":    (2,   15),
    "max_cities":        (2,    6),
    "soldiers_per_city": (1,    4),
    "archers_per_city":  (0.5,  2),
    "raiders_per_city":  (0,  1.5),
    "max_expands":       (3,   12),
    "gold_buffer":       (22,  50),   # must stay positive — 0 causes bankruptcy
}


def weight_sanity_check(w: dict):
    """Clamp any weight that has drifted outside its expected range and warn."""
    clamped = []
    for k, (lo, hi) in WEIGHT_SANITY.items():
        v = w.get(k)
        if v is not None and not (lo <= v <= hi):
            w[k] = max(lo, min(hi, v))
            clamped.append(f"  {k}: {v:.2f} → {w[k]:.2f} (range {lo}–{hi})")
    if clamped:
        print("[learn] Clamped out-of-range weights:")
        for line in clamped:
            print(line)


def diagnose_losses(history: list, window: int) -> dict:
    """
    Analyse recent losses vs current opponent and return directional hints.
    Each hint is an additive nudge on top of the base weight value.

    Diagnosed patterns:
      - Many elimination losses    → need more/better military
      - Score losses + few monument turns → need to contest monuments more
      - Score losses + low peak territory → need to expand more aggressively
    """
    recent  = filter_by_opponent(history, window)
    losses  = [g for g in recent if g["outcome"] != "win"]
    if not losses:
        return {}

    hints = {}
    elim_losses  = [g for g in losses if g.get("reason") == "elimination"]
    score_losses = [g for g in losses if g.get("reason") == "score"]

    # Getting eliminated often: boost military, ease gold buffer
    if len(elim_losses) >= 2:
        hints["soldiers_per_city"] = +0.4
        hints["gold_buffer"]       = -5.0
        print(f"[learn] Diagnosis: {len(elim_losses)} elimination losses → boosting military")

    # Losing on score with poor monument control (< 20 turns across losses on avg)
    if score_losses:
        avg_mon = sum(g.get("monument_turns", 0) for g in score_losses) / len(score_losses)
        if avg_mon < 20:
            hints["w_monument_guard"] = +4.0
            hints["w_monument"]       = +2.0
            print(f"[learn] Diagnosis: score losses with avg {avg_mon:.0f} monument turns → boosting monument weights")

    # Losing on score with low territory (< 40 peak tiles on avg)
    if score_losses:
        avg_terr = sum(g.get("peak_territory", 0) for g in score_losses) / len(score_losses)
        if avg_terr < 40:
            hints["max_expands"]  = +1.0
            hints["w_raid_tile"]  = +2.0
            print(f"[learn] Diagnosis: score losses with avg {avg_terr:.0f} peak territory → boosting expansion")

    return hints


def mutate(w: dict, sigma: float = MUTATION_SIGMA, hints: dict = None) -> dict:
    """
    Return a copy of weights with Gaussian noise applied.
    hints: optional additive nudges applied to the mean of the Gaussian per key.
    sigma: controls exploration width; scale up when losing badly.
    """
    hints = hints or {}
    new_w = {}
    for k, v in w.items():
        mean_shift = hints.get(k, 0.0)
        noise = random.gauss(mean_shift, abs(v) * sigma + 0.5)
        if k in ("max_cities", "max_expands"):
            new_w[k] = max(1.0, v + noise)
        elif k in ("soldiers_per_city", "archers_per_city", "raiders_per_city"):
            new_w[k] = max(0.0, v + noise)
        else:
            new_w[k] = max(0.0, v + noise)
    return new_w


def maybe_evolve(history: list, weights: dict, best_weights: dict) -> tuple:
    """
    Evaluate performance and decide on next weights.
    Always mutates from best_weights (not current), so search never drifts.
    Returns (new_weights, new_best_weights).
    """
    n = len(history)
    if n == 0 or n % EVAL_EVERY != 0:
        return weights, best_weights

    wr      = win_rate(history, HISTORY_WINDOW)
    fitness = compute_fitness(history, HISTORY_WINDOW)

    # Compute fitness of best weights by looking at the history window before
    # the last EVAL_EVERY games (i.e. what fitness was when best was saved)
    prev_fitness = compute_fitness(history[:-EVAL_EVERY], HISTORY_WINDOW)

    print(f"[learn] games={n}  win_rate={wr:.0%}  fitness={fitness:+.0f}  "
          f"prev_fitness={prev_fitness:+.0f}  "
          f"weights={json.dumps({k: round(v,2) for k,v in weights.items()})}")

    # If current weights improved on best, save them as new best
    if fitness > prev_fitness:
        best_weights = dict(weights)
        save_best_weights(best_weights)
        print(f"[learn] New best weights saved (fitness {fitness:+.0f} > {prev_fitness:+.0f})")

    # Adaptive sigma: explore more aggressively when losing badly
    # fitness < 0 means losing on average; scale sigma by loss magnitude
    adaptive_sigma = MUTATION_SIGMA * (1.0 + max(0.0, -fitness) / 5000.0)
    adaptive_sigma = min(adaptive_sigma, MUTATION_SIGMA * 3.0)  # cap at 3x

    hints = diagnose_losses(history, HISTORY_WINDOW)
    weight_sanity_check(weights)

    # Always mutate from best weights, not current (prevents compounding bad mutations)
    new_w = mutate(best_weights, sigma=adaptive_sigma, hints=hints)
    print(f"[learn] Mutating from best weights (sigma={adaptive_sigma:.2f})")
    save_weights(new_w)
    return new_w, best_weights


# ── economy helpers ────────────────────────────────────────────────────────────

def compute_upkeep(n_units: int, n_cities: int) -> float:
    """Geometric upkeep formula from the game spec."""
    excess = max(0, n_units - n_cities)
    if excess == 0:
        return 0.0
    return 2.0 * (1.5 ** excess - 1)


def estimate_gold_after_income(state, my_team) -> float:
    """
    Estimate gold available after the income phase this turn.
    Uses: current_gold + tile_income + city_income - upkeep
    This matches what smarterAgent does with player.gold + player.income.
    """
    player     = next(p for p in state["players"] if p["id"] == my_team)
    n_tiles    = sum(1 for t in state["map"]["tiles"] if t.get("owner") == my_team)
    n_cities   = sum(1 for c in state["cities"] if c["owner"] == my_team)
    n_units    = sum(1 for u in state["units"] if u["owner"] == my_team)
    income     = n_tiles * 0.5 + n_cities * 5.0
    upkeep     = compute_upkeep(n_units, n_cities)
    return player["gold"] + income - upkeep


# ── game helpers ───────────────────────────────────────────────────────────────

def chebyshev(x1, y1, x2, y2):
    return max(abs(x1 - x2), abs(y1 - y2))


def enemy_side_x(state, my_team):
    W  = state["map"]["width"]
    cx = W // 2
    my_cities = [c for c in state["cities"] if c["owner"] == my_team]
    if not my_cities:
        return W - 1 if my_team == 0 else 0
    cap = min(my_cities, key=lambda c: abs(c["x"] - cx))
    return W - 1 if cap["x"] < cx else 0


def in_zoc(unit, enemy_soldiers):
    if unit["type"] == "SOLDIER":
        return False
    for sx, sy in enemy_soldiers:
        if chebyshev(unit["x"], unit["y"], sx, sy) <= 2:
            return True
    return False


def counter_build_priority(enemy_units: list) -> list:
    counts = {"SOLDIER": 0, "ARCHER": 0, "RAIDER": 0}
    for u in enemy_units:
        counts[u["type"]] = counts.get(u["type"], 0) + 1
    sorted_enemy = sorted(counts, key=lambda t: counts[t], reverse=True)
    priority = [COUNTER[t] for t in sorted_enemy]
    seen, result = set(), []
    for t in priority:
        if t not in seen:
            seen.add(t)
            result.append(t)
    for t in ["SOLDIER", "ARCHER", "RAIDER"]:
        if t not in seen:
            result.append(t)
    return result


def threat_level(unit: dict, state: dict, my_team: int) -> float:
    utype   = unit["type"]
    hp      = unit.get("hp", UNIT_MAX_HP[utype])
    max_hp  = UNIT_MAX_HP[utype]
    hp_frac = hp / max_hp

    lethal = LETHAL_THREATS[utype]
    danger = 0.0

    for enemy in state["units"]:
        if enemy["owner"] == my_team:
            continue
        etype = enemy["type"]
        dist  = chebyshev(unit["x"], unit["y"], enemy["x"], enemy["y"])

        if etype in lethal:
            strike_range = 2 if etype in ("ARCHER", "RAIDER") else 1
            if dist <= strike_range:
                danger += (1.0 / max(dist, 1)) * 3.0
        else:
            if dist <= 1:
                danger += 0.5

    return danger * (2.0 - hp_frac)


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


def assign_monument_guards(state, my_team, my_units) -> dict:
    """
    For each monument not controlled by us, assign the closest available unit.
    Returns dict: unit (x,y) -> (monument_x, monument_y).

    In tournament mode (2 monuments in side lanes), this ensures dedicated units
    contest both monuments rather than leaving them ignored.
    """
    monuments = state.get("monuments", [])
    if not monuments:
        return {}

    assignments = {}
    assigned = set()

    # Sort monuments: uncontrolled/enemy first, then ones we already hold
    def mon_priority(m):
        if m.get("controlledBy") != my_team:
            return 0   # need to contest
        return 1       # already ours but keep a unit there

    for mon in sorted(monuments, key=mon_priority):
        mx, my = mon["x"], mon["y"]
        available = [u for u in my_units if (u["x"], u["y"]) not in assigned]
        if not available:
            break
        closest = min(available, key=lambda u: chebyshev(u["x"], u["y"], mx, my))
        assignments[(closest["x"], closest["y"])] = (mx, my)
        assigned.add((closest["x"], closest["y"]))

    return assignments


def bfs_distances(tile_lut, W, H, targets):
    """
    BFS from all target positions across walkable (FIELD) tiles.
    Returns dict: (x, y) -> shortest walkable distance to nearest target.
    Unreachable tiles are absent from the dict (treat as 999).
    """
    from collections import deque
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

# ── movement scoring ───────────────────────────────────────────────────────────

def best_move(unit, state, my_team, unit_positions, ex, W, danger: float = 0.0,
              monument_target=None):
    """
    Score every reachable tile and return the best (tx, ty), or None.

    monument_target: (mx, my) if this unit is assigned as a monument guard.
      - If already adjacent to the monument, don't move (return None).
      - Otherwise, move toward the monument.

    When danger > 0 the unit is endangered and retreat scoring kicks in.
    """
    tile_lut     = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    H            = state["map"]["height"]
    movement     = UNIT_MOVEMENT[unit["type"]]
    enemy_cities = [(c["x"], c["y"]) for c in state["cities"] if c["owner"] != my_team]
    enemy_units  = [(u["x"], u["y"]) for u in state["units"]  if u["owner"] != my_team]
    own_cities   = [(c["x"], c["y"]) for c in state["cities"] if c["owner"] == my_team]
    monuments    = [(m["x"], m["y"]) for m in state.get("monuments", [])
                    if m.get("controlledBy") != my_team]
    enemy_city_set = set(enemy_cities)

    # BFS distance maps — aware of water/obstacles, prevents units getting stuck
    ec_dist  = bfs_distances(tile_lut, W, H, enemy_cities) if enemy_cities else {}
    eu_dist  = bfs_distances(tile_lut, W, H, enemy_units)  if enemy_units  else {}
    mon_dist = bfs_distances(tile_lut, W, H, monuments)    if monuments    else {}
    oc_dist  = bfs_distances(tile_lut, W, H, own_cities)   if own_cities   else {}

    lethal_enemy_pos = [
        (u["x"], u["y"]) for u in state["units"]
        if u["owner"] != my_team and u["type"] in LETHAL_THREATS[unit["type"]]
    ]

    w = weights
    retreating = danger >= 1.5
    ux, uy = unit["x"], unit["y"]

    # Monument guard: if already adjacent, don't move
    if monument_target is not None:
        mx, my = monument_target
        if chebyshev(ux, uy, mx, my) <= 1:
            return None

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

            # ── MONUMENT GUARD MODE ─────────────────────────────────────────
            if monument_target is not None and not retreating:
                mx, my = monument_target
                od = chebyshev(ux, uy, mx, my)
                nd = chebyshev(tx, ty, mx, my)
                score += (od - nd) * w["w_monument_guard"]
                # Still penalise walking into danger
                if danger > 0 and lethal_enemy_pos:
                    nd_lethal = min(chebyshev(tx, ty, ex2, ey2) for ex2, ey2 in lethal_enemy_pos)
                    if nd_lethal <= 2:
                        score -= danger * 3.0

            elif retreating:
                # ── RETREAT MODE ────────────────────────────────────────────
                if lethal_enemy_pos:
                    od = min(chebyshev(ux, uy, tx2, ty2) for tx2, ty2 in lethal_enemy_pos)
                    nd = min(chebyshev(tx, ty, tx2, ty2) for tx2, ty2 in lethal_enemy_pos)
                    score += (nd - od) * danger * 6.0

                if own_cities:
                    od = oc_dist.get((ux, uy), 999)
                    nd = oc_dist.get((tx, ty), 999)
                    score += (od - nd) * danger * 4.0

                if tile.get("owner") not in (None, my_team):
                    score -= 10.0

                nearby_enemies = sum(
                    1 for ex2, ey2 in enemy_units
                    if chebyshev(tx, ty, ex2, ey2) <= 1
                )
                score -= nearby_enemies * 8.0

            else:
                # ── ATTACK MODE ─────────────────────────────────────────────
                score += (abs(ux - ex) - abs(tx - ex)) * w["w_forward"]

                # Penalise hugging map edges — units cluster there when routing around water
                if ty == 0 or ty == H - 1:
                    score -= 4.0
                if ty == 1 or ty == H - 2:
                    score -= 2.0

                if unit["type"] == "SOLDIER" and enemy_cities:
                    od = ec_dist.get((ux, uy), 999)
                    nd = ec_dist.get((tx, ty), 999)
                    score += (od - nd) * w["w_enemy_city"]

                if enemy_units:
                    od = eu_dist.get((ux, uy), 999)
                    nd = eu_dist.get((tx, ty), 999)
                    score += (od - nd) * w["w_enemy_unit"]

                if monuments:
                    od = mon_dist.get((ux, uy), 999)
                    nd = mon_dist.get((tx, ty), 999)
                    score += (od - nd) * w["w_monument"]

                if tile.get("owner") not in (None, my_team):
                    score += w["w_raid_tile"]

                if unit["type"] == "SOLDIER" and (tx, ty) in enemy_city_set:
                    score += w["w_city_capture"]

                # Raiders: reward landing where the 3x3 plunder area hits enemy tiles
                if unit["type"] == "RAIDER":
                    plunder_tiles = sum(
                        1 for pdx in range(-1, 2) for pdy in range(-1, 2)
                        if tile_lut.get((tx + pdx, ty + pdy), {}).get("owner") not in (None, my_team)
                    )
                    score += plunder_tiles * w["w_plunder"]

                # Soldiers: reward moving within ZoC range (≤2) of enemy archers/raiders
                # Pinned archers/raiders can't move — huge tactical advantage
                if unit["type"] == "SOLDIER":
                    enemy_ranged = [(u["x"], u["y"]) for u in state["units"]
                                    if u["owner"] != my_team and u["type"] in ("ARCHER", "RAIDER")]
                    if enemy_ranged:
                        now_pinned = sum(1 for ex2, ey2 in enemy_ranged
                                         if chebyshev(ux, uy, ex2, ey2) <= 2)
                        new_pinned = sum(1 for ex2, ey2 in enemy_ranged
                                         if chebyshev(tx, ty, ex2, ey2) <= 2)
                        score += (new_pinned - now_pinned) * w["w_zoc_offense"]

                # Archers: reward sitting at fire range 2 (can shoot, hard to melee)
                # Penalise stepping into range 1 (exposed to melee)
                if unit["type"] == "ARCHER" and enemy_units:
                    min_dist = min(chebyshev(tx, ty, ex2, ey2) for ex2, ey2 in enemy_units)
                    if min_dist == 1:
                        score -= w["w_archer_range"]   # walking into melee — bad
                    elif min_dist == 2:
                        score += w["w_archer_range"]   # optimal fire position

                # Light caution in attack mode when injured
                if danger > 0 and lethal_enemy_pos:
                    nd = min(chebyshev(tx, ty, tx2, ty2) for tx2, ty2 in lethal_enemy_pos)
                    if nd <= 2:
                        score -= danger * 3.0

            if score > best_score or (score == best_score and random.random() < 0.3):
                best_score, best_pos = score, (tx, ty)

    if retreating:
        return best_pos
    return best_pos if best_score > 0 else None


# ── main action generator ──────────────────────────────────────────────────────

def generate_actions(state, my_team):
    w         = weights
    actions   = []
    tile_lut  = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    unit_pos  = {(u["x"], u["y"]): u for u in state["units"]}
    city_pos  = {(c["x"], c["y"]) for c in state["cities"]}
    my_units  = [u for u in state["units"]  if u["owner"] == my_team]
    my_cities = [c for c in state["cities"] if c["owner"] == my_team]
    W         = state["map"]["width"]
    ex        = enemy_side_x(state, my_team)

    # Use post-income gold estimate so we don't under-spend
    gold = estimate_gold_after_income(state, my_team)

    enemy_soldiers = [(u["x"], u["y"]) for u in state["units"]
                      if u["owner"] != my_team and u["type"] == "SOLDIER"]

    # 1. BUILD CITY
    city_cost = round(80 * (1.5 ** max(0, len(my_cities) - 1)))
    # Keep a gold buffer so we can still build units after paying for the city
    if gold >= city_cost + w["gold_buffer"] and len(my_cities) < int(w["max_cities"]):
        conn = connected_territory(state, my_team)
        candidates = []
        for pos in conn:
            tile = tile_lut.get(pos)
            if not tile or tile["type"] != "FIELD":
                continue
            if pos in city_pos or pos in unit_pos:
                continue
            fwd  = abs(pos[0] - ex)
            gap  = min((chebyshev(pos[0], pos[1], c["x"], c["y"]) for c in my_cities), default=0)
            candidates.append((-fwd * 2 + min(gap, 5) * 3, pos))
        if candidates:
            _, (bx, by) = max(candidates)
            actions.append({"action": "BUILD_CITY", "x": bx, "y": by})
            gold -= city_cost
            city_pos.add((bx, by))
            my_cities.append({"x": bx, "y": by, "owner": my_team})

    # 2. BUILD UNITS
    enemy_units_all = [u for u in state["units"] if u["owner"] != my_team]
    n_cities     = len(my_cities)
    unit_counts  = {"SOLDIER": 0, "ARCHER": 0, "RAIDER": 0}
    for u in my_units:
        unit_counts[u["type"]] += 1

    # Use math.ceil so archers/raiders are wanted even with 1 city
    # (previously round(1 * 0.5) = 0, so they were never built early game)
    want = {
        "SOLDIER": max(1, round(n_cities * w["soldiers_per_city"])),
        "ARCHER":  max(0, math.ceil(n_cities * w["archers_per_city"])),
        "RAIDER":  max(0, math.ceil(n_cities * w["raiders_per_city"])),
    }

    # Don't build if projected upkeep after build would be too high
    n_units_now = len(my_units)

    build_priority = counter_build_priority(enemy_units_all)
    cities_used = set()
    for city in my_cities:
        key = (city["x"], city["y"])
        if key in unit_pos or key in cities_used:
            continue
        for utype in build_priority:
            if unit_counts[utype] >= want[utype]:
                continue
            cost = UNIT_COSTS[utype]
            if gold < cost:
                continue
            # Check upkeep won't bankrupt us next turn
            upkeep_after = compute_upkeep(n_units_now + 1, n_cities)
            if upkeep_after > gold - cost:
                continue
            actions.append({"action": "BUILD_UNIT", "city_x": key[0], "city_y": key[1], "unit_type": utype})
            gold -= cost
            unit_counts[utype] += 1
            n_units_now += 1
            cities_used.add(key)
            break

    # 3. EXPAND TERRITORY
    max_exp = min(int(w["max_expands"]), int(gold // 5))
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
                candidates.append((abs(nb[0] - ex), nb))
        candidates.sort(key=lambda x: x[0])
        for _, (nx, ny) in candidates[:max_exp]:
            if gold < 5:
                break
            actions.append({"action": "EXPAND_TERRITORY", "x": nx, "y": ny})
            gold -= 5

    # 4. MOVE UNITS
    # Assign monument guards before movement so dedicated units go to monuments
    monument_assignments = assign_monument_guards(state, my_team, my_units)

    moving_pos = dict(unit_pos)

    def danger_key(u):
        return -threat_level(u, state, my_team)   # most endangered first

    for unit in sorted(my_units, key=danger_key):
        # Support both canMove (legacy) and can_move_next_turn (newer server versions)
        can_move = unit.get("can_move_next_turn", unit.get("canMove", True))
        if not can_move:
            continue
        if in_zoc(unit, enemy_soldiers):
            continue
        danger = threat_level(unit, state, my_team)
        mon_target = monument_assignments.get((unit["x"], unit["y"]))
        pos = best_move(unit, state, my_team, set(moving_pos.keys()), ex, W, danger, mon_target)
        if pos:
            actions.append({
                "action": "MOVE",
                "from_x": unit["x"], "from_y": unit["y"],
                "to_x": pos[0], "to_y": pos[1],
            })
            del moving_pos[(unit["x"], unit["y"])]
            moving_pos[pos] = unit

    return actions


# ── WebSocket client ───────────────────────────────────────────────────────────

weights      = load_weights()
best_weights = load_best_weights()
history      = load_history()
print(f"[learn] Loaded {len(history)} games of history")
print(f"[learn] Current weights: {json.dumps({k: round(v,2) for k,v in weights.items()})}")

# Per-game stats reset each game; recorded into history at GAME_OVER
_game_stats = {"monument_turns": 0, "peak_territory": 0, "peak_cities": 0}


async def main():
    global team_id, weights, best_weights, history, _game_stats

    while True:
        try:
            import websockets
            async with websockets.connect(SERVER_URL) as ws:
                await ws.send(json.dumps({
                    "type": "AUTH", "password": PASSWORD,
                    "name": NAME, "preferredTeam": TEAM,
                }))

                last_state = None

                async for raw in ws:
                    msg = json.loads(raw)

                    if msg["type"] == "AUTH_SUCCESS":
                        team_id     = msg["teamId"]
                        print(f"[bot] Team {team_id}")
                        _game_stats = {"monument_turns": 0, "peak_territory": 0, "peak_cities": 0}

                    elif msg["type"] == "TURN_START":
                        last_state = msg["state"]

                        if team_id is not None:
                            mon_controlled = sum(
                                1 for m in last_state.get("monuments", [])
                                if m.get("controlledBy") == team_id
                            )
                            if mon_controlled > 0:
                                _game_stats["monument_turns"] += 1

                            territory = sum(
                                1 for t in last_state["map"]["tiles"]
                                if t.get("owner") == team_id
                            )
                            _game_stats["peak_territory"] = max(_game_stats["peak_territory"], territory)

                            cities = sum(1 for c in last_state["cities"] if c["owner"] == team_id)
                            _game_stats["peak_cities"] = max(_game_stats["peak_cities"], cities)

                        try:
                            actions = generate_actions(last_state, team_id)
                            await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": actions}))
                        except Exception as e:
                            print(f"[bot] Error generating actions: {e}")
                            await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": []}))

                    elif msg["type"] == "GAME_OVER":
                        winner = msg.get("winner")
                        if winner == team_id:
                            outcome = "win"
                        elif winner is None:
                            outcome = "tie"
                        else:
                            outcome = "loss"

                        score_delta = 0
                        if last_state:
                            me = next((p for p in last_state["players"] if p["id"] == team_id), None)
                            en = next((p for p in last_state["players"] if p["id"] != team_id), None)
                            if me and en:
                                score_delta = me["score"] - en["score"]

                        record = {
                            "outcome":        outcome,
                            "score_delta":    score_delta,
                            "reason":         msg.get("reason"),
                            "opponent":       OPPONENT,
                            "monument_turns": _game_stats["monument_turns"],
                            "peak_territory": _game_stats["peak_territory"],
                            "peak_cities":    _game_stats["peak_cities"],
                        }
                        history.append(record)
                        save_history(history)

                        wr      = win_rate(history, HISTORY_WINDOW)
                        fitness = compute_fitness(history, HISTORY_WINDOW)
                        print(f"[bot] {outcome.upper()} (Δscore={score_delta:+.0f})  "
                              f"win-rate={wr:.0%}  fitness={fitness:+.0f}  games={len(history)}  "
                              f"mon_turns={_game_stats['monument_turns']}  "
                              f"peak_terr={_game_stats['peak_territory']}")

                        weights, best_weights = maybe_evolve(history, weights, best_weights)

                    elif msg["type"] == "AUTH_FAILED":
                        print(f"[bot] Auth failed: {msg['reason']}")
                        return

        except Exception as e:
            print(f"[bot] Disconnected: {e}")
            await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
