// Server tests

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const { ConnectionManager } = require('../connections');
const { GameManager, GAME_STATES } = require('../game-manager');

function createMockWs() {
  return {
    readyState: 1,
    OPEN: 1,
    send: mock.fn(),
    close: mock.fn(),
  };
}

describe('ConnectionManager', () => {
  let manager;

  beforeEach(() => {
    manager = new ConnectionManager();
  });

  describe('addConnection', () => {
    it('adds connection with auth timer', () => {
      const ws = createMockWs();
      const info = manager.addConnection(ws);

      assert.ok(info.authTimer !== null);
      assert.strictEqual(info.authenticated, false);
      assert.strictEqual(info.teamId, null);
      assert.ok(manager.connections.has(ws));

      clearTimeout(info.authTimer);
    });
  });

  describe('removeConnection', () => {
    it('removes connection and clears timer', () => {
      const ws = createMockWs();
      manager.addConnection(ws);
      manager.removeConnection(ws);
      assert.ok(!manager.connections.has(ws));
    });

    it('removes name from tracking', () => {
      const ws = createMockWs();
      manager.addConnection(ws);
      manager.authenticate(ws, { password: 'player', preferredTeam: 0, name: 'TestPlayer' });

      assert.ok(manager.names.has('TestPlayer'));
      manager.removeConnection(ws);
      assert.ok(!manager.names.has('TestPlayer'));
    });
  });

  describe('authenticate', () => {
    it('authenticates team 0 with preferredTeam', () => {
      const ws = createMockWs();
      manager.addConnection(ws);

      const result = manager.authenticate(ws, { password: 'player', preferredTeam: 0, name: 'Player0' });

      assert.ok(result.success);
      assert.strictEqual(result.teamId, 0);
      assert.strictEqual(result.assignedName, 'Player0');
      assert.strictEqual(result.isSpectator, false);
    });

    it('authenticates team 1 with preferredTeam', () => {
      const ws = createMockWs();
      manager.addConnection(ws);

      const result = manager.authenticate(ws, { password: 'player', preferredTeam: 1, name: 'Player1' });

      assert.ok(result.success);
      assert.strictEqual(result.teamId, 1);
    });

    it('auto-assigns team 0 when no preferredTeam', () => {
      const ws = createMockWs();
      manager.addConnection(ws);

      const result = manager.authenticate(ws, { password: 'player', name: 'Player' });

      assert.ok(result.success);
      assert.strictEqual(result.teamId, 0);
    });

    it('auto-assigns team 1 when team 0 taken', () => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();

      manager.addConnection(ws0);
      manager.addConnection(ws1);

      manager.authenticate(ws0, { password: 'player', name: 'P0' });
      const result = manager.authenticate(ws1, { password: 'player', name: 'P1' });

      assert.ok(result.success);
      assert.strictEqual(result.teamId, 1);
    });

    it('authenticates spectator with correct password', () => {
      const ws = createMockWs();
      manager.addConnection(ws);

      const result = manager.authenticate(ws, { password: 'spectator', name: 'Spectator1' });

      assert.ok(result.success);
      assert.strictEqual(result.isSpectator, true);
      assert.strictEqual(result.teamId, -1);
    });

    it('rejects invalid password', () => {
      const ws = createMockWs();
      manager.addConnection(ws);

      const result = manager.authenticate(ws, { password: 'wrongpassword', name: 'Hacker' });

      assert.ok(!result.success);
      assert.strictEqual(result.reason, 'Invalid password');
    });

    it('falls back to other team if preferred is taken', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addConnection(ws1);
      manager.addConnection(ws2);

      manager.authenticate(ws1, { password: 'player', preferredTeam: 0, name: 'P1' });
      const result = manager.authenticate(ws2, { password: 'player', preferredTeam: 0, name: 'P2' });

      assert.ok(result.success);
      assert.strictEqual(result.teamId, 1);
    });

    it('rejects when both teams taken', () => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addConnection(ws0);
      manager.addConnection(ws1);
      manager.addConnection(ws2);

      manager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      manager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });
      const result = manager.authenticate(ws2, { password: 'player', name: 'P2' });

      assert.ok(!result.success);
      assert.ok(result.reason.includes('Both teams'));
    });

    it('allows multiple spectators', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.addConnection(ws1);
      manager.addConnection(ws2);

      const r1 = manager.authenticate(ws1, { password: 'spectator', name: 'S1' });
      const r2 = manager.authenticate(ws2, { password: 'spectator', name: 'S2' });

      assert.ok(r1.success);
      assert.ok(r2.success);
    });
  });

  describe('generateUniqueName', () => {
    it('returns base name if not taken', () => {
      const name = manager.generateUniqueName('Player');
      assert.strictEqual(name, 'Player');
    });

    it('adds counter for duplicate names', () => {
      manager.generateUniqueName('Player');
      const name2 = manager.generateUniqueName('Player');
      assert.strictEqual(name2, 'Player(1)');
    });

    it('increments counter for multiple duplicates', () => {
      manager.generateUniqueName('Bot');
      manager.generateUniqueName('Bot');
      const name3 = manager.generateUniqueName('Bot');
      assert.strictEqual(name3, 'Bot(2)');
    });
  });

  describe('bothTeamsConnected', () => {
    it('returns false when no teams connected', () => {
      assert.ok(!manager.bothTeamsConnected());
    });

    it('returns false when only one team connected', () => {
      const ws = createMockWs();
      manager.addConnection(ws);
      manager.authenticate(ws, { password: 'player', preferredTeam: 0, name: 'P0' });

      assert.ok(!manager.bothTeamsConnected());
    });

    it('returns true when both teams connected', () => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();

      manager.addConnection(ws0);
      manager.addConnection(ws1);

      manager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      manager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });

      assert.ok(manager.bothTeamsConnected());
    });
  });

  describe('getPlayers', () => {
    it('returns only authenticated non-spectator players', () => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();
      const wsSpec = createMockWs();

      manager.addConnection(ws0);
      manager.addConnection(ws1);
      manager.addConnection(wsSpec);

      manager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      manager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });
      manager.authenticate(wsSpec, { password: 'spectator', name: 'Spec' });

      const players = manager.getPlayers();
      assert.strictEqual(players.length, 2);
    });
  });

  describe('getSpectators', () => {
    it('returns only spectators', () => {
      const ws0 = createMockWs();
      const wsSpec = createMockWs();

      manager.addConnection(ws0);
      manager.addConnection(wsSpec);

      manager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      manager.authenticate(wsSpec, { password: 'spectator', name: 'Spec' });

      const spectators = manager.getSpectators();
      assert.strictEqual(spectators.length, 1);
      assert.strictEqual(spectators[0].name, 'Spec');
    });
  });

  describe('broadcast', () => {
    it('sends to all authenticated connections', () => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();
      const wsUnauth = createMockWs();

      manager.addConnection(ws0);
      manager.addConnection(ws1);
      manager.addConnection(wsUnauth);

      manager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      manager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });

      manager.broadcast({ type: 'TEST' });

      assert.strictEqual(ws0.send.mock.calls.length, 1);
      assert.strictEqual(ws1.send.mock.calls.length, 1);
      assert.strictEqual(wsUnauth.send.mock.calls.length, 0);
    });
  });
});

describe('GameManager', () => {
  let connectionManager;
  let gameManager;

  beforeEach(() => {
    connectionManager = new ConnectionManager();
    gameManager = new GameManager(connectionManager, { turnTimeout: 100 });
  });

  afterEach(() => {
    if (gameManager.turnTimer) clearTimeout(gameManager.turnTimer);
  });

  describe('initial state', () => {
    it('starts in WAITING state', () => {
      assert.strictEqual(gameManager.gameState, GAME_STATES.WAITING);
    });

    it('has no game state initially', () => {
      assert.strictEqual(gameManager.state, null);
    });

    it('has default settings', () => {
      assert.ok(gameManager.settings.turnTimeout > 0);
      assert.ok(gameManager.settings.mode !== undefined);
    });
  });

  describe('updateSettings', () => {
    it('updates settings when not playing', () => {
      const result = gameManager.updateSettings({ turnTimeout: 5000 });
      assert.ok(result.success);
      assert.strictEqual(gameManager.settings.turnTimeout, 5000);
    });

    it('rejects when game is playing', () => {
      gameManager.gameState = GAME_STATES.PLAYING;
      const result = gameManager.updateSettings({ turnTimeout: 5000 });
      assert.ok(!result.success);
    });

    it('rejects client updates when clientOverride disabled', () => {
      const result = gameManager.updateSettings({ turnTimeout: 5000 }, true);
      assert.ok(!result.success);
      assert.ok(result.reason.includes('Client override'));
    });
  });

  describe('checkAndStartGame', () => {
    it('does not start without both teams', () => {
      const started = gameManager.checkAndStartGame();
      assert.ok(!started);
      assert.strictEqual(gameManager.gameState, GAME_STATES.WAITING);
    });

    it('starts when both teams connected', () => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();

      connectionManager.addConnection(ws0);
      connectionManager.addConnection(ws1);
      connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });

      const started = gameManager.checkAndStartGame();

      assert.ok(started);
      assert.strictEqual(gameManager.gameState, GAME_STATES.PLAYING);
      assert.ok(gameManager.state !== null);
    });
  });

  describe('submitActions', () => {
    beforeEach(() => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();

      connectionManager.addConnection(ws0);
      connectionManager.addConnection(ws1);
      connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });

      gameManager.checkAndStartGame();
    });

    it('accepts valid actions', () => {
      const result = gameManager.submitActions(0, []);
      assert.ok(result.success);
    });

    it('rejects invalid team ID', () => {
      const result = gameManager.submitActions(5, []);
      assert.ok(!result.success);
    });

    it('rejects duplicate submission', () => {
      gameManager.submitActions(0, []);
      const result = gameManager.submitActions(0, []);
      assert.ok(!result.success);
      assert.ok(result.reason.includes('already submitted'));
    });

    it('processes turn when both players submit', (t, done) => {
      let turnProcessed = false;

      gameManager.setEventCallback((event) => {
        if (event === 'turn_processed') turnProcessed = true;
      });

      gameManager.submitActions(0, []);
      gameManager.submitActions(1, []);

      setTimeout(() => {
        assert.ok(turnProcessed);
        done();
      }, 50);
    });
  });

  describe('getClientState', () => {
    it('returns null when no game', () => {
      assert.strictEqual(gameManager.getClientState(), null);
    });

    it('returns state structure when game active', () => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();

      connectionManager.addConnection(ws0);
      connectionManager.addConnection(ws1);
      connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });

      gameManager.checkAndStartGame();

      const state = gameManager.getClientState();

      assert.ok(state.turn !== undefined);
      assert.ok(state.players !== undefined);
      assert.ok(state.map !== undefined);
      assert.ok(state.units !== undefined);
      assert.ok(state.cities !== undefined);
    });
  });

  describe('getStatus', () => {
    it('returns status with game state', () => {
      const status = gameManager.getStatus();

      assert.strictEqual(status.gameState, GAME_STATES.WAITING);
      assert.ok(status.settings !== undefined);
      assert.ok(status.players !== undefined);
    });
  });

  describe('reset', () => {
    it('resets to waiting state', () => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();

      connectionManager.addConnection(ws0);
      connectionManager.addConnection(ws1);
      connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });

      gameManager.checkAndStartGame();
      assert.strictEqual(gameManager.gameState, GAME_STATES.PLAYING);

      gameManager.reset();

      assert.strictEqual(gameManager.gameState, GAME_STATES.WAITING);
      assert.strictEqual(gameManager.state, null);
    });
  });

  describe('turn timeout', () => {
    it('processes turn after timeout', (t, done) => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();

      connectionManager.addConnection(ws0);
      connectionManager.addConnection(ws1);
      connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });

      gameManager.settings.turnTimeout = 50;
      gameManager.checkAndStartGame();

      const initialTurn = gameManager.state.turn;

      setTimeout(() => {
        assert.ok(gameManager.state.turn > initialTurn);
        done();
      }, 150);
    });

    it('does not auto-process when timeout is 0', (t, done) => {
      const ws0 = createMockWs();
      const ws1 = createMockWs();

      connectionManager.addConnection(ws0);
      connectionManager.addConnection(ws1);
      connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
      connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });

      gameManager.settings.turnTimeout = 0;
      gameManager.checkAndStartGame();

      const initialTurn = gameManager.state.turn;

      // Wait and verify turn hasn't advanced
      setTimeout(() => {
        assert.strictEqual(gameManager.state.turn, initialTurn);
        assert.strictEqual(gameManager.turnTimer, null);
        done();
      }, 100);
    });
  });
});

describe('Integration', () => {
  let connectionManager;
  let gameManager;

  beforeEach(() => {
    connectionManager = new ConnectionManager();
    gameManager = new GameManager(connectionManager, { turnTimeout: 100 });
  });

  afterEach(() => {
    if (gameManager.turnTimer) clearTimeout(gameManager.turnTimer);
  });

  it('full game flow with PASS actions', (t, done) => {
    const ws0 = createMockWs();
    const ws1 = createMockWs();

    connectionManager.addConnection(ws0);
    connectionManager.addConnection(ws1);
    connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'Bot0' });
    connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'Bot1' });

    let turnCount = 0;
    gameManager.setEventCallback((event) => {
      if (event === 'turn_processed') {
        turnCount++;
        if (!gameManager.state.gameOver) {
          gameManager.submitActions(0, []);
          gameManager.submitActions(1, []);
        }
      }
      if (event === 'game_ended') {
        assert.ok(turnCount > 0);
        done();
      }
    });

    gameManager.checkAndStartGame();
    gameManager.submitActions(0, []);
    gameManager.submitActions(1, []);
  });

  it('broadcasts events to all players', () => {
    const ws0 = createMockWs();
    const ws1 = createMockWs();
    const wsSpec = createMockWs();

    connectionManager.addConnection(ws0);
    connectionManager.addConnection(ws1);
    connectionManager.addConnection(wsSpec);

    connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
    connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });
    connectionManager.authenticate(wsSpec, { password: 'spectator', name: 'Spec' });

    connectionManager.broadcast({ type: 'TEST' });

    assert.strictEqual(ws0.send.mock.calls.length, 1);
    assert.strictEqual(ws1.send.mock.calls.length, 1);
    assert.strictEqual(wsSpec.send.mock.calls.length, 1);
  });
});

describe('Event payloads', () => {
  let connectionManager;
  let gameManager;
  let events;

  beforeEach(() => {
    connectionManager = new ConnectionManager();
    gameManager = new GameManager(connectionManager, { turnTimeout: 0 });
    events = [];
    gameManager.setEventCallback((event, data) => {
      events.push({ event, data });
    });
  });

  function setupPlayers() {
    const ws0 = createMockWs();
    const ws1 = createMockWs();
    connectionManager.addConnection(ws0);
    connectionManager.addConnection(ws1);
    connectionManager.authenticate(ws0, { password: 'player', preferredTeam: 0, name: 'P0' });
    connectionManager.authenticate(ws1, { password: 'player', preferredTeam: 1, name: 'P1' });
  }

  it('game_started has mode and turnTimeout', () => {
    setupPlayers();
    gameManager.checkAndStartGame();

    const started = events.find(e => e.event === 'game_started');
    assert.ok(started);
    assert.ok(started.data.mode !== undefined);
    assert.strictEqual(started.data.turnTimeout, 0);
  });

  it('turn_started has turn, timeout, and state', () => {
    setupPlayers();
    gameManager.checkAndStartGame();

    const turnStart = events.find(e => e.event === 'turn_started');
    assert.ok(turnStart);
    assert.strictEqual(turnStart.data.turn, 1);
    assert.strictEqual(turnStart.data.timeout, 0);
    assert.ok(turnStart.data.state);
    assert.ok(turnStart.data.state.map);
    assert.ok(turnStart.data.state.units);
    assert.ok(turnStart.data.state.players);
  });

  it('turn_processed has turn, events, and state', () => {
    setupPlayers();
    gameManager.checkAndStartGame();
    gameManager.submitActions(0, []);
    gameManager.submitActions(1, []);

    const processed = events.find(e => e.event === 'turn_processed');
    assert.ok(processed);
    assert.strictEqual(processed.data.turn, 1);
    assert.ok(Array.isArray(processed.data.events));
    assert.ok(processed.data.state);
    assert.ok(processed.data.state.map);
  });

  it('game_ended has winner, reason, finalState, and history', (t, done) => {
    setupPlayers();
    gameManager.checkAndStartGame();

    gameManager.setEventCallback((event, data) => {
      if (event === 'game_ended') {
        assert.ok(data.winner !== undefined); // can be 0, 1, or null (tie)
        assert.ok(['score', 'tie', 'elimination'].includes(data.reason));
        assert.ok(data.finalState);
        assert.ok(data.finalState.gameOver);
        assert.ok(Array.isArray(data.history));
        done();
      } else if (event === 'turn_started' || event === 'turn_processed') {
        if (!gameManager.state.gameOver) {
          gameManager.submitActions(0, []);
          gameManager.submitActions(1, []);
        }
      }
    });

    gameManager.submitActions(0, []);
    gameManager.submitActions(1, []);
  });

  it('submitActions returns validation array', () => {
    setupPlayers();
    gameManager.checkAndStartGame();

    const result = gameManager.submitActions(0, [
      { type: 'MOVE', unitId: 'fake', to: { x: 0, y: 0 } }
    ]);

    assert.ok(result.success);
    assert.ok(Array.isArray(result.validation));
    assert.strictEqual(result.validation.length, 1);
    assert.strictEqual(result.validCount, 0); // fake unit = invalid
    assert.strictEqual(result.totalCount, 1);
  });

  it('GET_STATE matches TURN_START state', () => {
    setupPlayers();
    gameManager.checkAndStartGame();

    const turnStart = events.find(e => e.event === 'turn_started');
    const getState = gameManager.getClientState();

    assert.deepStrictEqual(getState, turnStart.data.state);
  });
});
