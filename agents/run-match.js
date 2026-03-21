/**
 * Run a match between two agents
 *
 * Usage:
 *   node run-match.js [agent1] [agent2]
 *
 * Agent types:
 *   dumb    - Random valid actions
 *   smart   - Strategic with limits (balanced)
 *   smart2  - Aggressive unit-focused (spends all gold)
 *   econ    - Economy-first, then late assault
 *
 * Examples:
 *   node run-match.js dumb dumb      # Two dumb agents
 *   node run-match.js dumb smart     # Dumb vs Smart
 *   node run-match.js smart smart    # Two smart agents
 *   node run-match.js smart2 smart   # Smart2 vs Smart
 *   node run-match.js econ smart2    # Econ vs Smart2
 */

const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const agent1Type = args[0] || 'dumb';
const agent2Type = args[1] || 'smart';

console.log(`Starting match: ${agent1Type} (Team 0) vs ${agent2Type} (Team 1)`);
console.log('Make sure the server is running on port 8080!\n');

// Small delay between spawns to ensure team assignment works
const clientPath = path.join(__dirname, 'client.js');

// Start agent 1 (Team 0)
const agent1 = spawn('node', [clientPath, agent1Type, '0', `${agent1Type}Bot-0`], {
  stdio: 'inherit',
});

// Start agent 2 (Team 1) after a short delay
setTimeout(() => {
  const agent2 = spawn('node', [clientPath, agent2Type, '1', `${agent2Type}Bot-1`], {
    stdio: 'inherit',
  });

  agent2.on('exit', (code) => {
    console.log(`Agent 2 exited with code ${code}`);
  });
}, 500);

agent1.on('exit', (code) => {
  console.log(`Agent 1 exited with code ${code}`);
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\nStopping agents...');
  process.exit(0);
});
