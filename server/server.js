// Civilization Clash - WebSocket Game Server

const { WebSocketServer } = require('ws');
const { ConnectionManager } = require('./connections');
const { GameManager } = require('./game-manager');

const PORT = process.env.PORT || 8080;

const CLIENT_MESSAGES = {
  AUTH: 'AUTH',
  GET_STATE: 'GET_STATE',
  GET_STATUS: 'GET_STATUS',
  SUBMIT_ACTIONS: 'SUBMIT_ACTIONS',
  GAME_CONTROL: 'GAME_CONTROL',
  LIST_SAVES: 'LIST_SAVES',
  LOAD_SAVE: 'LOAD_SAVE',
  OVERSIGHT_APPROVE: 'OVERSIGHT_APPROVE',
};

const SERVER_MESSAGES = {
  AUTH_SUCCESS: 'AUTH_SUCCESS',
  AUTH_FAILED: 'AUTH_FAILED',
  GAME_STATE: 'GAME_STATE',
  SERVER_STATUS: 'SERVER_STATUS',
  GAME_STARTED: 'GAME_STARTED',
  TURN_START: 'TURN_START',
  ACTIONS_RECEIVED: 'ACTIONS_RECEIVED',
  TURN_RESULT: 'TURN_RESULT',
  GAME_OVER: 'GAME_OVER',
  PLAYER_JOINED: 'PLAYER_JOINED',
  PLAYER_LEFT: 'PLAYER_LEFT',
  ERROR: 'ERROR',
  OVERSIGHT_REVIEW: 'OVERSIGHT_REVIEW',
};

function createServer(options = {}) {
  const { port = PORT, mode, turnTimeout = 2000, protectedMode = false, maxSaves = 20, fogOfWar = true } = options;
  const clientOverride = !protectedMode;

  const wss = new WebSocketServer({ port });
  const connectionManager = new ConnectionManager({ protectedMode });
  const gameManager = new GameManager(connectionManager, { mode, clientOverride, turnTimeout, maxSaves, fogOfWar });

  gameManager.setEventCallback((event, data) => {
    handleGameEvent(connectionManager, event, data);
  });

  console.log(`Civilization Clash server starting on port ${port}...`);

  wss.on('connection', (ws) => {
    console.log('New connection');
    connectionManager.addConnection(ws);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(ws, message, connectionManager, gameManager);
      } catch (err) {
        connectionManager.send(ws, { type: SERVER_MESSAGES.ERROR, error: 'Invalid JSON message' });
      }
    });

    ws.on('close', () => {
      const info = connectionManager.getConnectionInfo(ws);
      const wasPlayer = info?.authenticated && !info?.isSpectator;
      const teamId = info?.teamId;
      const name = info?.name;

      connectionManager.removeConnection(ws);

      if (wasPlayer) {
        console.log(`Player ${name} (team ${teamId}) disconnected`);
        connectionManager.broadcast({ type: SERVER_MESSAGES.PLAYER_LEFT, team: teamId, name });
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  });

  wss.on('listening', () => {
    console.log(`Server listening on port ${port}`);
  });

  return { wss, connectionManager, gameManager };
}

function handleMessage(ws, message, connectionManager, gameManager) {
  const { type } = message;
  const info = connectionManager.getConnectionInfo(ws);

  if (type === CLIENT_MESSAGES.AUTH) {
    handleAuth(ws, message, connectionManager, gameManager);
    return;
  }

  if (!info?.authenticated) {
    connectionManager.send(ws, { type: SERVER_MESSAGES.ERROR, error: 'Not authenticated' });
    return;
  }

  switch (type) {
    case CLIENT_MESSAGES.GET_STATE:
      handleGetState(ws, connectionManager, gameManager);
      break;
    case CLIENT_MESSAGES.GET_STATUS:
      handleGetStatus(ws, connectionManager, gameManager);
      break;
    case CLIENT_MESSAGES.SUBMIT_ACTIONS:
      handleSubmitActions(ws, message, info, connectionManager, gameManager);
      break;
    case CLIENT_MESSAGES.GAME_CONTROL:
      handleGameControl(ws, message, info, connectionManager, gameManager);
      break;
    case CLIENT_MESSAGES.LIST_SAVES:
      connectionManager.send(ws, { type: 'SAVES_LIST', saves: gameManager.listSaves() });
      break;
    case CLIENT_MESSAGES.LOAD_SAVE:
      connectionManager.send(ws, { type: 'SAVE_LOADED', ...gameManager.loadSave(message.saveId) });
      break;
    case CLIENT_MESSAGES.OVERSIGHT_APPROVE:
      handleOversightApprove(ws, message, info, connectionManager, gameManager);
      break;
    default:
      connectionManager.send(ws, { type: SERVER_MESSAGES.ERROR, error: `Unknown message type: ${type}` });
  }
}

function handleAuth(ws, message, connectionManager, gameManager) {
  const result = connectionManager.authenticate(ws, message);

  if (!result.success) {
    connectionManager.send(ws, { type: SERVER_MESSAGES.AUTH_FAILED, reason: result.reason });
    ws.close();
    return;
  }

  console.log(`Authenticated: ${result.assignedName} as ${result.isSpectator ? 'spectator' : `team ${result.teamId}`}`);

  connectionManager.send(ws, {
    type: SERVER_MESSAGES.AUTH_SUCCESS,
    teamId: result.teamId,
    name: result.assignedName,
    isSpectator: result.isSpectator,
    isOversight: result.isOversight || false,
  });

  if (!result.isSpectator) {
    connectionManager.broadcast({ type: SERVER_MESSAGES.PLAYER_JOINED, team: result.teamId, name: result.assignedName });
  }

  gameManager.checkAndStartGame();
}

function handleGetState(ws, connectionManager, gameManager) {
  const info = connectionManager.getConnectionInfo(ws);
  let state;
  if (gameManager.settings.fogOfWar && info && !info.isSpectator && (info.teamId === 0 || info.teamId === 1)) {
    state = gameManager.getClientStateForPlayer(info.teamId);
  } else if (gameManager.settings.fogOfWar && info?.isSpectator) {
    state = gameManager.getSpectatorState();
  } else {
    state = gameManager.getClientState();
  }
  connectionManager.send(ws, {
    type: SERVER_MESSAGES.GAME_STATE,
    state,
    gameState: gameManager.gameState,
  });
}

function handleGetStatus(ws, connectionManager, gameManager) {
  connectionManager.send(ws, { type: SERVER_MESSAGES.SERVER_STATUS, ...gameManager.getStatus() });
}

function handleSubmitActions(ws, message, info, connectionManager, gameManager) {
  if (info.isSpectator) {
    connectionManager.send(ws, { type: SERVER_MESSAGES.ERROR, error: 'Spectators cannot submit actions' });
    return;
  }

  const { actions } = message;
  if (!Array.isArray(actions)) {
    connectionManager.send(ws, { type: SERVER_MESSAGES.ERROR, error: 'Actions must be an array' });
    return;
  }

  const result = gameManager.submitActions(info.teamId, actions);
  connectionManager.send(ws, { type: SERVER_MESSAGES.ACTIONS_RECEIVED, ...result });
}

function handleGameControl(ws, message, info, connectionManager, gameManager) {
  const { command, settings } = message;

  switch (command) {
    case 'update_settings':
      connectionManager.send(ws, { type: 'SETTINGS_UPDATED', ...gameManager.updateSettings(settings, true) });
      break;
    case 'reset':
      gameManager.reset();
      gameManager.checkAndStartGame();
      connectionManager.send(ws, { type: 'GAME_RESET', success: true });
      break;
    case 'pause':
      connectionManager.send(ws, { type: 'PAUSE_UPDATED', ...gameManager.pause() });
      break;
    case 'resume':
      connectionManager.send(ws, { type: 'PAUSE_UPDATED', ...gameManager.resume() });
      break;
    default:
      connectionManager.send(ws, { type: SERVER_MESSAGES.ERROR, error: `Unknown command: ${command}` });
  }
}

function handleOversightApprove(ws, message, info, connectionManager, gameManager) {
  if (!info.isOversight) {
    connectionManager.send(ws, { type: SERVER_MESSAGES.ERROR, error: 'Only oversight client can approve' });
    return;
  }
  gameManager.approveOversight(message.actions);
}

function handleGameEvent(connectionManager, event, data) {
  console.log(`[Event] ${event}`);
  switch (event) {
    case 'game_started':
      console.log(`Game started! Mode: ${data.mode}, Timeout: ${data.turnTimeout}ms`);
      connectionManager.broadcast({ type: SERVER_MESSAGES.GAME_STARTED, ...data });
      break;
    case 'turn_started':
      console.log(`Turn ${data.turn} started`);
      if (data.fogOfWar) {
        // Per-player filtered states
        connectionManager.sendToTeam(0, { type: SERVER_MESSAGES.TURN_START, turn: data.turn, timeout: data.timeout, state: data.playerStates[0] });
        connectionManager.sendToTeam(1, { type: SERVER_MESSAGES.TURN_START, turn: data.turn, timeout: data.timeout, state: data.playerStates[1] });
        connectionManager.broadcastToSpectators({ type: SERVER_MESSAGES.TURN_START, turn: data.turn, timeout: data.timeout, state: data.spectatorState });
      } else {
        connectionManager.broadcast({ type: SERVER_MESSAGES.TURN_START, ...data });
      }
      break;
    case 'turn_processed':
      console.log(`Turn ${data.turn} processed`);
      if (data.fogOfWar) {
        connectionManager.sendToTeam(0, { type: SERVER_MESSAGES.TURN_RESULT, turn: data.turn, events: data.playerEvents[0], state: data.playerStates[0] });
        connectionManager.sendToTeam(1, { type: SERVER_MESSAGES.TURN_RESULT, turn: data.turn, events: data.playerEvents[1], state: data.playerStates[1] });
        connectionManager.broadcastToSpectators({ type: SERVER_MESSAGES.TURN_RESULT, turn: data.turn, events: data.events, state: data.spectatorState });
      } else {
        connectionManager.broadcast({ type: SERVER_MESSAGES.TURN_RESULT, ...data });
      }
      break;
    case 'game_ended':
      console.log(`Game ended! Winner: ${data.winner}, Reason: ${data.reason}`);
      // Only broadcast metadata — don't send full history/finalState (large, unused by frontend)
      connectionManager.broadcast({
        type: SERVER_MESSAGES.GAME_OVER,
        winner: data.winner,
        reason: data.reason,
        saveId: data.saveId,
      });
      break;
    case 'settings_changed':
      connectionManager.broadcast({ type: 'SETTINGS_CHANGED', settings: data });
      break;
    case 'game_reset':
      console.log('Game reset');
      connectionManager.broadcast({ type: 'GAME_RESET' });
      break;
    case 'actions_submitted':
      console.log(`Team ${data.teamId} submitted ${data.validCount}/${data.totalCount} valid actions`);
      break;
    case 'oversight_review':
      console.log(`Turn ${data.turn} awaiting oversight review`);
      connectionManager.sendToOversight({
        type: SERVER_MESSAGES.OVERSIGHT_REVIEW,
        turn: data.turn,
        actions: data.actions,
      });
      break;
  }
}

// Start server if run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const protectedMode = args.includes('--protected');
  const fogOfWar = !args.includes('--no-fog');

  // Parse mode: --mode=standard or --mode=blitz
  let mode = 'blitz'; // default
  const modeArg = args.find(a => a.startsWith('--mode='));
  if (modeArg) {
    mode = modeArg.split('=')[1];
  } else if (args.includes('--standard')) {
    mode = 'standard';
  } else if (args.includes('--tournament')) {
    mode = 'tournament';
  }

  // Parse timeout: --timeout=2000
  let turnTimeout = 2000;
  const timeoutArg = args.find(a => a.startsWith('--timeout='));
  if (timeoutArg) {
    turnTimeout = parseInt(timeoutArg.split('=')[1]) || 2000;
  }

  // Parse max saves: --max-saves=20
  let maxSaves = 20;
  const maxSavesArg = args.find(a => a.startsWith('--max-saves='));
  if (maxSavesArg) {
    maxSaves = parseInt(maxSavesArg.split('=')[1]) || 20;
  }

  // Parse port: --port=8080
  let port = parseInt(process.env.PORT) || 8080;
  const portArg = args.find(a => a.startsWith('--port='));
  if (portArg) {
    port = parseInt(portArg.split('=')[1]) || 8080;
  }

  console.log(`Settings: port=${port}, mode=${mode}, turnTimeout=${turnTimeout}ms, protected=${protectedMode}, maxSaves=${maxSaves}, fog=${fogOfWar}`);
  if (protectedMode) {
    console.log('PROTECTED MODE: Passwords required, client settings override disabled');
  }
  if (!fogOfWar) {
    console.log('FOG OF WAR DISABLED: Full information mode');
  }
  createServer({ port, mode, turnTimeout, protectedMode, maxSaves, fogOfWar });
}

module.exports = { createServer, CLIENT_MESSAGES, SERVER_MESSAGES };
