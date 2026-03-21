# RL vs Hard-Coded Strategy: 20-Hour Prediction

## Verdict: Hard-Coded Strategy Wins — Decisively

**Confidence: 85-90%** that a well-crafted heuristic bot will outperform an RL bot built from scratch in 20 hours.

---

## The Numbers

### Hard-Coded Strategy (20h budget)

| Task | Time | Output |
|------|------|--------|
| Analyze existing bots + game mechanics | 1-2h | Full strategic understanding |
| Design improved heuristic architecture | 1-2h | State machine with phases |
| Implement economy optimizer | 2-3h | Optimal city/expand/unit timing |
| Implement combat micro (counter-picking, ZoC awareness) | 3-4h | Tactical unit control |
| Implement strategic macro (lane assignment, monument timing) | 2-3h | High-level decision making |
| Test against existing bots + iterate | 3-4h | Win rate optimization |
| Edge cases + polish | 2-3h | Robustness |
| **Total** | **14-21h** | **Competition-ready bot** |

**Expected win rate vs existing bots:** 80-95%

### Reinforcement Learning (20h budget)

| Task | Time | Output |
|------|------|--------|
| Set up RL framework (PyTorch/TF + stable-baselines or custom) | 1-2h | Boilerplate |
| Design state encoding (25x23 map × features → tensor) | 2-4h | Input pipeline |
| Design action space encoding (variable-length multi-action → network output) | 3-5h | **This is the hard part** |
| Design reward function | 1-2h | Reward shaping |
| Build training loop with headless game integration | 2-4h | Self-play pipeline |
| Train + debug + iterate | 4-6h | Partially trained model |
| Integrate with WebSocket client | 1h | Deployment |
| **Total** | **14-24h** | **Undertrained agent** |

**Expected win rate vs existing bots:** 30-60% (likely loses to smarterAgent)

---

## Why RL Loses in 20 Hours

### 1. Action Space is a Nightmare for RL

This game has **variable-length, multi-action turns**. Each turn you submit 5-50+ simultaneous actions (move unit A, move unit B, build soldier at city C, expand tile D...). This is not a single discrete action like Atari or a fixed-size output like Chess.

Options to handle this:
- **Autoregressive decoding** (emit actions one at a time): Requires sequential inference per turn, massively slows training. Each "step" is really 10-50 sub-steps.
- **Fixed-size action vector**: Wastes capacity, requires masking, doesn't scale with army size.
- **Per-unit policy**: Needs coordination mechanism between units. Essentially multi-agent RL within a single player.

Each approach adds 3-5 hours of engineering and debugging. This single problem can consume half your budget.

### 2. State Space Requires Non-Trivial Encoding

- 25x23 grid with per-tile features (type, owner, unit type, unit HP, city, monument)
- Fog of war means partial observability → needs memory (LSTM/transformer) or frame stacking
- Global features (gold, score, income, turn number, unit counts) need separate encoding path
- A good CNN + MLP hybrid architecture takes time to design and tune

### 3. Reward Shaping is Critical and Hard to Get Right

The game score is sparse and delayed. Naive reward = final score leads to:
- No learning signal for 200-350 turns
- Credit assignment problem: which of 5000+ actions mattered?

You need dense rewards (gold gained, territory captured, units killed, monuments controlled), but over-shaping rewards causes reward hacking (e.g., agent farms gold but never attacks).

Getting this balance right typically takes multiple iterations — each iteration requiring hours of training to evaluate.

### 4. Training Volume is Insufficient

Even with fast headless simulation (~100ms/game):
- 20h of training = ~720,000 games maximum
- But training is not just simulation — gradient updates, logging, checkpointing
- Realistic: **50,000-200,000 games** in the remaining training time after engineering

For a game of this complexity (larger state/action than most board games), convergence typically requires millions of games. AlphaZero needed 44 million games for Chess. Even simple RL environments like CartPole need 100K+ steps.

### 5. No Existing Infrastructure

Starting from zero:
- No state encoder
- No action decoder
- No reward function
- No training loop
- No self-play framework
- No evaluation pipeline

Every piece must be built, debugged, and integrated. This is a full ML engineering project.

---

## Why Hard-Coded Strategy Wins

### 1. Game Mechanics Are Highly Exploitable

The counter-triangle is **deterministic** (not probabilistic):
- Soldier kills Raider in one hit (always)
- Archer kills Soldier in one hit (always)
- Raider kills Archer in one hit (always)

This means perfect counter-picking is a simple lookup table, not a learned behavior. A heuristic bot that scouts and counter-picks will dominate any bot that doesn't.

### 2. Economy Has Analytical Solutions

The upkeep curve `1.0 × (1.5^excess - 1) / 0.5` is a known function. You can calculate exactly when to build cities vs units to maximize army size. This is a solved optimization problem — no learning needed.

Optimal city timing:
- City ROI = `5G/turn ÷ cost` → Build cities early, army late
- Territory expansion ROI = `0.5G/turn ÷ 5G` → Always expand when safe
- Unit upkeep breakpoints can be precomputed

### 3. Existing Bots Provide a Strong Foundation

The `smarterAgent.js` and `econAgent.js` already implement:
- Territory expansion logic
- City building heuristics
- Unit movement scoring
- Basic army composition

20 hours of iteration on these existing ~1500 lines of code can produce a dramatically stronger bot.

### 4. Domain Knowledge Translates Directly

Every strategic insight becomes code immediately:
- "Raiders should flank through side lanes" → pathfinding heuristic
- "Build 3 cities before any army" → phase-based state machine
- "Counter-pick based on enemy composition" → unit type lookup
- "Control monuments when score is close" → conditional objective

No training loop, no convergence waiting, no hyperparameter tuning.

### 5. Deterministic Behavior is Debuggable

When a heuristic bot loses, you can watch the replay and see exactly why. Fix the specific failure case in 10 minutes. An RL bot that loses gives you... a loss. Diagnosing why a neural network made a bad move is a research problem, not a 20-minute fix.

---

## When Would RL Win Instead?

RL would be the better choice if:

- **Time budget was 200+ hours** (enough to build infrastructure AND train)
- **Pre-built RL framework existed** for this game (state/action encoding already solved)
- **Game had hidden optimal strategies** that humans can't easily reason about
- **Game mechanics were stochastic** (probabilities that humans estimate poorly)
- **The competition meta was mature** (all obvious heuristics already exploited)

None of these conditions apply here.

---

## Recommended 20-Hour Plan: Hard-Coded Strategy

### Phase 1: Foundation (Hours 0-4)
1. Study all game mechanics deeply (constants.js, processor.js)
2. Run existing bots against each other, analyze replays
3. Design a phase-based architecture:
   - **Early game** (turns 0-50): Expand territory, build 3-4 cities
   - **Mid game** (turns 50-150): Build army, contest monuments, scout
   - **Late game** (turns 150-350): All-in push, counter-pick, capture cities

### Phase 2: Economy Engine (Hours 4-8)
4. Implement optimal city placement (maximize territory coverage)
5. Implement optimal expansion (greedy BFS toward enemy)
6. Implement upkeep-aware unit purchasing (stay below breakpoints)
7. Implement gold budgeting (reserve for cities, spend excess on army)

### Phase 3: Combat Intelligence (Hours 8-14)
8. Implement threat detection (track visible enemies, infer fog positions)
9. Implement counter-picking (if enemy has soldiers → build archers)
10. Implement ZoC-aware movement (keep archers behind soldier screen)
11. Implement raider flanking (send through side lanes to plunder)
12. Implement city defense (garrison soldiers at vulnerable cities)

### Phase 4: Strategic Polish (Hours 14-18)
13. Implement monument control timing
14. Implement adaptive aggression (score-based phase transitions)
15. Implement fog-of-war inference (track last-known enemy positions)
16. Test extensively against all existing bots

### Phase 5: Tournament Prep (Hours 18-20)
17. Stress test with rapid games
18. Handle edge cases (disconnection recovery, invalid action cleanup)
19. Performance optimization (stay well under 2s timeout)
20. Final parameter tuning

---

## Hybrid Approach (If You Want Both)

If you're determined to explore RL, a pragmatic hybrid in 20h:

| Hours | Activity |
|-------|----------|
| 0-12 | Build strong heuristic bot (Phases 1-3 above) |
| 12-16 | Add simple learning layer: tune heuristic weights via evolutionary strategy or bandit optimization against the heuristic bot |
| 16-20 | Evaluate, pick whichever performs better for competition |

This gives you a guaranteed strong baseline with optional upside from lightweight optimization. The "learning" here is parameter tuning (20-50 weights), not end-to-end RL (millions of parameters).

---

## Summary

| Dimension | Hard-Coded | RL (from scratch) |
|-----------|-----------|-------------------|
| Engineering time | 14-18h | 14-24h |
| Time left for iteration | 2-6h | 0h (if lucky) |
| Win rate vs existing bots | 80-95% | 30-60% |
| Debuggability | High | Low |
| Risk of total failure | Low | Medium-High |
| Ceiling (unlimited time) | Medium | Very High |
| **Ceiling in 20h** | **High** | **Low** |

**Bottom line:** RL's theoretical ceiling is higher, but its floor in 20 hours is much lower. Hard-coded strategy has the better expected value, lower variance, and higher floor. Build the heuristic bot.
