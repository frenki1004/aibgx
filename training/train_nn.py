"""
Neural Network Training for Civilization Clash Agent

Trains a multi-head MLP on MCTS expert data.
Two training signals from MCTS:
  - Policy: imitate MCTS visit count distributions (what to do)
  - Value: predict game outcome from state (who's winning)

Architecture:
  Input: 290 features (global stats + per-unit + per-city)
  Shared backbone: 290 → 512 → 256 → 128
  Heads:
    - build_head:  per-city unit build decision (6 × 4)
    - move_head:   per-unit move direction (20 × 9)
    - expand_head: tiles to expand (0-15)
    - city_head:   build a city? (binary)
    - value_head:  win probability [0, 1]

Usage:
  pip install torch numpy onnx
  python train_nn.py <data_files.jsonl> [--epochs 100] [--batch 64] [--lr 0.001]

Examples:
  python train_nn.py data/mcts_nn_*.jsonl --epochs 200
  python train_nn.py data/mcts_nn_*.jsonl data/expert_nn_*.jsonl  # combine sources
"""

import json
import sys
import os
import argparse
import glob
import numpy as np

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader, random_split


# ============================================================
# Dataset
# ============================================================
class MCTSDataset(Dataset):
    def __init__(self, jsonl_files):
        self.features = []
        self.build_targets = []
        self.move_targets = []
        self.expand_targets = []
        self.city_targets = []
        self.value_targets = []

        for filepath in jsonl_files:
            print(f"Loading {filepath}...")
            with open(filepath, "r") as f:
                for line in f:
                    try:
                        record = json.loads(line.strip())
                    except json.JSONDecodeError:
                        continue

                    self.features.append(record["features"])
                    t = record["targets"]
                    self.build_targets.append(t["buildDecisions"])
                    self.move_targets.append(t["moveDecisions"])
                    self.expand_targets.append(t["expandCount"])
                    self.city_targets.append(t["buildCity"])
                    # Value: win probability (1.0 = won, 0.0 = lost, 0.5 = draw)
                    self.value_targets.append(record.get("value", 0.5))

        self.features = torch.tensor(self.features, dtype=torch.float32)
        self.build_targets = torch.tensor(self.build_targets, dtype=torch.long)
        self.move_targets = torch.tensor(self.move_targets, dtype=torch.long)
        self.expand_targets = torch.tensor(self.expand_targets, dtype=torch.long)
        self.city_targets = torch.tensor(self.city_targets, dtype=torch.float32)
        self.value_targets = torch.tensor(self.value_targets, dtype=torch.float32)

        print(f"Loaded {len(self.features)} examples, {self.features.shape[1]} features")
        wins = (self.value_targets > 0.5).sum().item()
        losses = (self.value_targets < 0.5).sum().item()
        print(f"  Win examples: {wins}, Loss examples: {losses}")

    def __len__(self):
        return len(self.features)

    def __getitem__(self, idx):
        return (
            self.features[idx],
            self.build_targets[idx],
            self.move_targets[idx],
            self.expand_targets[idx],
            self.city_targets[idx],
            self.value_targets[idx],
        )


# ============================================================
# Model
# ============================================================
MAX_UNITS = 20
MAX_CITIES = 6
NUM_BUILD_OPTIONS = 4   # nothing, soldier, archer, raider
NUM_MOVE_OPTIONS = 9    # stay, N, NE, E, SE, S, SW, W, NW
MAX_EXPAND = 16         # 0-15


class CivClashNet(nn.Module):
    def __init__(self, input_dim=290):
        super().__init__()

        # Shared backbone
        self.backbone = nn.Sequential(
            nn.Linear(input_dim, 512),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(512, 256),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(256, 128),
            nn.ReLU(),
        )

        # Policy heads
        self.build_head = nn.Sequential(
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, MAX_CITIES * NUM_BUILD_OPTIONS),
        )

        self.move_head = nn.Sequential(
            nn.Linear(128, 128),
            nn.ReLU(),
            nn.Linear(128, MAX_UNITS * NUM_MOVE_OPTIONS),
        )

        self.expand_head = nn.Sequential(
            nn.Linear(128, 32),
            nn.ReLU(),
            nn.Linear(32, MAX_EXPAND),
        )

        self.city_head = nn.Sequential(
            nn.Linear(128, 16),
            nn.ReLU(),
            nn.Linear(16, 1),
        )

        # Value head (predicts win probability)
        self.value_head = nn.Sequential(
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
        )

    def forward(self, x):
        shared = self.backbone(x)

        build_logits = self.build_head(shared).view(-1, MAX_CITIES, NUM_BUILD_OPTIONS)
        move_logits = self.move_head(shared).view(-1, MAX_UNITS, NUM_MOVE_OPTIONS)
        expand_logits = self.expand_head(shared)
        city_logit = self.city_head(shared).squeeze(-1)
        value = self.value_head(shared).squeeze(-1)

        return build_logits, move_logits, expand_logits, city_logit, value


# ============================================================
# Training
# ============================================================
def train(model, train_loader, val_loader, epochs, lr, device, save_path):
    model = model.to(device)

    optimizer = optim.Adam(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=10, factor=0.5)

    build_loss_fn = nn.CrossEntropyLoss()
    move_loss_fn = nn.CrossEntropyLoss()
    expand_loss_fn = nn.CrossEntropyLoss()
    city_loss_fn = nn.BCEWithLogitsLoss()
    value_loss_fn = nn.MSELoss()

    best_val_loss = float("inf")
    patience_counter = 0
    max_patience = 30

    for epoch in range(epochs):
        model.train()
        total_loss = 0
        total_policy_loss = 0
        total_value_loss = 0
        n_batches = 0

        for features, build_t, move_t, expand_t, city_t, value_t in train_loader:
            features = features.to(device)
            build_t = build_t.to(device)
            move_t = move_t.to(device)
            expand_t = expand_t.to(device)
            city_t = city_t.to(device)
            value_t = value_t.to(device)

            build_logits, move_logits, expand_logits, city_logit, value_pred = model(features)

            # Policy losses
            b_loss = sum(
                build_loss_fn(build_logits[:, i, :], build_t[:, i])
                for i in range(MAX_CITIES)
            ) / MAX_CITIES

            m_loss = sum(
                move_loss_fn(move_logits[:, i, :], move_t[:, i])
                for i in range(MAX_UNITS)
            ) / MAX_UNITS

            e_loss = expand_loss_fn(expand_logits, expand_t)
            c_loss = city_loss_fn(city_logit, city_t)

            policy_loss = 1.0 * b_loss + 1.5 * m_loss + 0.5 * e_loss + 0.3 * c_loss

            # Value loss
            v_loss = value_loss_fn(torch.sigmoid(value_pred), value_t)

            # Combined (AlphaZero-style: policy + value)
            loss = policy_loss + 1.0 * v_loss

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            total_loss += loss.item()
            total_policy_loss += policy_loss.item()
            total_value_loss += v_loss.item()
            n_batches += 1

        avg_train_loss = total_loss / max(n_batches, 1)
        avg_policy = total_policy_loss / max(n_batches, 1)
        avg_value = total_value_loss / max(n_batches, 1)

        # Validation
        model.eval()
        val_loss = 0
        val_batches = 0
        build_correct = 0
        move_correct = 0
        value_mae = 0
        total_build = 0
        total_move = 0

        with torch.no_grad():
            for features, build_t, move_t, expand_t, city_t, value_t in val_loader:
                features = features.to(device)
                build_t = build_t.to(device)
                move_t = move_t.to(device)
                expand_t = expand_t.to(device)
                city_t = city_t.to(device)
                value_t = value_t.to(device)

                build_logits, move_logits, expand_logits, city_logit, value_pred = model(features)

                b_loss = sum(build_loss_fn(build_logits[:, i, :], build_t[:, i]) for i in range(MAX_CITIES)) / MAX_CITIES
                m_loss = sum(move_loss_fn(move_logits[:, i, :], move_t[:, i]) for i in range(MAX_UNITS)) / MAX_UNITS
                e_loss = expand_loss_fn(expand_logits, expand_t)
                c_loss = city_loss_fn(city_logit, city_t)
                v_loss = value_loss_fn(torch.sigmoid(value_pred), value_t)

                loss = (1.0 * b_loss + 1.5 * m_loss + 0.5 * e_loss + 0.3 * c_loss) + 1.0 * v_loss
                val_loss += loss.item()
                val_batches += 1

                build_pred = build_logits.argmax(dim=-1)
                move_pred = move_logits.argmax(dim=-1)
                build_correct += (build_pred == build_t).sum().item()
                move_correct += (move_pred == move_t).sum().item()
                total_build += build_t.numel()
                total_move += move_t.numel()
                value_mae += (torch.sigmoid(value_pred) - value_t).abs().sum().item()

        avg_val_loss = val_loss / max(val_batches, 1)
        build_acc = build_correct / max(total_build, 1)
        move_acc = move_correct / max(total_move, 1)
        avg_value_mae = value_mae / max(total_build // MAX_CITIES, 1)

        scheduler.step(avg_val_loss)

        if (epoch + 1) % 5 == 0 or epoch == 0:
            print(
                f"Epoch {epoch+1:4d} | "
                f"Loss: {avg_train_loss:.4f} (policy:{avg_policy:.3f} value:{avg_value:.3f}) | "
                f"Val: {avg_val_loss:.4f} | "
                f"Build: {build_acc:.3f} Move: {move_acc:.3f} ValMAE: {avg_value_mae:.3f} | "
                f"LR: {optimizer.param_groups[0]['lr']:.6f}"
            )

        if avg_val_loss < best_val_loss:
            best_val_loss = avg_val_loss
            patience_counter = 0
            torch.save(model.state_dict(), save_path)
        else:
            patience_counter += 1
            if patience_counter >= max_patience:
                print(f"\nEarly stopping at epoch {epoch+1}")
                break

    model.load_state_dict(torch.load(save_path, weights_only=True))
    print(f"\nBest validation loss: {best_val_loss:.4f}")
    return model


# ============================================================
# ONNX Export
# ============================================================
def export_onnx(model, input_dim, output_path):
    model.eval()
    dummy_input = torch.randn(1, input_dim)

    torch.onnx.export(
        model, dummy_input, output_path,
        input_names=["state_features"],
        output_names=["build_logits", "move_logits", "expand_logits", "city_logit", "value"],
        dynamic_axes={
            "state_features": {0: "batch"},
            "build_logits": {0: "batch"},
            "move_logits": {0: "batch"},
            "expand_logits": {0: "batch"},
            "city_logit": {0: "batch"},
            "value": {0: "batch"},
        },
        opset_version=13,
    )
    print(f"Exported ONNX model to {output_path}")


def export_json_weights(model, output_path):
    weights = {}
    for name, param in model.named_parameters():
        weights[name] = param.detach().cpu().numpy().tolist()
    with open(output_path, "w") as f:
        json.dump(weights, f)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Exported JSON weights to {output_path} ({size_mb:.1f} MB)")


# ============================================================
# Main
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="Train CivClash NN (MCTS distillation)")
    parser.add_argument("data", nargs="+", help="JSONL data files (supports glob)")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--lr", type=float, default=0.001)
    parser.add_argument("--output", default="models", help="Output directory")
    args = parser.parse_args()

    files = []
    for pattern in args.data:
        files.extend(glob.glob(pattern))
    if not files:
        print("No data files found!")
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    dataset = MCTSDataset(files)
    if len(dataset) < 20:
        print(f"Only {len(dataset)} examples — need more data.")
        sys.exit(1)

    val_size = max(1, int(len(dataset) * 0.15))
    train_size = len(dataset) - val_size
    train_set, val_set = random_split(dataset, [train_size, val_size])

    train_loader = DataLoader(train_set, batch_size=args.batch, shuffle=True, drop_last=len(train_set) > args.batch)
    val_loader = DataLoader(val_set, batch_size=args.batch)

    print(f"\nTrain: {train_size} | Val: {val_size}")
    print(f"Input dim: {dataset.features.shape[1]}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}\n")

    input_dim = dataset.features.shape[1]
    model = CivClashNet(input_dim=input_dim)
    param_count = sum(p.numel() for p in model.parameters())
    print(f"Model parameters: {param_count:,}\n")

    pt_path = os.path.join(args.output, "civclash_agent.pt")
    model = train(model, train_loader, val_loader, args.epochs, args.lr, device, pt_path)

    onnx_path = os.path.join(args.output, "civclash_agent.onnx")
    json_path = os.path.join(args.output, "civclash_agent_weights.json")

    export_onnx(model.cpu(), input_dim, onnx_path)
    export_json_weights(model, json_path)

    print(f"\n=== Training Complete ===")
    print(f"PyTorch:  {pt_path}")
    print(f"ONNX:     {onnx_path}")
    print(f"JSON:     {json_path}")
    print(f"\nDeploy:   node agents/client.js nn 0 NNBot")
    print(f"Guide MCTS: node training/mcts-generate.js --nn-weights {json_path}")


if __name__ == "__main__":
    main()
