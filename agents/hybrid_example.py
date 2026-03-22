"""
Hybrid Python bot — balances economy, military pressure, and map control.

Each turn the bot detects its current strategic mode and adapts:

  DEFEND  — enemy soldier is close to one of our cities
            → pull soldiers back, build defenders, protect at all cost

  FINISH  — a soldier can step onto an enemy city this or next turn
            → rush that city, ignore economy temporarily

  PRESSURE — enemy has far fewer units than us
            → push forward hard, take territory, threaten cities

  CONTEST — default; fight for monuments and map control
            → balanced army, hold monuments, stay forward

  GREED   — we are safe and have enough gold / stable economy
            → build next city, expand territory, reinvest income

Unit roles are assigned each turn:
  Soldiers  → defend threatened cities, capture enemy cities, ZoC pressure
  Archers   → stay behind the soldier frontline, target enemy soldiers
  Raiders   → avoid enemy soldiers, plunder deep territory, kill exposed archers

Run:
  python3 agents/hybrid_example.py

Files written next to this script:
  hybrid_weights.json      — current weights (being tested)
  hybrid_best_weights.json — best weights found so far (always kept safe)
  hybrid_history.json      — per-game results + stats log
"""

import asyncio, json, os, random, math

SERVER_URL = os.environ.get("SERVER_URL", "ws://localhost:8080")
PASSWORD   = os.environ.get("PASSWORD", "player")
TEAM       = int(os.environ.get("TEAM", "0"))
NAME       = os.environ.get("BOT_NAME", "HybridBot")
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
EVAL_EVERY      = 5      # evaluate weights every N games
KEEP_THRESHOLD  = 0.55   # keep weights if win-rate >= this
MUTATION_SIGMA  = 0.15   # std-dev of Gaussian weight perturbation (as fraction)
HISTORY_WINDOW  = 30     # games to look back when evaluating win-rate

SCRIPT_DIR           = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_FILE         = os.path.join(SCRIPT_DIR, "hybrid_weights.json")
BEST_WEIGHTS_FILE    = os.path.join(SCRIPT_DIR, "hybrid_best_weights.json")
HISTORY_FILE         = os.path.join(SCRIPT_DIR, "hybrid_history.json")

DEFAULT_WEIGHTS = {
    # ── base movement scoring ──────────────────────────────────────────────
    "w_forward":        6.0,   # moderate forward push (mode multipliers amplify this)
    "w_enemy_city":    20.0,   # soldiers care strongly about approaching enemy cities
    "w_enemy_unit":     5.0,   # engage enemies in range
    "w_monument":      14.0,   # contest monuments actively
    "w_raid_tile":      8.0,   # step onto enemy territory while passing
    "w_city_capture": 100.0,   # always capture enemy cities if reachable
    "w_monument_guard":20.0,   # hold monuments once we have them
    "w_plunder":       12.0,   # raiders reward per enemy tile in 3x3 area
    "w_zoc_offense":   10.0,   # pin enemy archers/raiders with soldiers
    "w_archer_range":   8.0,   # archers sit at range 2, penalise range 1

    # ── mode-specific multipliers (applied on top of base scoring) ─────────
    "defend_pull":     20.0,   # how hard units pull toward threatened city in DEFEND
    "pressure_push":   10.0,   # extra forward score per tile in PRESSURE / FINISH
    "greed_expand":     6.0,   # extra expansion tiles scored in GREED

    # ── building targets ───────────────────────────────────────────────────
    "max_cities":       4.0,
    "soldiers_per_city":2.0,
    "archers_per_city": 1.0,
    "raiders_per_city": 0.5,
    "max_expands":      5.0,
    "gold_buffer":     25.0,
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
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(history, f, indent=2)
    os.replace(tmp, HISTORY_FILE)


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
    "w_forward":         (3,   15),
    "w_enemy_city":      (15,  40),
    "w_enemy_unit":      (2,   15),
    "w_monument":        (10,  25),
    "w_raid_tile":       (3,   18),
    "w_city_capture":    (90, 150),
    "w_monument_guard":  (10,  22),  # was 30 — too high pins units at monuments
    "w_plunder":         (4,   25),
    "w_zoc_offense":     (4,   12),  # was 20 — too high makes soldiers ignore cities
    "w_archer_range":    (5,   15),  # raised floor — archers must value positioning
    "defend_pull":       (10,  35),
    "pressure_push":     (5,   20),
    "greed_expand":      (2,   15),
    "max_cities":        (2,    6),
    "soldiers_per_city": (1,    3),
    "archers_per_city":  (1.0,  3),  # raised floor from 0.5 — always build archers
    "raiders_per_city":  (0.3,  1.5),
    "max_expands":       (2,    6),  # lowered ceiling from 12 — stop over-expanding
    "gold_buffer":       (22,  50),
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
        pass


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

    # Losing on score with poor monument control (< 20 turns across losses on avg)
    if score_losses:
        avg_mon = sum(g.get("monument_turns", 0) for g in score_losses) / len(score_losses)
        if avg_mon < 20:
            hints["w_monument_guard"] = +4.0
            hints["w_monument"]       = +2.0

    # Losing on score with low territory (< 40 peak tiles on avg)
    if score_losses:
        avg_terr = sum(g.get("peak_territory", 0) for g in score_losses) / len(score_losses)
        if avg_terr < 40:
            hints["max_expands"]  = +1.0
            hints["w_raid_tile"]  = +2.0

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


    # If current weights improved on best, save them as new best
    if fitness > prev_fitness:
        best_weights = dict(weights)
        save_best_weights(best_weights)

    # Adaptive sigma: explore more aggressively when losing badly
    # fitness < 0 means losing on average; scale sigma by loss magnitude
    adaptive_sigma = MUTATION_SIGMA * (1.0 + max(0.0, -fitness) / 5000.0)
    adaptive_sigma = min(adaptive_sigma, MUTATION_SIGMA * 3.0)  # cap at 3x

    hints = diagnose_losses(history, HISTORY_WINDOW)
    weight_sanity_check(weights)

    # Always mutate from best weights, not current (prevents compounding bad mutations)
    new_w = mutate(best_weights, sigma=adaptive_sigma, hints=hints)
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


# Tracks enemy unit type sightings across all turns this game.
# Uses exponential decay so recent observations matter more than early ones.
_enemy_composition = {"SOLDIER": 0.0, "ARCHER": 0.0, "RAIDER": 0.0}
_COMPOSITION_DECAY = 0.92   # older turns fade to 92% weight each turn


def update_enemy_composition(enemy_units: list):
    """Decay existing counts and add current visible enemies."""
    for k in _enemy_composition:
        _enemy_composition[k] *= _COMPOSITION_DECAY
    for u in enemy_units:
        t = u.get("type")
        if t in _enemy_composition:
            _enemy_composition[t] += 1.0


def counter_build_priority(enemy_units: list) -> list:
    # Blend current visible units (weight 2x) with accumulated history (weight 1x)
    # so fog-of-war gaps don't erase what we've already learned about the opponent
    blended = {
        "SOLDIER": _enemy_composition["SOLDIER"] + 2 * sum(1 for u in enemy_units if u["type"] == "SOLDIER"),
        "ARCHER":  _enemy_composition["ARCHER"]  + 2 * sum(1 for u in enemy_units if u["type"] == "ARCHER"),
        "RAIDER":  _enemy_composition["RAIDER"]  + 2 * sum(1 for u in enemy_units if u["type"] == "RAIDER"),
    }
    dominant = max(blended, key=blended.get)
    sorted_enemy = sorted(blended, key=lambda t: blended[t], reverse=True)
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


# ── strategic mode detection ──────────────────────────────────────────────────

def detect_mode(state, my_team, gold, turn=0):
    """
    Determine the strategic mode for this turn.
    Returns one of: DEFEND, FINISH, PRESSURE, GREED, CONTEST, TURTLE, ALLOUT
    """
    my_cities    = [c for c in state["cities"] if c["owner"] == my_team]
    enemy_cities = [c for c in state["cities"] if c["owner"] != my_team]
    my_units     = [u for u in state["units"] if u["owner"] == my_team]
    enemy_units  = [u for u in state["units"] if u["owner"] != my_team]
    my_soldiers  = [u for u in my_units  if u["type"] == "SOLDIER"]
    enemy_soldiers = [u for u in enemy_units if u["type"] == "SOLDIER"]

    # Score delta for endgame awareness
    players = state.get("players", [])
    me  = next((p for p in players if p["id"] == my_team), None)
    opp = next((p for p in players if p["id"] != my_team), None)
    score_delta = (me["score"] - opp["score"]) if me and opp else 0

    # TURTLE: late game and winning comfortably — hold what we have
    if turn >= 300 and score_delta >= 3000:
        return "TURTLE"

    # ALLOUT: late game and losing — ignore economy, rush everything
    if turn >= 280 and score_delta <= -2000:
        return "ALLOUT"

    # DEFEND: any enemy soldier/raider within 4 tiles of one of our cities
    enemy_raiders = [u for u in enemy_units if u["type"] == "RAIDER"]
    for city in my_cities:
        for sol in enemy_soldiers:
            if chebyshev(city["x"], city["y"], sol["x"], sol["y"]) <= 4:
                return "DEFEND"
        for raider in enemy_raiders:
            if chebyshev(city["x"], city["y"], raider["x"], raider["y"]) <= 3:
                return "DEFEND"

    # FINISH: one of our soldiers is adjacent to an enemy city (can capture next turn)
    for sol in my_soldiers:
        for city in enemy_cities:
            if chebyshev(sol["x"], sol["y"], city["x"], city["y"]) <= 1:
                return "FINISH"

    # DISRUPT: enemy has more cities than us — attack their economy before it snowballs
    # This counters econ-style bots that expand fast and overwhelm later
    if len(enemy_cities) > len(my_cities) + 1:
        return "PRESSURE"

    # DISRUPT: enemy controls significantly more territory — push back now
    my_tiles    = sum(1 for t in state["map"]["tiles"] if t.get("owner") == my_team)
    enemy_tiles = sum(1 for t in state["map"]["tiles"] if t.get("owner") != my_team
                      and t.get("owner") is not None)
    if enemy_tiles > my_tiles * 1.6 and turn < 250:
        return "PRESSURE"

    # Score-aware: winning big → expand economy
    if score_delta >= 5000 and not enemy_soldiers:
        return "GREED"

    # Score-aware: losing → apply more pressure
    if score_delta <= -3000 and len(my_units) > 0:
        return "PRESSURE"

    # PRESSURE: we have significantly more units than the enemy
    if len(enemy_units) > 0 and len(my_units) >= len(enemy_units) * 1.5:
        return "PRESSURE"

    # GREED: safe (no nearby threats), have enough gold for a city, below city cap
    city_cost = round(80 * (1.5 ** max(0, len(my_cities) - 1)))
    w = weights
    if (gold >= city_cost + w["gold_buffer"] and
            len(my_cities) < int(w["max_cities"]) and
            not enemy_soldiers and not enemy_raiders):
        return "GREED"

    return "CONTEST"


def assign_unit_roles(state, my_team, mode):
    """
    Assign a role to each friendly unit based on mode and game state.
    Returns dict: (unit_x, unit_y) -> role string

    Roles:
      "defend"   — soldier recalled to protect a threatened city
      "finish"   — soldier rushing a capturable enemy city
      "monument" — unit assigned to guard/contest a monument
      "attack"   — soldier pushing toward enemy
      "support"  — archer staying behind the frontline
      "raid"     — raider going deep for plunder
    """
    my_units     = [u for u in state["units"] if u["owner"] == my_team]
    my_cities    = [c for c in state["cities"] if c["owner"] == my_team]
    enemy_cities = [c for c in state["cities"] if c["owner"] != my_team]
    enemy_soldiers = [(u["x"], u["y"]) for u in state["units"]
                      if u["owner"] != my_team and u["type"] == "SOLDIER"]
    monuments    = state.get("monuments", [])

    roles    = {}
    assigned = set()

    # TURTLE: all units defend their nearest city
    if mode == "TURTLE":
        for unit in my_units:
            roles[(unit["x"], unit["y"])] = "defend"
        return roles

    # ALLOUT: all soldiers rush enemy cities, archers support, raiders raid
    if mode == "ALLOUT":
        for unit in my_units:
            if unit["type"] == "SOLDIER":
                roles[(unit["x"], unit["y"])] = "finish"
            elif unit["type"] == "ARCHER":
                roles[(unit["x"], unit["y"])] = "support"
            else:
                roles[(unit["x"], unit["y"])] = "raid"
        return roles

    # 1. DEFEND: assign closest soldier to each threatened city
    if mode == "DEFEND":
        for city in my_cities:
            threatened = any(chebyshev(city["x"], city["y"], sx, sy) <= 4
                             for sx, sy in enemy_soldiers)
            if not threatened:
                continue
            candidates = [u for u in my_units
                          if u["type"] == "SOLDIER" and (u["x"], u["y"]) not in assigned]
            if candidates:
                closest = min(candidates, key=lambda u: chebyshev(u["x"], u["y"], city["x"], city["y"]))
                roles[(closest["x"], closest["y"])] = "defend"
                assigned.add((closest["x"], closest["y"]))

    # 2. FINISH: assign soldiers that are adjacent to enemy cities
    if mode == "FINISH":
        for city in enemy_cities:
            candidates = [u for u in my_units
                          if u["type"] == "SOLDIER"
                          and (u["x"], u["y"]) not in assigned
                          and chebyshev(u["x"], u["y"], city["x"], city["y"]) <= 2]
            if candidates:
                closest = min(candidates, key=lambda u: chebyshev(u["x"], u["y"], city["x"], city["y"]))
                roles[(closest["x"], closest["y"])] = "finish"
                assigned.add((closest["x"], closest["y"]))

    # 3. MONUMENT: assign 2 units to uncontrolled monuments, 1 to monuments we already hold
    for mon in sorted(monuments, key=lambda m: 0 if m.get("controlledBy") != my_team else 1):
        slots = 2 if mon.get("controlledBy") != my_team else 1
        for _ in range(slots):
            available = [u for u in my_units if (u["x"], u["y"]) not in assigned]
            if not available:
                break
            closest = min(available, key=lambda u: chebyshev(u["x"], u["y"], mon["x"], mon["y"]))
            roles[(closest["x"], closest["y"])] = "monument"
            assigned.add((closest["x"], closest["y"]))

    # 4. Remaining units get default roles by type
    for unit in my_units:
        pos = (unit["x"], unit["y"])
        if pos in roles:
            continue
        if unit["type"] == "SOLDIER":
            roles[pos] = "attack"
        elif unit["type"] == "ARCHER":
            roles[pos] = "support"
        else:
            roles[pos] = "raid"

    return roles


# ── movement scoring ───────────────────────────────────────────────────────────

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


def best_move(unit, state, my_team, unit_positions, ex, W, danger: float = 0.0,
              monument_target=None, mode="CONTEST", role="attack"):
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

    lethal_enemy_pos = [
        (u["x"], u["y"]) for u in state["units"]
        if u["owner"] != my_team and u["type"] in LETHAL_THREATS[unit["type"]]
    ]

    # BFS distance maps — aware of water/obstacles, prevents units getting stuck
    ec_dist  = bfs_distances(tile_lut, W, H, enemy_cities) if enemy_cities else {}
    eu_dist  = bfs_distances(tile_lut, W, H, enemy_units)  if enemy_units  else {}
    mon_dist = bfs_distances(tile_lut, W, H, monuments)    if monuments    else {}
    oc_dist  = bfs_distances(tile_lut, W, H, own_cities)   if own_cities   else {}

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

                # ── role & mode overlays ────────────────────────────────
                # DEFEND role: pull unit back toward nearest own city
                if role == "defend" and own_cities:
                    od = oc_dist.get((ux, uy), 999)
                    nd = oc_dist.get((tx, ty), 999)
                    score += (od - nd) * w["defend_pull"]

                # FINISH role: soldier rushes the nearest capturable enemy city
                if role == "finish" and enemy_cities:
                    od = ec_dist.get((ux, uy), 999)
                    nd = ec_dist.get((tx, ty), 999)
                    score += (od - nd) * w["pressure_push"] * 2.0

                # PRESSURE / CONTEST: stronger forward push
                if mode in ("PRESSURE", "FINISH") and role == "attack":
                    score += (abs(ux - ex) - abs(tx - ex)) * w["pressure_push"]

                # SUPPORT role (archers): stay behind the soldier frontline
                if role == "support":
                    my_soldiers = [(u["x"], u["y"]) for u in state["units"]
                                   if u["owner"] == my_team and u["type"] == "SOLDIER"]
                    if my_soldiers:
                        # frontline = farthest allied soldier toward enemy side
                        if ex == W - 1:
                            frontline_x = max(sx for sx, sy in my_soldiers)
                            if tx > frontline_x + 1:
                                score -= 20.0   # don't advance past soldiers
                        else:
                            frontline_x = min(sx for sx, sy in my_soldiers)
                            if tx < frontline_x - 1:
                                score -= 20.0

                # RAID role (raiders): prefer tiles adjacent to enemy archers, avoid soldiers
                if role == "raid":
                    enemy_archers = [(u["x"], u["y"]) for u in state["units"]
                                     if u["owner"] != my_team and u["type"] == "ARCHER"]
                    if enemy_archers:
                        nd = min(chebyshev(tx, ty, ax, ay) for ax, ay in enemy_archers)
                        od = min(chebyshev(ux, uy, ax, ay) for ax, ay in enemy_archers)
                        score += (od - nd) * w["w_enemy_unit"]
                    # Penalise moving adjacent to enemy soldiers (0x damage but die to ZoC)
                    enemy_sol_pos = [(u["x"], u["y"]) for u in state["units"]
                                     if u["owner"] != my_team and u["type"] == "SOLDIER"]
                    adj_soldiers = sum(1 for sx, sy in enemy_sol_pos
                                       if chebyshev(tx, ty, sx, sy) <= 1)
                    score -= adj_soldiers * 12.0

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

def generate_actions(state, my_team, turn=0):
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

    # Update enemy composition tracker with currently visible units
    enemy_units_all = [u for u in state["units"] if u["owner"] != my_team]
    update_enemy_composition(enemy_units_all)

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

    # Detect mode early so expand and build steps can react to it
    mode  = detect_mode(state, my_team, gold, turn)
    roles = assign_unit_roles(state, my_team, mode)

    # Initial priority by counter; overridden below after mode detection
    build_priority = counter_build_priority(enemy_units_all)

    # 3. EXPAND TERRITORY — boost expansion in PRESSURE/DISRUPT to match econ bots
    expand_limit = int(w["max_expands"])
    if mode == "PRESSURE":
        expand_limit = max(expand_limit, int(w["max_expands"]) + 4)
    elif mode == "TURTLE":
        expand_limit = 2   # minimal expansion when holding score lead
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
                candidates.append((abs(nb[0] - ex), nb))
        candidates.sort(key=lambda x: x[0])
        for _, (nx, ny) in candidates[:max_exp]:
            if gold < 5:
                break
            actions.append({"action": "EXPAND_TERRITORY", "x": nx, "y": ny})
            gold -= 5

    # Mode-aware build priority override
    if mode == "TURTLE":
        build_priority = ["SOLDIER", "ARCHER", "RAIDER"]   # defensive only
    elif mode == "ALLOUT":
        build_priority = ["SOLDIER", "SOLDIER", "ARCHER"]  # flood soldiers
    elif mode in ("DEFEND", "FINISH"):
        build_priority = ["SOLDIER", "ARCHER", "RAIDER"]
    elif mode == "GREED":
        build_priority = ["RAIDER", "ARCHER", "SOLDIER"]   # income-friendly army
    # else: counter_build_priority already computed above

    # TURTLE: skip city building entirely — save gold for units
    if mode == "TURTLE":
        actions = [a for a in actions if a["action"] != "BUILD_CITY"]
        if actions and actions and any(a["action"] == "BUILD_CITY" for a in actions):
            gold += city_cost  # refund if we removed it

    # Rebuild units with potentially new priority
    cities_used = set()
    # Remove any build-unit actions added above (re-run cleanly with mode priority)
    actions = [a for a in actions if a["action"] != "BUILD_UNIT"]
    # Reload gold used before unit building (after city build)
    gold = estimate_gold_after_income(state, my_team)
    if actions and actions[0]["action"] == "BUILD_CITY":
        gold -= city_cost   # city_cost was computed before my_cities was extended
    n_units_now = len(my_units)
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
            upkeep_after = compute_upkeep(n_units_now + 1, len(my_cities))
            if upkeep_after > gold - cost:
                continue
            actions.append({"action": "BUILD_UNIT", "city_x": key[0], "city_y": key[1], "unit_type": utype})
            gold -= cost
            unit_counts[utype] += 1
            n_units_now += 1
            cities_used.add(key)
            break

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
        danger    = threat_level(unit, state, my_team)
        mon_target = monument_assignments.get((unit["x"], unit["y"]))
        role      = roles.get((unit["x"], unit["y"]), "attack")
        pos = best_move(unit, state, my_team, set(moving_pos.keys()), ex, W, danger, mon_target,
                        mode=mode, role=role)
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
                        _game_stats = {"monument_turns": 0, "peak_territory": 0, "peak_cities": 0}
                        # Reset composition tracker for new game
                        for k in _enemy_composition:
                            _enemy_composition[k] = 0.0

                    elif msg["type"] == "TURN_START":
                        last_state  = msg["state"]
                        current_turn = msg.get("turn", 0)

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
                            actions = generate_actions(last_state, team_id, current_turn)
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
                        print(f"{outcome.upper()} Δ{score_delta:+.0f} wr={wr:.0%} games={len(history)}")

                        weights, best_weights = maybe_evolve(history, weights, best_weights)

                    elif msg["type"] == "AUTH_FAILED":
                        print(f"[bot] Auth failed: {msg['reason']}")
                        return

        except Exception as e:
            print(f"[bot] Disconnected: {e}")
            await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
