/**
 * OpenAI Agent WebSocket Client
 *
 * Async WebSocket client that uses OpenAI API for real-time gameplay.
 * Unlike the sync client.js, this properly awaits API responses.
 *
 * Setup:
 *   npm install openai
 *   export OPENAI_API_KEY=sk-...
 *
 * Usage:
 *   node openaiClient.js [team] [model]
 *
 * Examples:
 *   node openaiClient.js 0                    # Team 0, default model (gpt-4o-mini)
 *   node openaiClient.js 1 gpt-4o             # Team 1, GPT-4o
 *   node openaiClient.js 0 ft:gpt-4o-mini:... # Team 0, fine-tuned model
 *
 * Environment:
 *   OPENAI_API_KEY   - Required
 *   OPENAI_MODEL     - Default model (overridden by CLI arg)
 *   OPENAI_LEARN     - "true" to save experience data for fine-tuning
 *   SERVER_URL       - WebSocket server (default: ws://localhost:8080)
 *   PASSWORD         - Auth password (default: player)
 */

const fs = require('fs');
const path = require('path');

let OpenAI;
try {
  OpenAI = require('openai').default || require('openai');
} catch (e) {
  console.error('Install openai: npm install openai');
  process.exit(1);
}

const smarterAgent = require('./smarterAgent');
const { validateAction } = require('../logic');

// --- Config ---
const args = process.argv.slice(2);
const TEAM = parseInt(args[0]) || 0;
const MODEL = args[1] || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LEARN = process.env.OPENAI_LEARN === 'true';
const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
const PASSWORD = process.env.PASSWORD || 'player';
const PLAYER_NAME = `OpenAI-${MODEL.split(':').pop().slice(-8)}`;

const openai = new OpenAI();

// --- Import prompt utils from openaiAgent ---
const { SYSTEM_PROMPT, compressStateForPrompt, parseActions } = require('./openaiAgent');

// --- Experience tracking ---
const experienceBuffer = [];
const gameId = Date.now();
let gameResults = { wins: 0, losses: 0, ties: 0, totalTurns: 0, totalCost: 0 };
let teamId = null;

/**
 * Get actions from OpenAI with fallback
 */
async function getActions(state, playerId) {
  const userMessage = compressStateForPrompt(state, playerId);

  try {
    const startTime = Date.now();
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });
    const elapsed = Date.now() - startTime;

    const content = response.choices[0]?.message?.content || '[]';
    const actions = parseActions(content, state, playerId);
    const usage = response.usage || {};

    // Estimate cost (gpt-4o-mini pricing)
    const cost = ((usage.prompt_tokens || 0) * 0.00015 + (usage.completion_tokens || 0) * 0.0006) / 1000;
    gameResults.totalCost += cost;

    console.log(
      `  Turn ${state.turn}: ${actions.length} actions, ${elapsed}ms, ${usage.total_tokens || '?'} tokens`
    );

    // Collect experience
    if (LEARN) {
      experienceBuffer.push({
        turn: state.turn,
        playerId,
        statePrompt: userMessage,
        response: content,
        actions,
        model: MODEL,
      });
    }

    // Fallback if no valid actions
    if (actions.length === 0) {
      console.log(`  Fallback to heuristic (0 valid actions from model)`);
      return smarterAgent.generateActions(state, playerId);
    }

    return actions;
  } catch (err) {
    console.error(`  API error: ${err.message}`);
    return smarterAgent.generateActions(state, playerId);
  }
}

/**
 * Save experience buffer + game outcome for fine-tuning
 */
function saveExperience(outcome) {
  if (!LEARN || experienceBuffer.length === 0) return;

  const dir = path.join(__dirname, '..', 'training', 'experience');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Save as fine-tuning format with outcome labels
  const ftFile = path.join(dir, `live_${gameId}_${outcome}.jsonl`);
  const stream = fs.createWriteStream(ftFile);

  for (const exp of experienceBuffer) {
    // Only save as training data if we won (or tied in close game)
    if (outcome === 'win' || outcome === 'tie') {
      stream.write(
        JSON.stringify({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: exp.statePrompt },
            { role: 'assistant', content: JSON.stringify(exp.actions) },
          ],
        }) + '\n'
      );
    }
  }

  stream.end();
  console.log(`[Learn] Saved ${experienceBuffer.length} turns to ${ftFile}`);
  experienceBuffer.length = 0;
}

/**
 * WebSocket connection and game loop
 */
function connect() {
  console.log(`Connecting to ${SERVER_URL}...`);
  console.log(`Model: ${MODEL} | Team: ${TEAM} | Learn: ${LEARN}`);

  const ws = new WebSocket(SERVER_URL);

  ws.addEventListener('open', () => {
    console.log('Connected. Authenticating...');
    ws.send(JSON.stringify({
      type: 'AUTH',
      password: PASSWORD,
      name: PLAYER_NAME,
      preferredTeam: TEAM,
    }));
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'AUTH_SUCCESS':
        teamId = msg.teamId;
        console.log(`Authenticated as ${msg.name} (Team ${teamId})\n`);
        ws.send(JSON.stringify({ type: 'GET_STATE' }));
        break;

      case 'AUTH_FAILED':
        console.error(`Auth failed: ${msg.reason}`);
        process.exit(1);
        break;

      case 'GAME_STARTED':
        console.log('=== Game Started ===');
        break;

      case 'TURN_START': {
        const state = msg.state;
        if (!state) {
          ws.send(JSON.stringify({ type: 'SUBMIT_ACTIONS', actions: [] }));
          break;
        }

        const actions = await getActions(state, teamId);
        ws.send(JSON.stringify({ type: 'SUBMIT_ACTIONS', actions }));
        break;
      }

      case 'ACTIONS_RECEIVED':
        if (msg.rejected > 0) {
          console.log(`  [!] ${msg.rejected} actions rejected`);
        }
        break;

      case 'TURN_RESULT':
        gameResults.totalTurns++;
        break;

      case 'GAME_OVER': {
        const isWin = msg.winner === teamId;
        const isTie = msg.winner === null;
        const outcome = isWin ? 'win' : isTie ? 'tie' : 'loss';

        if (isWin) gameResults.wins++;
        else if (isTie) gameResults.ties++;
        else gameResults.losses++;

        console.log(`\n=== Game Over: ${outcome.toUpperCase()} ===`);
        console.log(`Scores: Team 0 = ${msg.scores?.[0]}, Team 1 = ${msg.scores?.[1]}`);
        console.log(`Turns: ${gameResults.totalTurns} | Est cost: $${gameResults.totalCost.toFixed(4)}`);
        console.log(`Record: ${gameResults.wins}W-${gameResults.losses}L-${gameResults.ties}T\n`);

        saveExperience(outcome);
        gameResults.totalTurns = 0;
        break;
      }

      case 'PLAYER_JOINED':
        console.log(`Player joined: ${msg.name} (Team ${msg.team})`);
        break;

      case 'ERROR':
        console.error(`Server error: ${msg.error}`);
        break;
    }
  });

  ws.addEventListener('close', () => {
    console.log('Disconnected. Reconnecting in 3s...');
    setTimeout(connect, 3000);
  });

  ws.addEventListener('error', (err) => {
    console.error(`WebSocket error: ${err.message}`);
  });
}

connect();

process.on('SIGINT', () => {
  saveExperience('interrupted');
  console.log('\nShutting down...');
  process.exit(0);
});
