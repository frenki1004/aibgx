import asyncio, json, os, random

SERVER_URL = os.environ.get("SERVER_URL", "ws://localhost:8080")
PASSWORD = os.environ.get("PASSWORD", "player")
TEAM = int(os.environ.get("TEAM", "0"))
NAME = os.environ.get("BOT_NAME", "PyBot")

team_id = None


def generate_actions(state, my_team):
    actions = []
    my_units = [u for u in state["units"] if u["owner"] == my_team]
    my_cities = [c for c in state["cities"] if c["owner"] == my_team]
    player = next(p for p in state["players"] if p["id"] == my_team)

    dirs = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
    tile_lookup = {(t["x"], t["y"]): t for t in state["map"]["tiles"]}
    unit_positions = {(u["x"], u["y"]) for u in state["units"]}

    for unit in my_units:
        if not unit.get("canMove", True):
            continue
        random.shuffle(dirs)
        for dx, dy in dirs:
            tx, ty = unit["x"] + dx, unit["y"] + dy
            tile = tile_lookup.get((tx, ty))
            if not tile or tile["type"] != "FIELD" or (tx, ty) in unit_positions:
                continue
            actions.append({
                "action": "MOVE",
                "from_x": unit["x"], "from_y": unit["y"],
                "to_x": tx, "to_y": ty,
            })
            unit_positions.discard((unit["x"], unit["y"]))
            unit_positions.add((tx, ty))
            break

    costs = {"SOLDIER": 20, "ARCHER": 25, "RAIDER": 15}
    gold = player["gold"]
    for city in my_cities:
        if (city["x"], city["y"]) in unit_positions:
            continue
        unit_type = random.choice(["SOLDIER", "ARCHER", "RAIDER"])
        if gold >= costs[unit_type]:
            actions.append({
                "action": "BUILD_UNIT",
                "city_x": city["x"], "city_y": city["y"],
                "unit_type": unit_type,
            })
            gold -= costs[unit_type]

    return actions


async def main():
    global team_id
    import websockets

    while True:
        try:
            async with websockets.connect(SERVER_URL) as ws:
                await ws.send(json.dumps({
                    "type": "AUTH", "password": PASSWORD,
                    "name": NAME, "preferredTeam": TEAM,
                }))

                async for raw in ws:
                    msg = json.loads(raw)

                    if msg["type"] == "AUTH_SUCCESS":
                        team_id = msg["teamId"]
                        print(f"Team {team_id}")

                    elif msg["type"] == "TURN_START":
                        try:
                            actions = generate_actions(msg["state"], team_id)
                            await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": actions}))
                        except Exception as e:
                            print(f"Error: {e}")
                            await ws.send(json.dumps({"type": "SUBMIT_ACTIONS", "actions": []}))

                    elif msg["type"] == "GAME_OVER":
                        result = "WON" if msg["winner"] == team_id else (
                            "TIE" if msg["winner"] is None else "LOST")
                        print(f"{result} ({msg['reason']})")

                    elif msg["type"] == "AUTH_FAILED":
                        print(f"Auth failed: {msg['reason']}")
                        return

        except Exception as e:
            print(f"Disconnected: {e}")
            await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())