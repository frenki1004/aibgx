# Using the UI

## Setup

Start the frontend file server:

```bash
node visuals/serve.js
```

Open `http://localhost:3000` in your browser. It auto-connects as spectator to `ws://localhost:8080`.

## Canvas Controls

| Input            | Action                       |
| ---------------- | ---------------------------- |
| Mouse wheel      | Zoom (0.5x to 2x)            |
| Right-click drag | Pan                          |
| Space            | Zoom to fit                  |
| Left-click       | Select tile / open inspector |

## Panels

**Player stats** (top corners): gold, income, score, cities, units, tiles for each team.

**Turn info** (top center): turn number, timer, monument control.

**Server panel** (bottom right): connection status, terminal toggle, settings.

**Terminal** (T key): server messages, events, errors.

## Fog View

When the game server has fog of war enabled, spectators see the full map by default. You can toggle fog view to see what each player sees:

| Key | View                                               |
| --- | -------------------------------------------------- |
| 1   | Player 0 POV (fog on tiles outside P0's vision)    |
| 2   | Player 1 POV (fog on tiles outside P1's vision)    |
| 3   | Spectator view (full map with both vision borders) |

Press the same key again to return to the default (full map, no fog). The toolbar fog button cycles through these modes as well.

Vision borders are drawn as colored outlines: teal for Player 0, white for Player 1.

## Replay

- **Timeline slider** at the bottom: scrub through all turns across all games
- **Game navigator**: previous/next game buttons
- **Speed**: cycle through 0.5x, 1x, 4x, 8x, 16x, Live
- **Saved replays**: film icon opens server-saved games

Click "Live" to return to the live feed.

## Manual Play

1. Click the gamepad icon (right edge) to open the Manual Play tab
2. Select team, enter password, connect

Once connected, hover the left edge for the gameplay drawer:

| Mode   | Key | Action                                                        |
| ------ | --- | ------------------------------------------------------------- |
| Select | S   | Click unit to select, click destination to move               |
| Expand | E   | Click/drag neutral tiles adjacent to your territory (5G each) |
| City   | C   | Click your territory to place a city                          |
| Build  | B   | Pick unit type and city to spawn at                           |

Submit with Enter. Clear queued actions with the Clear button.

## Oversight Mode

Oversight lets a human review (and optionally modify) bot actions before each turn processes.

### How it works

1. Open the Oversight tab (eye icon, right edge)
2. Enter the oversight password (default: `oversight`, configured in `server/passwords.json`)
3. Click Connect

Once an oversight client is connected, the server changes its turn flow: after both bots submit actions, instead of processing immediately, the server sends both teams' actions to the oversight client for review. The turn is held until the oversight client approves.

### Review flow

Each turn, you see both teams' queued actions in the gameplay drawer. You can:

- **Inspect actions**: see every MOVE, BUILD_UNIT, EXPAND_TERRITORY, etc. that each bot submitted
- **Modify actions**: remove or edit actions from either team's queue before approving
- **Approve**: click Approve (or let auto-approve fire) to process the turn with the current action queues

### Auto-approve

By default, oversight auto-approves after a short delay (500ms). The countdown shows in the oversight panel.

### Pause / Resume

Click Pause to stop auto-approve and hold the game indefinitely. The current turn's actions stay visible for inspection. Click Resume to restart the auto-approve timer.

### Safety timeout

If the oversight client disconnects or stops responding, the server auto-processes after 30 seconds to prevent the game from hanging.

### Authentication

Oversight auth is separate from player/spectator auth. The oversight password is in `server/passwords.json` under the `"oversight"` key. It works in both default and protected modes.

## Keyboard Shortcuts

| Key    | Action                       |
| ------ | ---------------------------- |
| T      | Toggle terminal              |
| Space  | Zoom to fit                  |
| Escape | Close modals / deselect      |
| 1      | Toggle Player 0 fog view     |
| 2      | Toggle Player 1 fog view     |
| 3      | Toggle spectator fog view    |
| S      | Select mode (manual play)    |
| E      | Expand mode (manual play)    |
| C      | City mode (manual play)      |
| B      | Build unit (manual play)     |
| Enter  | Submit actions (manual play) |
