"""
Improved Python bot with self-learning via weight evolution.

How it learns:
  - All scoring decisions are driven by a WEIGHTS dict
  - After every game the result (win/loss/score) is written to learn_history.json
  - Every EVAL_EVERY games the win-rate is checked:
      * If win-rate >= KEEP_THRESHOLD  → weights are good, keep them
      * If win-rate <  KEEP_THRESHOLD  → mutate weights (random Gaussian noise)
  - The best weights seen so far are always saved to learn_weights.json

Run:
  python3 agents/python_example.py

Files written next to this script:
  learn_weights.json   — current (best) weights
  learn_history.json   — per-game results log
"""

import asyncio, json, os, random, math

SERVER_URL = os.environ.get("SERVER_URL", "ws://localhost:8080")
PASSWORD   = os.environ.get("PASSWORD", "player")
TEAM       = int(os.environ.get("TEAM", "0"))
NAME       = os.environ.get("BOT_NAME", "PyBot")

team_id = None

UNIT_COSTS    = {"SOLDIER": 20, "ARCHER": 25, "RAIDER": 15}
UNIT_MOVEMENT = {"SOLDIER": 1,  "ARCHER": 1,  "RAIDER": 2}
UNIT_MAX_HP   = {"SOLDIER": 2,  "ARCHER": 2,  "RAIDER": 1}
ADJ = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]

# Counter triangle: COUNTER[enemy_type] = unit_type_that_beats_it
# Archer 2x vs Soldier, Raider 2x vs Archer, Soldier 2x vs Raider
COUNTER = {"SOLDIER": "ARCHER", "ARCHER": "RAIDER", "RAIDER": "SOLDIER"}

# Which enemy types can kill this unit in one hit (used for danger assessment)
# ARCHER shoots Soldier 2x (dead), RAIDER hits Archer 2x (dead), SOLDIER hits Raider 2x (dead)
LETHAL_THREATS = {
    "SOLDIER": {"ARCHER"},   # archers one-shot soldiers
    "ARCHER":  {"RAIDER"},   # raiders one-shot archers
    "RAIDER":  {"ARCHER"},   # archers one-shot raiders (soldiers do 0)
}

# ── learning constants ─────────────────────────────────────────────────────────
EVAL_EVERY      = 10     # evaluate weights every N games
KEEP_THRESHOLD  = 0.55   # keep weights if win-rate >= this
MUTATION_SIGMA  = 0.25   # std-dev of Gaussian weight perturbation (as fraction)
HISTORY_WINDOW  = 20     # games to look back when evaluating win-rate

SCRIPT_DIR      = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_FILE    = os.path.join(SCRIPT_DIR, "learn_weights.json")
HISTORY_FILE    = os.path.join(SCRIPT_DIR, "learn_history.json")

# Default weights — these are the values being evolved
DEFAULT_WEIGHTS = {
    "w_forward":        8.0,   # reward for pushing toward enemy side
    "w_enemy_city":    15.0,   # reward for soldiers approaching enemy city
    "w_enemy_unit":     5.0,   # reward for approaching any enemy unit
    "w_monument":       6.0,   # reward for approaching uncontrolled monument
    "w_raid_tile":      8.0,   # bonus for stepping onto enemy territory
    "w_city_capture": 100.0,   # bonus for soldiers stepping onto enemy city
    "max_cities":       4.0,   # build cities up to this count
    "soldiers_per_city":2.0,   # target soldiers = this * num_cities
    "archers_per_city": 0.5,   # target archers = this * num_cities
    "raiders_per_city": 0.33,  # target raiders = this * num_cities
    "max_expands":      5.0,   # max territory expansions per turn
}

# ── weight persistence ─────────────────────────────────────────────────────────

def load_weights() -> dict:
    if os.path.exists(WEIGHTS_FILE):
        try:
            with open(WEIGHTS_FILE) as f:
                w = json.load(f)
            # Fill in any missing keys from defaults
            for k, v in DEFAULT_WEIGHTS.items():
                w.setdefault(k, v)
            return w
        except Exception:
            pass
    return dict(DEFAULT_WEIGHTS)


def save_weights(w: dict):
    with open(WEIGHTS_FILE, "w") as f:
        json.dump(w, f, indent=2)


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


def mutate(w: dict) -> dict:
    """Return a copy of weights with Gaussian noise applied to each value."""
    new_w = {}
    for k, v in w.items():
        noise = random.gauss(0, abs(v) * MUTATION_SIGMA + 0.5)
        if k in ("max_cities", "max_expands"):
            new_w[k] = max(1.0, v + noise)
        elif k in ("soldiers_per_city", "archers_per_city", "raiders_per_city"):
            new_w[k] = max(0.0, v + noise)
        else:
            new_w[k] = max(0.0, v + noise)
    return new_w


def win_rate(history: list, window: int) -> float:
    recent = history[-window:]
    if not recent:
        return 0.5
    wins = sum(1 for g in recent if g["outcome"] == "win")
    return wins / len(recent)


def maybe_evolve(history: list, weights: dict) -> dict:
    """Check performance and mutate weights if needed."""
    n = len(history)
    if n == 0 or n % EVAL_EVERY != 0:
        return weights

    wr = win_rate(history, HISTORY_WINDOW)
    print(f"[learn] games={n}  win_rate={wr:.0%}  weights_snapshot={json.dumps({k: round(v,2) for k,v in weights.items()})}")

    if wr >= KEEP_THRESHOLD:
        print(f"[learn] Win rate {wr:.0%} >= {KEEP_THRESHOLD:.0%} → keeping weights")
        save_weights(weights)
        return weights
    else:
        new_w = mutate(weights)
        print(f"[learn] Win rate {wr:.0%} < {KEEP_THRESHOLD:.0%} → mutating weights")
        save_weights(new_w)
        return new_w


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
    """
    Return unit types in build-priority order based on enemy composition.
    Counts each enemy type and prioritises building the hard counter.
    e.g. enemy has many archers → build raiders first (raiders 2x vs archers).
    Falls back to a balanced order when enemy composition is unknown/even.
    """
    counts = {"SOLDIER": 0, "ARCHER": 0, "RAIDER": 0}
    for u in enemy_units:
        counts[u["type"]] = counts.get(u["type"], 0) + 1

    # Sort enemy types by count descending; build counter to the most common
    sorted_enemy = sorted(counts, key=lambda t: counts[t], reverse=True)
    priority = [COUNTER[t] for t in sorted_enemy]

    # Deduplicate while preserving order
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
    """
    Return a threat score for a unit (0 = safe, >0 = should consider retreating).
    Higher means more danger. Accounts for:
      - HP relative to max HP
      - Presence of lethal-threat enemies within striking range
    """
    utype   = unit["type"]
    hp      = unit.get("hp", UNIT_MAX_HP[utype])
    max_hp  = UNIT_MAX_HP[utype]
    hp_frac = hp / max_hp   # 1.0 = full, 0.5 = half, etc.

    lethal = LETHAL_THREATS[utype]
    danger = 0.0

    for enemy in state["units"]:
        if enemy["owner"] == my_team:
            continue
        etype = enemy["type"]
        dist  = chebyshev(unit["x"], unit["y"], enemy["x"], enemy["y"])

        if etype in lethal:
            # Lethal threat: archer range 2, raider movement 2, soldier melee 1
            strike_range = 2 if etype in ("ARCHER", "RAIDER") else 1
            if dist <= strike_range:
                danger += (1.0 / max(dist, 1)) * 3.0   # closer = more danger
        else:
            # Non-lethal but still in melee reach
            if dist <= 1:
                danger += 0.5

    # Scale by how injured the unit is: full HP halves the danger score
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


def best_move(unit, state, my_team, unit_positions, ex, W, danger: float = 0.0):
    """
    Score every reachable tile and return the best (tx, ty), or None.

    When danger > 0 the unit is endangered and retreat scoring kicks in:
      - Moving away from threats is rewarded
      - Moving toward own cities/territory is rewarded
      - Normal forward-push and attack bonuses are suppressed
    The higher the danger value the stronger the retreat pull.
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

    # Lethal threats for this unit — used for retreat direction
    lethal_enemy_pos = [
        (u["x"], u["y"]) for u in state["units"]
        if u["owner"] != my_team and u["type"] in LETHAL_THREATS[unit["type"]]
    ]

    w = weights
    retreating = danger >= 1.5   # threshold to flip into full retreat mode
    best_score, best_pos = -999, None
    ux, uy = unit["x"], unit["y"]

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

            if retreating:
                # ── RETREAT MODE ─────────────────────────────────────────────
                # Move away from lethal threats
                if lethal_enemy_pos:
                    od = min(chebyshev(ux, uy, tx2, ty2) for tx2, ty2 in lethal_enemy_pos)
                    nd = min(chebyshev(tx, ty, tx2, ty2) for tx2, ty2 in lethal_enemy_pos)
                    score += (nd - od) * danger * 6.0   # increasing distance = good

                # Move toward nearest own city (safety)
                if own_cities:
                    od = min(chebyshev(ux, uy, cx, cy) for cx, cy in own_cities)
                    nd = min(chebyshev(tx, ty, cx, cy) for cx, cy in own_cities)
                    score += (od - nd) * danger * 4.0

                # Avoid stepping onto enemy territory while retreating
                if tile.get("owner") not in (None, my_team):
                    score -= 10.0

                # Avoid tiles adjacent to any enemy
                nearby_enemies = sum(
                    1 for ex2, ey2 in enemy_units
                    if chebyshev(tx, ty, ex2, ey2) <= 1
                )
                score -= nearby_enemies * 8.0

            else:
                # ── ATTACK MODE ──────────────────────────────────────────────
                score += (abs(ux - ex) - abs(tx - ex)) * w["w_forward"]

                if unit["type"] == "SOLDIER" and enemy_cities:
                    nd = min(chebyshev(tx, ty, cx, cy) for cx, cy in enemy_cities)
                    od = min(chebyshev(ux, uy, cx, cy) for cx, cy in enemy_cities)
                    score += (od - nd) * w["w_enemy_city"]

                if enemy_units:
                    nd = min(chebyshev(tx, ty, ex2, ey2) for ex2, ey2 in enemy_units)
                    od = min(chebyshev(ux, uy, ex2, ey2) for ex2, ey2 in enemy_units)
                    score += (od - nd) * w["w_enemy_unit"]

                if monuments:
                    nd = min(chebyshev(tx, ty, mx, my) for mx, my in monuments)
                    od = min(chebyshev(ux, uy, mx, my) for mx, my in monuments)
                    score += (od - nd) * w["w_monument"]

                if tile.get("owner") not in (None, my_team):
                    score += w["w_raid_tile"]

                if unit["type"] == "SOLDIER" and (tx, ty) in enemy_city_set:
                    score += w["w_city_capture"]

                # Small caution: even in attack mode, slightly penalise walking
                # into lethal range at low HP (danger > 0 but < threshold)
                if danger > 0 and lethal_enemy_pos:
                    nd = min(chebyshev(tx, ty, tx2, ty2) for tx2, ty2 in lethal_enemy_pos)
                    if nd <= 2:
                        score -= danger * 3.0

            if score > best_score or (score == best_score and random.random() < 0.3):
                best_score, best_pos = score, (tx, ty)

    # In retreat mode always move if possible; in attack mode only if score > 0
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
    player    = next(p for p in state["players"] if p["id"] == my_team)
    gold      = player["gold"]
    W         = state["map"]["width"]
    ex        = enemy_side_x(state, my_team)

    enemy_soldiers = [(u["x"], u["y"]) for u in state["units"]
                      if u["owner"] != my_team and u["type"] == "SOLDIER"]

    # 1. BUILD CITY
    city_cost = round(80 * (1.5 ** max(0, len(my_cities) - 1)))
    if gold >= city_cost and len(my_cities) < int(w["max_cities"]):
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

    # 2. BUILD UNITS (counter-build based on enemy composition)
    enemy_units_all = [u for u in state["units"] if u["owner"] != my_team]
    n_cities     = len(my_cities)
    unit_counts  = {"SOLDIER": 0, "ARCHER": 0, "RAIDER": 0}
    for u in my_units:
        unit_counts[u["type"]] += 1

    want = {
        "SOLDIER": max(1, round(n_cities * w["soldiers_per_city"])),
        "ARCHER":  max(0, round(n_cities * w["archers_per_city"])),
        "RAIDER":  max(0, round(n_cities * w["raiders_per_city"])),
    }

    # Determine build priority: counter the enemy's most common type first,
    # but only if we actually need more of that counter unit.
    build_priority = counter_build_priority(enemy_units_all)

    cities_used = set()
    for city in my_cities:
        key = (city["x"], city["y"])
        if key in unit_pos or key in cities_used:
            continue
        for utype in build_priority:
            if unit_counts[utype] < want[utype] and gold >= UNIT_COSTS[utype]:
                actions.append({"action": "BUILD_UNIT", "city_x": key[0], "city_y": key[1], "unit_type": utype})
                gold -= UNIT_COSTS[utype]
                unit_counts[utype] += 1
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

    # 4. MOVE UNITS (retreat endangered units first so they get first pick of tiles)
    moving_pos = dict(unit_pos)

    def danger_key(u):
        return -threat_level(u, state, my_team)   # most endangered first

    for unit in sorted(my_units, key=danger_key):
        if not unit.get("canMove", True):
            continue
        if in_zoc(unit, enemy_soldiers):
            continue
        danger = threat_level(unit, state, my_team)
        pos = best_move(unit, state, my_team, set(moving_pos.keys()), ex, W, danger)
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

weights = load_weights()
history = load_history()
print(f"[learn] Loaded {len(history)} games of history")
print(f"[learn] Current weights: {json.dumps({k: round(v,2) for k,v in weights.items()})}")


async def main():
    global team_id, weights, history

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
                        team_id = msg["teamId"]
                        print(f"[bot] Team {team_id}")

                    elif msg["type"] == "TURN_START":
                        last_state = msg["state"]
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

                        # Grab final score delta from last known state
                        score_delta = 0
                        if last_state:
                            me = next((p for p in last_state["players"] if p["id"] == team_id), None)
                            en = next((p for p in last_state["players"] if p["id"] != team_id), None)
                            if me and en:
                                score_delta = me["score"] - en["score"]

                        record = {"outcome": outcome, "score_delta": score_delta, "reason": msg.get("reason")}
                        history.append(record)
                        save_history(history)

                        wr = win_rate(history, HISTORY_WINDOW)
                        print(f"[bot] {outcome.upper()} (Δscore={score_delta:+.0f})  "
                              f"recent win-rate={wr:.0%}  games={len(history)}")

                        weights = maybe_evolve(history, weights)

                    elif msg["type"] == "AUTH_FAILED":
                        print(f"[bot] Auth failed: {msg['reason']}")
                        return

        except Exception as e:
            print(f"[bot] Disconnected: {e}")
            await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
