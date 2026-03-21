# Data Extraction and Self-Play

The `logic/` folder is a standalone, zero-dependency Node.js module. You can run full games headlessly without a server or frontend.

## Standalone Logic

```bash
cd logic
# No install needed
```

```javascript
const logic = require('./logic');

// Create a game
const state = logic.createInitialState({ mode: 'blitz' });

// Process a turn
const result = logic.processTurn(state, {
  player0: [
    { action: 'MOVE', from_x: 2, from_y: 5, to_x: 3, to_y: 5 },
    { action: 'EXPAND_TERRITORY', x: 3, y: 4 },
  ],
  player1: [{ action: 'BUILD_UNIT', city_x: 12, city_y: 5, unit_type: 'SOLDIER' }],
});
// result.newState, result.errors, result.info

// ASCII visualization
logic.printState(state);
logic.printEvents(result.info.turnEvents);
```

## Key Functions

All exports from `require('./logic')` (or `require('../logic')` from the project root):

**Core**

- `createInitialState({ mode })` -> `state` -- Create a new game. Mode is `"blitz"`, `"standard"`, or `"tournament"`.
- `processTurn(state, { player0: [], player1: [] })` -> `{ newState, errors, info }` -- Process one turn. Does not mutate the input state.
- `validateAction(state, playerId, action)` -> `{ valid, error }` -- Check if a single action is valid. Returns `{ valid: true }` or `{ valid: false, error: "reason" }`.
- `validateActions(state, playerId, actions)` -> `{ valid, errors }` -- Check multiple actions. Returns `{ valid: true/false, errors: [...] }`.

**State helpers**

- `cloneState(state)` -> `state` -- Deep copy (JSON round-trip).
- `calculateIncome(state, playerId)` -> `number` -- Total income from territory + cities.
- `getCityCost(state, playerId)` -> `number` -- Cost of the next city for this player.
- `getTile(state, x, y)` -> `tile` -- Tile at position.
- `getUnit(state, x, y)` -> `unit | null` -- Unit at position.
- `getCity(state, x, y)` -> `city | null` -- City at position.

**Geometry**

- `chebyshevDistance(x1, y1, x2, y2)` -> `number` -- `max(|dx|, |dy|)`.
- `manhattanDistance(x1, y1, x2, y2)` -> `number` -- `|dx| + |dy|`.
- `getTilesAtDistance1(x, y)` -> `[{x, y}]` -- 8 adjacent positions.
- `isInBounds(x, y, mapWidth, mapHeight)` -> `boolean`
- `isAdjacentToOwnTerritory(state, x, y, playerId)` -> `boolean` -- Is the tile adjacent to connected territory?
- `isPassable(state, x, y)` -> `boolean` -- Can units enter this tile?
- `isInZoC(state, unit)` -> `boolean` -- Is the unit in an enemy soldier's Zone of Control?
- `getConnectedTerritory(state, playerId)` -> `Set<"x,y">` -- All territory connected to a city.

**Fog of war**

- `computeVision(state, playerId)` -> `Set<"x,y">` -- All tiles visible to this player.
- `filterStateForPlayer(state, playerId, visibleTiles)` -> `state` -- Remove hidden info.
- `filterEventsForPlayer(events, playerId, visibleTiles)` -> `events` -- Remove hidden events.

**Terminal**

- `printState(state)` -- Print ASCII map to stdout.
- `printEvents(events)` -- Print events to stdout.
- `renderState(state)` -> `string` -- ASCII map as a string.
- `renderEvents(events)` -> `string` -- Events as a string.

**Constants**

All constants are also exported: `UNIT_STATS`, `ECONOMY`, `SCORING`, `DAMAGE_MULTIPLIERS`, `MODES`, `MODE_SETTINGS`, `VISION`, `TERRAIN`, `TERRAIN_PROPS`, `UNIT_TYPES`, `ACTIONS`, `DISTANCE_1_OFFSETS`.

**Map generation**

- `generateMap(width, height, seed)` -> `map` -- Generate a symmetrical island map.
- `generateTournamentMap(width, height, seed)` -> `map` -- Generate a 3-lane tournament map with rivers.
- `validateMap(map)` -> `{ valid, errors }` -- Check map validity.

## Headless Self-Play (JavaScript)

Run thousands of games in a tight loop. No server, no network, no timeouts. Each bot receives a fog-filtered state, just like on the real server.

```javascript
const logic = require('./logic');

function randomAgent(state, teamId) {
  const actions = [];
  const myUnits = state.units.filter((u) => u.owner === teamId);
  const dirs = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  for (const unit of myUnits) {
    if (!unit.canMove) continue;
    const shuffled = [...dirs].sort(() => Math.random() - 0.5);
    for (const [dx, dy] of shuffled) {
      const tx = unit.x + dx,
        ty = unit.y + dy;
      const tile = logic.getTile(state, tx, ty);
      if (!tile || tile.type !== 'FIELD' || logic.getUnit(state, tx, ty)) continue;
      actions.push({ action: 'MOVE', from_x: unit.x, from_y: unit.y, to_x: tx, to_y: ty });
      break;
    }
  }
  return actions;
}

function runGame(agent0, agent1, mode = 'blitz', fog = true) {
  let state = logic.createInitialState({ mode });

  while (!state.gameOver) {
    let state0 = state,
      state1 = state;

    if (fog) {
      // Filter state per player, same as the server does
      const vision0 = logic.computeVision(state, 0);
      const vision1 = logic.computeVision(state, 1);
      state0 = logic.filterStateForPlayer(state, 0, vision0);
      state1 = logic.filterStateForPlayer(state, 1, vision1);
    }

    const actions = {
      player0: agent0(state0, 0),
      player1: agent1(state1, 1),
    };
    const result = logic.processTurn(state, actions);
    state = result.newState;
  }

  return { winner: state.winner, turns: state.turn, scores: state.players.map((p) => p.score) };
}

// Run 1000 games with fog of war
const results = [];
for (let i = 0; i < 1000; i++) {
  results.push(runGame(randomAgent, randomAgent, 'blitz', true));
}
const wins0 = results.filter((r) => r.winner === 0).length;
const wins1 = results.filter((r) => r.winner === 1).length;
const ties = results.filter((r) => r.winner === null).length;
console.log(`P0: ${wins0}, P1: ${wins1}, Ties: ${ties}`);
```

`fog = false` disables fog filtering.

## Headless Self-Play (Any Language)

If your bot is written in Python, C++, or another language, you can still use the JS game engine for simulation by piping JSON between processes. The Node process stays alive and handles all game logic, so there is no overhead from re-launching Node each time.

### Step 1: Create a Node.js wrapper

Save this as `logic/simulate.js`:

```javascript
// Reads JSON lines from stdin, runs processTurn, writes result to stdout.
//
// Commands:
//   { "init": { "mode": "blitz" } }
//     -> { "state": <full state> }
//
//   { "fog": { "state": <full state>, "playerId": 0 } }
//     -> { "state": <filtered state for that player> }
//
//   { "state": <full state>, "actions": { "player0": [...], "player1": [...] } }
//     -> { "state": <new full state>, "events": [...] }
//
//   { "validate": { "state": <state>, "teamId": 0, "action": {...} } }
//     -> { "valid": true/false, "reason": "..." }

const logic = require('./index');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);

    if (msg.init) {
      const state = logic.createInitialState(msg.init);
      console.log(JSON.stringify({ state }));
    } else if (msg.fog) {
      // Fog filter: compute vision and return filtered state
      const { state, playerId } = msg.fog;
      const vision = logic.computeVision(state, playerId);
      const filtered = logic.filterStateForPlayer(state, playerId, vision);
      console.log(JSON.stringify({ state: filtered }));
    } else if (msg.state && msg.actions) {
      const result = logic.processTurn(msg.state, msg.actions);
      console.log(
        JSON.stringify({
          state: result.newState,
          events: result.info?.turnEvents || [],
        })
      );
    } else if (msg.validate) {
      const result = logic.validateAction(
        msg.validate.state,
        msg.validate.teamId,
        msg.validate.action
      );
      console.log(JSON.stringify(result));
    }
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }));
  }
});
```

### Step 2: Call it from Python

```python
import subprocess, json

class GameEngine:
    def __init__(self):
        self.proc = subprocess.Popen(
            ['node', 'logic/simulate.js'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, bufsize=1,
        )

    def _call(self, msg):
        self.proc.stdin.write(json.dumps(msg) + '\n')
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def create_game(self, mode='blitz'):
        return self._call({'init': {'mode': mode}})['state']

    def fog_filter(self, state, player_id):
        """Filter state through fog of war for a specific player."""
        return self._call({'fog': {'state': state, 'playerId': player_id}})['state']

    def process_turn(self, state, p0_actions, p1_actions):
        result = self._call({
            'state': state,
            'actions': {'player0': p0_actions, 'player1': p1_actions},
        })
        return result['state'], result.get('events', [])

    def close(self):
        self.proc.terminate()


# Run 100 games with fog of war (increase for more training data)
engine = GameEngine()
wins = {0: 0, 1: 0, None: 0}

for i in range(100):
    state = engine.create_game('blitz')
    while not state['gameOver']:
        # Each bot only sees its own fog-filtered view
        state0 = engine.fog_filter(state, 0)
        state1 = engine.fog_filter(state, 1)

        p0_actions = my_bot(state0, 0)
        p1_actions = my_bot(state1, 1)

        # Process turn uses the full (unfiltered) state
        state, events = engine.process_turn(state, p0_actions, p1_actions)
    wins[state['winner']] += 1

engine.close()
print(f"Wins: {wins}")
```

The Node process stays alive across all games. Each bot receives a fog-filtered state. `process_turn` operates on the full (unfiltered) state.

## Save Harvesting

The server auto-saves every completed game to `server/saves/` as JSON files. Saves are pruned to the last N games (default 20, configurable with `--max-saves=N`).

Run bots against each other on the server and collect the save files:

```bash
# Start server with high save limit
node server/server.js --tournament --max-saves=1000

# In other terminals, connect your bots
node agents/client.js mybot 0
node agents/client.js mybot 1

# Games auto-restart after 3 seconds.
# Save files accumulate in server/saves/
```

### Save File Format

```json
{
  "id": "2026-03-02T17-18-00_Bot0-vs-Bot1",
  "timestamp": "2026-03-02T17:18:00.238Z",
  "mode": "tournament",
  "players": [
    { "id": 0, "name": "Bot0" },
    { "id": 1, "name": "Bot1" }
  ],
  "winner": 0,
  "winReason": "score",
  "finalTurn": 350,
  "maxTurns": 350,
  "states": [ ... ]
}
```

`states` is an array of full game states, one per turn (turn 0 is the initial state). Each state has the same format as the state in TURN_START.

### Loading from disk

```python
import json, glob

for path in glob.glob('server/saves/*.json'):
    with open(path) as f:
        save = json.load(f)
    print(f"{save['id']}: winner={save['winner']} ({save['winReason']}), {save['finalTurn']} turns")

    # Access any turn's state
    for state in save['states']:
        p0 = next(p for p in state['players'] if p['id'] == 0)
        # ... analyze
```

### Loading via WebSocket

You can also list and load saves through the server's WebSocket API without accessing the filesystem:

```json
{ "type": "LIST_SAVES" }
```

Response: `{ "type": "SAVES_LIST", "saves": [{ "id": "...", "mode": "...", "winner": 0, ... }] }`

```json
{ "type": "LOAD_SAVE", "saveId": "some-save-id" }
```

Response: `{ "type": "SAVE_LOADED", "states": [...], "players": [...], "winner": 0 }`
