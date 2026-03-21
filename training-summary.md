# AI Training Pipeline — Knowledge Distillation Approach

## Core Idea

Training on heuristic bot data (smarter, econ, etc.) caps you at their skill level.
Instead, we use **GPT-4o as the expert teacher**, then distill its intelligence into a local neural network:

```
GPT-4o plays games → collects winning decisions → trains small NN → deploys locally (free, fast)
```

This is called **knowledge distillation** — the NN learns to imitate a stronger player.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Step 1: EXPERT DATA GENERATION                         │
│                                                         │
│  GPT-4o (expert) vs heuristic bots (smarter/econ/smart2)│
│  → Only keep expert's decisions from WINNING games      │
│  → Output: state features + action labels               │
├─────────────────────────────────────────────────────────┤
│  Step 2: NEURAL NETWORK TRAINING (PyTorch)              │
│                                                         │
│  Input: 290 features (economy, units, spatial, cities)  │
│  Backbone: 290→512→256→128 (shared MLP)                 │
│  Heads:                                                 │
│    build_head  → per-city: [nothing|soldier|archer|raider]│
│    move_head   → per-unit: [stay|N|NE|E|SE|S|SW|W|NW]  │
│    expand_head → how many tiles to expand (0-15)        │
│    city_head   → should we build a city? (binary)       │
│  Export: ONNX + JSON weights                            │
├─────────────────────────────────────────────────────────┤
│  Step 3: LOCAL INFERENCE (pure JS, zero API cost)       │
│                                                         │
│  nnAgent.js loads JSON weights, runs matrix math        │
│  ~1ms per turn, no dependencies, no API key needed      │
│  Falls back to smarterAgent if model not loaded         │
└─────────────────────────────────────────────────────────┘
```

---

## Full Workflow

### Step 1: Generate Expert Data
```bash
# Requires: npm install openai && export OPENAI_API_KEY=sk-...
# GPT-4o plays 50 games against heuristic bots, collects winning turns
node training/generate-expert-data.js 50 tournament gpt-4o
```
- Output: `training/data/expert_nn_*.jsonl` (NN features + targets)
- Output: `training/data/expert_*.jsonl` (OpenAI fine-tune format)
- Cost: ~$1-5 for 50 tournament games

### Step 2: Train the Neural Network
```bash
# Requires: pip install torch numpy onnx
python training/train_nn.py training/data/expert_nn_*.jsonl --epochs 200
```
- Output: `training/models/civclash_agent.onnx`
- Output: `training/models/civclash_agent_weights.json`
- Trains on CPU in minutes (~300K params)

### Step 3: Play with the NN Agent
```bash
# Pure local inference, no API key needed
node agents/client.js nn 0 NNBot
```

### Bonus: Also Fine-Tune OpenAI (two paths)
```bash
# Use same expert data to fine-tune a smaller OpenAI model
node training/finetune.js upload training/data/expert_*.jsonl

# Play with fine-tuned model
OPENAI_MODEL=ft:gpt-4o-mini:civclash:... node agents/openaiClient.js 0
```

---

## Iterative Improvement Loop

```bash
# Round 1: GPT-4o generates expert data
node training/generate-expert-data.js 50 tournament gpt-4o

# Round 1: Train NN
python training/train_nn.py training/data/expert_nn_*.jsonl

# Round 1: Evaluate NN vs heuristic bots
node agents/run-match.js nn smarter

# Round 2: Use NN as baseline, have GPT-4o play against it
# (add NN as opponent in generate-expert-data.js)

# Round 2: Train on combined data
python training/train_nn.py training/data/expert_nn_*.jsonl --epochs 300

# Repeat: each round the NN gets stronger, GPT-4o faces harder opponents
```

---

## Why This Beats Training on Heuristic Data

| Approach | Data Source | Quality Ceiling | Cost |
|----------|-----------|-----------------|------|
| Heuristic-on-heuristic | smarterAgent vs econAgent | Limited to smarterAgent level | Free |
| **GPT-4o expert distillation** | **GPT-4o reasoning about strategy** | **GPT-4o's strategic ability** | **~$1-5** |
| OpenAI fine-tuning | Same expert data | Can exceed base model via specialization | ~$5-20 |

GPT-4o can reason about things heuristic bots can't:
- Dynamic counter-picking based on game state
- Economy timing optimization per situation
- Positional evaluation (when to push vs defend)
- Multi-step tactical planning

The NN learns to approximate these decisions without paying per-turn API costs.

---

## Files

| File | Purpose |
|------|---------|
| `training/generate-expert-data.js` | GPT-4o plays vs bots, collects expert data |
| `training/generate-dataset.js` | Heuristic bot-vs-bot data (baseline) |
| `training/train_nn.py` | PyTorch training → ONNX/JSON export |
| `training/finetune.js` | OpenAI fine-tuning pipeline |
| `agents/nnAgent.js` | Local NN inference agent (pure JS) |
| `agents/openaiAgent.js` | OpenAI API agent module |
| `agents/openaiClient.js` | Async WebSocket client for live OpenAI play |

## NN Feature Encoding (290 dimensions)

| Range | Features | Count |
|-------|----------|-------|
| 0-31 | Global: turn, gold, income, score, tiles, unit counts, cities, monuments, spatial | 32 |
| 32-171 | My units: type (one-hot), position, HP, canMove (×20 slots) | 140 |
| 172-271 | Enemy units: type (one-hot), position (×20 slots) | 100 |
| 272-289 | My cities: position, empty flag (×6 slots) | 18 |
