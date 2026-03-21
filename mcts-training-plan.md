# MCTS + NN Self-Play Training Loop

## The Approach

```
MCTS (strong but slow) generates expert data
  → Train NN to predict MCTS decisions in 1ms
    → NN makes MCTS even stronger (better rollouts)
      → Generate better data
        → Train better NN
          → Repeat forever
```

No OpenAI. No API cost. Self-improving. This is the AlphaZero loop adapted for Civilization Clash.

---

## Why This Works

- **MCTS with 1000 sims** finds moves that no heuristic bot can. It literally searches the future.
- **NN learns to approximate** what 1000-sim MCTS would do, in a single forward pass (~1ms).
- **NN-guided MCTS** is stronger than pure MCTS because rollouts follow learned policy instead of random/heuristic play.
- Each loop: MCTS gets stronger → data gets better → NN gets better → MCTS gets stronger.

---

## Implementation Plan

### Phase 0: MCTS Engine

The core challenge: this game has **multi-action simultaneous turns**. Standard MCTS picks one action per node. We need to handle action bundles.

**Solution: Decomposed MCTS**

Instead of searching over all possible turn combinations (impossible — billions), decompose each turn into sequential sub-decisions:

```
Turn plan = [build_decision] → [expand_decision] → [move_decisions]
```

MCTS tree structure:
```
Root (game state at turn T)
├── Build: SOLDIER at city(2,11)
│   ├── Expand: 3 tiles toward center
│   │   ├── Move: soldiers push east, archers hold
│   │   └── Move: all units toward monument
│   └── Expand: 5 tiles toward enemy
│       ├── Move: ...
│       └── Move: ...
├── Build: ARCHER at city(2,11)
│   └── ...
├── Build: nothing (save gold)
│   └── ...
```

Each path through the tree = one complete turn plan. MCTS evaluates which plan leads to best outcomes.

**Action sampling** (to keep branching manageable):
- Build options: enumerate all valid builds (small — max 3 types × ~5 cities = 15)
- Expand options: sample 3-5 expansion strategies (aggressive/defensive/balanced)
- Move options: sample 5-10 movement plans (all-push, defend, flank, monument-rush, etc.)
- Total branches per level: ~15 × 5 × 10 = 750 plans. Manageable for MCTS.

**Opponent modeling** (simultaneous actions):
- During MCTS rollout, opponent uses heuristic policy (smarterAgent) or later the trained NN.
- This is a simplification but works well — AlphaStar used similar approach.

**Rollout policy** (for evaluating leaf nodes):
- Phase 1 (no NN): use smarterAgent heuristic for both sides, play 20-50 turns ahead
- Phase 2+ (with NN): use NN value head to evaluate position directly (no rollout needed)

**Simulation budget for data generation:**
- No time limit for offline data generation
- Use 500-2000 simulations per turn
- Each sim = play out ~30 turns with heuristic rollout ≈ 30ms
- 1000 sims × 30ms = 30 seconds per turn (fine for offline)
- 350 turns per game = ~3 hours per game (run many in parallel)

### Phase 1: Pure MCTS Data Generation (no NN)

```
Input: game engine + heuristic rollout policy
Process:
  1. For each turn, run MCTS with 1000 sims
  2. Record: state features + MCTS visit count distribution over actions
  3. Play full game, record final outcome
  4. Only keep data from winning side (or weight by score margin)
Output: dataset of (state, action_distribution, value) tuples
```

**Key: save visit counts, not just the best action.**
Visit counts encode MCTS's uncertainty — "70% of sims chose plan A, 20% plan B, 10% plan C" is richer training signal than just "chose plan A".

Target format per turn:
```json
{
  "features": [290 floats],
  "build_policy": [0.7, 0.1, 0.15, 0.05],   // visit distribution over build options
  "expand_policy": [0.3, 0.5, 0.2],          // visit distribution over expand strategies
  "move_policy": [0.4, 0.1, 0.3, 0.2],      // visit distribution over move plans
  "value": 0.73                               // win probability from this state
}
```

### Phase 2: Train NN v1

**Architecture (two heads):**

```
Input: 290 features (same encoding as before)

Shared backbone: 290 → 512 → 256 → 128

Policy head:
  128 → 64 → action_distribution
  Trained with cross-entropy against MCTS visit counts
  Outputs probability distribution over action plans

Value head:
  128 → 32 → 1 (sigmoid)
  Trained with MSE against game outcome (1=win, 0=loss)
  Outputs win probability from current state
```

**Training:**
- Loss = policy_loss (cross-entropy) + 0.5 × value_loss (MSE)
- This is exactly AlphaZero's loss function
- Train until convergence on Phase 1 data

### Phase 3: NN-Guided MCTS

Now MCTS uses the NN in two ways:

1. **Tree policy (selection):** When choosing which child to explore, bias toward nodes the NN policy head rates highly. This is the PUCT formula:
   ```
   score(node) = Q(node) + c × P(node) × sqrt(N_parent) / (1 + N_node)
   ```
   Where P(node) = NN policy prior for this action.

2. **Evaluation (no rollout):** Instead of playing out 30 turns with heuristic, just ask the NN value head: "what's the win probability here?" Instant, and gets more accurate each iteration.

**Result:** MCTS searches much deeper (no 30-turn rollout cost) and focuses on promising branches (NN policy prior). This MCTS is dramatically stronger than Phase 1 pure MCTS.

Generate new dataset with NN-guided MCTS. Repeat.

### Phase 4+: Self-Play Loop

```
for iteration in 1, 2, 3, ...:
    1. Run NN-guided MCTS self-play (MCTS vs MCTS, both using current NN)
    2. Collect (state, visit_counts, outcome) from all games
    3. Add to training data (keep last N iterations to avoid forgetting)
    4. Train NN v(iteration+1) from scratch on accumulated data
    5. Evaluate: play new NN vs old NN, must win >55% to accept
    6. If accepted, update MCTS to use new NN
```

Self-play (MCTS vs MCTS) is better than MCTS vs heuristic because:
- The opponent is always at your level → you learn from challenging games
- No ceiling from heuristic quality
- Discovers strategies no heuristic bot uses

---

## Practical Considerations

### Computation
- Phase 1: ~50 games × 350 turns × 30s/turn = ~145 hours on 1 core. Parallelize across 8 cores = ~18 hours.
- Phase 2+: NN evaluation replaces rollout → ~1ms per sim instead of 30ms. 1000 sims = 1 second/turn. 350-turn game = 6 minutes. 50 games = 5 hours on 1 core.
- Each iteration gets faster as NN replaces rollouts.

### Action Space Reduction
The multi-action problem is the hardest part. Practical approach:

**Macro-actions:** Pre-define ~20-50 "turn templates" that combine build+expand+move into single choices:
- "economy": expand max, build city if possible, defend
- "soldier_push": build soldiers, expand toward enemy, all units push
- "archer_counter": build archers, hold position, expand defensively
- "raider_flank": build raider, send through side lane, expand own side
- "monument_rush": move all toward nearest monument, minimal builds
- etc.

MCTS chooses between these templates. NN learns to predict which template is best.
This reduces branching factor from millions to ~50. Much more tractable.

Later iterations can expand the template set or switch to finer-grained action decomposition.

### Multi-Action Moves Specifically
For unit movement (the highest branching factor):
- Group units into squads (front-line, back-line, flankers)
- Define 5-8 squad-level strategies (push, hold, retreat, flank-left, flank-right, surround)
- Each strategy deterministically assigns individual unit moves via heuristic
- MCTS picks the squad strategy, heuristic fills in details

### Simultaneous Play
- During MCTS, assume opponent plays their NN policy (or heuristic in Phase 1)
- This is "open-loop" MCTS — good enough for this game since:
  - Combat outcomes are deterministic (no randomness to model)
  - Opponent's likely moves can be predicted well by NN

---

## Implementation Order

1. **MCTS engine** with macro-action templates + heuristic rollout
2. **Data pipeline**: run games, save (state, visits, outcome)
3. **NN training script** with policy + value heads
4. **NN-guided MCTS** with PUCT selection + NN evaluation
5. **Self-play loop** with evaluation gates
6. **Deploy**: NN agent that runs policy head directly (~1ms, no MCTS at game time)

For competition: the deployed agent uses ONLY the NN (no MCTS search at runtime).
MCTS is the teacher. NN is the student that plays in 1ms.
If 300ms allows it, you could also run a small 50-sim MCTS at game time for extra strength.

---

## Expected Strength Progression

| Phase | Strength | Data Source |
|-------|----------|-------------|
| Heuristic bots | Baseline | — |
| MCTS (1000 sims, heuristic rollout) | ~2x heuristic | Phase 1 |
| NN v1 (trained on MCTS data) | ~1.5x heuristic | Imitates MCTS |
| NN-guided MCTS (1000 sims) | ~3-5x heuristic | Phase 3 |
| NN v2 (trained on guided MCTS) | ~2-3x heuristic | Imitates stronger MCTS |
| After 5+ iterations of self-play | Potentially superhuman | Self-improving |
