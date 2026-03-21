/**
 * MCTS Engine for Civilization Clash
 *
 * Monte Carlo Tree Search with macro-actions.
 * Supports both pure MCTS (heuristic rollout) and NN-guided MCTS (PUCT + value head).
 *
 * Usage:
 *   const mcts = new MCTSEngine({ simulations: 1000 });
 *   const { actions, rootVisits } = mcts.search(state, playerId);
 */

const logic = require('../logic');
const { UNIT_STATS } = require('../logic');
const { generateMacroActions } = require('./macroActions');
const smarterAgent = require('./smarterAgent');

// ============================================================
// MCTS Node
// ============================================================
class MCTSNode {
  constructor(state, playerId, parent, macroAction, prior) {
    this.state = state;
    this.playerId = playerId;
    this.parent = parent;
    this.macroAction = macroAction;      // { name, actions } that led to this node
    this.prior = prior || 0;             // NN policy prior (0 if no NN)

    this.children = [];
    this.expanded = false;

    this.visits = 0;
    this.totalValue = 0;
  }

  get q() {
    return this.visits > 0 ? this.totalValue / this.visits : 0;
  }

  /**
   * UCB1 / PUCT selection score
   * @param {number} cExplore - Exploration constant
   * @param {boolean} usePrior - Whether to use NN prior (PUCT)
   */
  ucbScore(cExplore, usePrior) {
    if (this.visits === 0) return Infinity;

    const parentVisits = this.parent ? this.parent.visits : 1;
    const exploitation = this.q;

    if (usePrior) {
      // PUCT formula (AlphaZero-style)
      const exploration = cExplore * this.prior * Math.sqrt(parentVisits) / (1 + this.visits);
      return exploitation + exploration;
    } else {
      // Standard UCB1
      const exploration = cExplore * Math.sqrt(Math.log(parentVisits) / this.visits);
      return exploitation + exploration;
    }
  }
}

// ============================================================
// MCTS Engine
// ============================================================
class MCTSEngine {
  /**
   * @param {Object} options
   * @param {number} options.simulations - Number of MCTS simulations per search (default: 500)
   * @param {number} options.rolloutDepth - Max turns to simulate in rollout (default: 30)
   * @param {number} options.cExplore - Exploration constant (default: 1.41)
   * @param {Function} options.valueFunction - NN value function: (state, pid) → [0,1] win probability
   * @param {Function} options.policyFunction - NN policy function: (state, pid, macroActions) → priors[]
   * @param {number} options.timeLimitMs - Time limit in ms (0 = use simulation count)
   */
  constructor(options = {}) {
    this.simulations = options.simulations || 500;
    this.rolloutDepth = options.rolloutDepth || 8;    // Shallow rollout for speed
    this.cExplore = options.cExplore || 1.41;
    this.valueFunction = options.valueFunction || null;
    this.policyFunction = options.policyFunction || null;
    this.timeLimitMs = options.timeLimitMs || 0;
    this.fastMode = options.fastMode || false;        // Skip rollout, just evaluate position
  }

  /**
   * Run MCTS search from a given state.
   * Returns the best macro-action and visit count distribution.
   */
  search(state, playerId) {
    const root = new MCTSNode(state, playerId, null, null, 0);
    this.expand(root);

    const startTime = Date.now();
    let simCount = 0;

    while (true) {
      // Check termination
      if (this.timeLimitMs > 0) {
        if (Date.now() - startTime >= this.timeLimitMs) break;
      } else {
        if (simCount >= this.simulations) break;
      }

      // 1. Select
      const leaf = this.select(root);

      // 2. Expand (if not terminal)
      if (!leaf.state.gameOver && !leaf.expanded) {
        this.expand(leaf);
      }

      // 3. Evaluate (rollout or NN value or fast heuristic)
      let value;
      if (leaf.state.gameOver) {
        value = this.evaluateTerminal(leaf.state, playerId);
      } else if (this.valueFunction) {
        value = this.valueFunction(leaf.state, playerId);
      } else if (this.fastMode) {
        value = this.fastRollout(leaf.state, playerId);
      } else {
        value = this.rollout(leaf.state, playerId);
      }

      // 4. Backpropagate
      this.backpropagate(leaf, value);
      simCount++;
    }

    // Extract results
    const rootVisits = {};
    let bestChild = null;
    let bestVisits = -1;

    for (const child of root.children) {
      rootVisits[child.macroAction.name] = {
        visits: child.visits,
        value: child.q,
        actions: child.macroAction.actions,
      };
      if (child.visits > bestVisits) {
        bestVisits = child.visits;
        bestChild = child;
      }
    }

    return {
      actions: bestChild ? bestChild.macroAction.actions : [],
      macroName: bestChild ? bestChild.macroAction.name : 'pass',
      rootVisits,
      totalSimulations: simCount,
      timeMs: Date.now() - startTime,
    };
  }

  /**
   * Select: traverse tree using UCB/PUCT until a leaf
   */
  select(node) {
    while (node.expanded && node.children.length > 0) {
      let bestChild = null;
      let bestScore = -Infinity;
      const usePrior = this.policyFunction !== null;

      for (const child of node.children) {
        const score = child.ucbScore(this.cExplore, usePrior);
        if (score > bestScore) {
          bestScore = score;
          bestChild = child;
        }
      }

      node = bestChild;
    }
    return node;
  }

  /**
   * Expand: generate macro-actions as children
   */
  expand(node) {
    if (node.state.gameOver) {
      node.expanded = true;
      return;
    }

    const macros = generateMacroActions(node.state, node.playerId);

    // Get NN priors if available
    let priors = null;
    if (this.policyFunction) {
      priors = this.policyFunction(node.state, node.playerId, macros);
    }

    // Simulate opponent with heuristic (or NN if available)
    const opponentId = 1 - node.playerId;

    for (let i = 0; i < macros.length; i++) {
      const macro = macros[i];
      const prior = priors ? priors[i] : 1 / macros.length;

      // Simulate this turn: our macro-action vs opponent's heuristic response
      let opponentActions;
      try {
        opponentActions = smarterAgent.generateActions(node.state, opponentId);
      } catch {
        opponentActions = [];
      }

      const actionMap = {
        player0: node.playerId === 0 ? macro.actions : opponentActions,
        player1: node.playerId === 1 ? macro.actions : opponentActions,
      };

      try {
        const result = logic.processTurn(node.state, actionMap);
        const child = new MCTSNode(result.newState, node.playerId, node, macro, prior);
        node.children.push(child);
      } catch {
        // Skip invalid macro combinations
      }
    }

    node.expanded = true;
  }

  /**
   * Fast rollout: simulate forward with lightweight heuristic.
   * Uses smarterAgent but limits rollout depth for speed.
   */
  rollout(state, playerId) {
    let currentState = state;
    const opponentId = 1 - playerId;

    for (let depth = 0; depth < this.rolloutDepth; depth++) {
      if (currentState.gameOver) break;

      let myActions, oppActions;
      try {
        myActions = smarterAgent.generateActions(currentState, playerId);
      } catch { myActions = []; }
      try {
        oppActions = smarterAgent.generateActions(currentState, opponentId);
      } catch { oppActions = []; }

      try {
        const result = logic.processTurn(currentState, {
          player0: playerId === 0 ? myActions : oppActions,
          player1: playerId === 1 ? myActions : oppActions,
        });
        currentState = result.newState;
      } catch {
        break;
      }
    }

    return this.evaluateState(currentState, playerId);
  }

  /**
   * Ultra-fast rollout: no simulation, just evaluate current position.
   * Use this when speed matters more than accuracy (high sim count).
   */
  fastRollout(state, playerId) {
    return this.evaluateState(state, playerId);
  }

  /**
   * Evaluate a state heuristically (returns value in [0, 1])
   * Weights are large enough that 1-turn differences are clearly visible to MCTS.
   */
  evaluateState(state, playerId) {
    const me = state.players.find(p => p.id === playerId);
    const opp = state.players.find(p => p.id !== playerId);

    if (state.gameOver) {
      return this.evaluateTerminal(state, playerId);
    }

    let score = 0.5; // Start neutral

    // Score advantage (the actual win condition — heavily weighted)
    const scoreDiff = me.score - opp.score;
    const maxScore = Math.max(me.score + opp.score, 1);
    score += 0.25 * Math.tanh(scoreDiff / Math.max(maxScore * 0.3, 1));

    // Income advantage (compounds every turn — very important)
    const incomeDiff = me.income - opp.income;
    score += 0.12 * Math.tanh(incomeDiff / 5);

    // Territory advantage (drives income and city placement)
    const myTiles = state.map.tiles.filter(t => t.owner === playerId).length;
    const oppTiles = state.map.tiles.filter(t => t.owner !== null && t.owner !== playerId).length;
    const totalTiles = myTiles + oppTiles + 1;
    score += 0.10 * (myTiles - oppTiles) / totalTiles;

    // Unit advantage (army strength)
    const myUnits = state.units.filter(u => u.owner === playerId);
    const oppUnits = state.units.filter(u => u.owner !== playerId);
    const unitValue = u => UNIT_STATS[u.type].cost * (u.hp || 1);
    const myArmyValue = myUnits.reduce((s, u) => s + unitValue(u), 0);
    const oppArmyValue = oppUnits.reduce((s, u) => s + unitValue(u), 0);
    const totalArmy = myArmyValue + oppArmyValue + 1;
    score += 0.15 * (myArmyValue - oppArmyValue) / totalArmy;

    // Unit count matters too (more units = more actions per turn)
    score += 0.05 * Math.tanh((myUnits.length - oppUnits.length) / 3);

    // City advantage (spawn points + income)
    const myCities = state.cities.filter(c => c.owner === playerId).length;
    const oppCities = state.cities.filter(c => c.owner !== null && c.owner !== playerId).length;
    score += 0.08 * Math.tanh(myCities - oppCities);

    // Monument control (big late-game points)
    const monuments = state.monuments || [];
    const myMon = monuments.filter(m => m.controlledBy === playerId).length;
    const oppMon = monuments.filter(m => m.controlledBy !== null && m.controlledBy !== playerId).length;
    if (monuments.length > 0) {
      score += 0.10 * (myMon - oppMon) / monuments.length;
    }

    // Forward position bonus (units closer to enemy = more threatening)
    if (myUnits.length > 0) {
      const mapW = state.map.width;
      const myCx = state.cities.filter(c => c.owner === playerId);
      const enemySide = (myCx.length > 0 && myCx[0].x < mapW / 2) ? mapW - 1 : 0;
      let myForward = 0, oppForward = 0;
      for (const u of myUnits) myForward += (mapW - Math.abs(u.x - enemySide));
      for (const u of oppUnits) oppForward += (mapW - Math.abs(u.x - (mapW - 1 - enemySide)));
      const totalForward = myForward + oppForward + 1;
      score += 0.05 * (myForward - oppForward) / totalForward;
    }

    return Math.max(0.01, Math.min(0.99, score));
  }

  /**
   * Evaluate terminal state
   */
  evaluateTerminal(state, playerId) {
    const me = state.players.find(p => p.id === playerId);
    const opp = state.players.find(p => p.id !== playerId);

    if (me.score > opp.score) return 1.0;
    if (opp.score > me.score) return 0.0;
    return 0.5;
  }

  /**
   * Backpropagate value up the tree
   */
  backpropagate(node, value) {
    while (node) {
      node.visits++;
      node.totalValue += value;
      node = node.parent;
    }
  }
}

module.exports = { MCTSEngine, MCTSNode };
