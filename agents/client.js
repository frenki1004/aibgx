/**
 * WebSocket Agent Client
 * Connects to the game server and runs an agent strategy
 *
 * Usage:
 *   node client.js [agent] [team] [name]
 *
 * Examples:
 *   node client.js dumb 0 DumbBot
 *   node client.js smart 1 SmartBot
 *   node client.js dumb              # defaults: team=0, name=Agent
 *
 * Requires Node.js 22+ (uses built-in WebSocket)
 */

// Parse command line arguments
const args = process.argv.slice(2);
const agentType = args[0] || 'dumb';
const preferredTeam = parseInt(args[1]) || 0;
const AGENT_NAMES = {
  smart: 'Smart',
  smarter: 'Smart',
  smart2: 'Smart2',
  econ: 'Econ',
  bestbot: 'BestBot',
  best1: 'Best1',
  best2: 'Best2',
  best3: 'Best3',
  best4: 'Best4',
  best5: 'Best5',
  best6: 'Best6',
  best7: 'Best7',
  best8: 'Best8',
  best9: 'Best9',
  dumb: 'Dumb',
};
const playerName = args[2] || `${AGENT_NAMES[agentType] || 'Dumb'}Agent`;

// Load the appropriate agent
let agent;
try {
  if (agentType === 'smart' || agentType === 'smarter') {
    agent = require('./smarterAgent');
    console.log('Loaded smarter agent strategy');
  } else if (agentType === 'smart2') {
    agent = require('./smart2Agent');
    console.log('Loaded smart2 agent strategy (unit-focused)');
  } else if (agentType === 'econ') {
    agent = require('./econAgent');
    console.log('Loaded econ agent strategy (economy-first)');
  } else if (agentType === 'bestbot') {
    agent = require('./bestbot');
    console.log('Loaded bestbot agent strategy (tournament-optimized)');
  } else if (agentType === 'best1') {
    agent = require('./best1');
    console.log('Loaded best1 agent strategy (formation + territory defense)');
  } else if (agentType === 'best2') {
    agent = require('./best2');
    console.log('Loaded best2 agent strategy (blitz aggression)');
  } else if (agentType === 'best3') {
    agent = require('./best3');
    console.log('Loaded best3 agent strategy (adaptive counter-building)');
  } else if (agentType === 'best4') {
    agent = require('./best4');
    console.log('Loaded best4 agent strategy (raider economic denial)');
  } else if (agentType === 'best5') {
    agent = require('./best5');
    console.log('Loaded best5 agent strategy (lane commander)');
  } else if (agentType === 'best6') {
    agent = require('./best6');
    console.log('Loaded best6 agent strategy (split pusher)');
  } else if (agentType === 'best7') {
    agent = require('./best7');
    console.log('Loaded best7 agent strategy (city rush)');
  } else if (agentType === 'best8') {
    agent = require('./best8');
    console.log('Loaded best8 agent strategy (mid fortress)');
  } else if (agentType === 'best9') {
    agent = require('./best9');
    console.log('Loaded best9 agent strategy (lane commander+)');
  } else {
    agent = require('./dumbAgent');
    console.log('Loaded dumb agent strategy');
  }
} catch (err) {
  console.error('Failed to load agent:', err.message);
  process.exit(1);
}

// Configuration
const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
const PASSWORD = process.env.PASSWORD || 'player';

// State
let ws = null;
let authenticated = false;
let teamId = null;
let currentState = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;
const reconnectDelay = 2000;

/**
 * Connect to the server
 */
function connect() {
  console.log(`Connecting to ${SERVER_URL}...`);

  ws = new WebSocket(SERVER_URL);

  ws.addEventListener('open', () => {
    console.log('Connected to server');
    reconnectAttempts = 0;

    // Authenticate as player
    send({
      type: 'AUTH',
      password: PASSWORD,
      name: playerName,
      preferredTeam: preferredTeam,
    });
  });

  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      handleMessage(message);
    } catch (err) {
      console.error('Failed to parse message:', err.message);
    }
  });

  ws.addEventListener('close', () => {
    console.log('Disconnected from server');
    authenticated = false;

    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      console.log(
        `Reconnecting in ${reconnectDelay / 1000}s (attempt ${reconnectAttempts}/${maxReconnectAttempts})...`
      );
      setTimeout(connect, reconnectDelay);
    } else {
      console.error('Max reconnection attempts reached. Exiting.');
      process.exit(1);
    }
  });

  ws.addEventListener('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

/**
 * Send a message to the server
 */
function send(message) {
  if (ws && ws.readyState === 1) {
    // 1 = OPEN
    ws.send(JSON.stringify(message));
  }
}

/**
 * Handle incoming messages from server
 */
function handleMessage(message) {
  switch (message.type) {
    case 'AUTH_SUCCESS':
      authenticated = true;
      teamId = message.teamId;
      console.log(`Authenticated as ${message.name} (Team ${teamId})`);
      // Request initial state
      send({ type: 'GET_STATE' });
      break;

    case 'AUTH_FAILED':
      console.error(`Authentication failed: ${message.reason}`);
      process.exit(1);
      break;

    case 'GAME_STATE':
      currentState = message.state;
      console.log(`Received game state: Turn ${currentState?.turn || '?'}`);
      break;

    case 'GAME_STARTED':
      console.log('Game started!');
      break;

    case 'TURN_START':
      console.log(`Turn ${message.turn} started (timeout: ${message.timeout}ms)`);
      handleTurnStart(message);
      break;

    case 'ACTIONS_RECEIVED':
      console.log(`Actions received: ${message.accepted} accepted, ${message.rejected} rejected`);
      if (message.errors && message.errors.length > 0) {
        console.log('Errors:', message.errors);
      }
      break;

    case 'TURN_RESULT':
      currentState = message.state;
      console.log(`Turn ${message.turn} ended`);
      break;

    case 'GAME_OVER':
      const winner =
        message.winner === null ? 'Tie' : message.winner === teamId ? 'We won!' : 'We lost';
      console.log(`Game Over! ${winner}`);
      console.log(
        `Final scores - Team 0: ${message.scores?.[0] || '?'}, Team 1: ${message.scores?.[1] || '?'}`
      );
      break;

    case 'PLAYER_JOINED':
      console.log(`Player joined: ${message.name} (Team ${message.team})`);
      break;

    case 'PLAYER_LEFT':
      console.log(`Player left: ${message.name} (Team ${message.team})`);
      break;

    case 'ERROR':
      console.error(`Server error: ${message.error}`);
      break;

    default:
      console.log(`Unknown message type: ${message.type}`);
  }
}

/**
 * Handle turn start - generate and submit actions
 */
function handleTurnStart(message) {
  if (!authenticated || teamId === null) {
    console.error('Cannot play: not authenticated');
    return;
  }

  // Use the state from the turn start message, or fall back to cached state
  const state = message.state || currentState;

  if (!state) {
    console.error('No game state available');
    send({ type: 'SUBMIT_ACTIONS', actions: [] });
    return;
  }

  // Update cached state
  currentState = state;

  try {
    // Generate actions using the agent
    const startTime = Date.now();
    const actions = agent.generateActions(state, teamId);
    const elapsed = Date.now() - startTime;

    console.log(`Generated ${actions.length} actions in ${elapsed}ms`);

    // Log actions for debugging
    for (const action of actions) {
      switch (action.action) {
        case 'MOVE':
          console.log(
            `  MOVE: (${action.from_x},${action.from_y}) -> (${action.to_x},${action.to_y})`
          );
          break;
        case 'BUILD_UNIT':
          console.log(`  BUILD: ${action.unit_type} at (${action.city_x},${action.city_y})`);
          break;
        case 'EXPAND_TERRITORY':
          console.log(`  EXPAND: (${action.x},${action.y})`);
          break;
        case 'BUILD_CITY':
          console.log(`  BUILD_CITY: (${action.x},${action.y})`);
          break;
        default:
          console.log(`  ${action.action}:`, action);
      }
    }

    // Submit actions
    send({ type: 'SUBMIT_ACTIONS', actions });
  } catch (err) {
    console.error('Error generating actions:', err.message);
    send({ type: 'SUBMIT_ACTIONS', actions: [] });
  }
}

// Start the client
console.log(`Starting ${agentType} agent as ${playerName} (preferred team: ${preferredTeam})`);
connect();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (ws) ws.close();
  process.exit(0);
});
