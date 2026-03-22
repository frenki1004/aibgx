"""
Training manager for hybrid_example.py.

Usage:
  python3 agents/train_hybrid.py

  # Override games per opponent:
  python3 agents/train_hybrid.py --games=50

  # Start from a specific opponent index (0-based):
  python3 agents/train_hybrid.py --start-opp=1

Press Ctrl+C to stop cleanly.

Opponent rotation order (repeats):
  smarter → aggressive → econ → (repeat)
"""

import argparse, json, os, signal, subprocess, sys, time

ROOT             = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_DIR       = os.path.join(ROOT, "agents")
HISTORY_FILE     = os.path.join(AGENTS_DIR, "hybrid_history.json")
BEST_FILE        = os.path.join(AGENTS_DIR, "hybrid_best_weights.json")

OPPONENTS        = ["aggressive", "econ", "smarter"]
GAMES_PER_OPP    = 50       # default; override with --games
POLL_INTERVAL    = 5        # seconds between history checks
SERVER_BOOT_WAIT = 3        # seconds to wait for server to start

EVAL_EVERY       = 10       # must match EVAL_EVERY in hybrid_example.py


def read_history() -> list:
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def read_game_count() -> int:
    return len(read_history())


def read_best_fitness(opponent: str) -> float:
    try:
        history = read_history()
        filtered = [g for g in history if g.get("opponent") == opponent][-20:]
        if not filtered:
            return 0.0
        return sum(g["score_delta"] for g in filtered) / len(filtered)
    except Exception:
        return 0.0


def start_server() -> subprocess.Popen:
    print("[train] Starting server (tournament mode)...")
    proc = subprocess.Popen(
        ["node", "server/server.js", "--tournament"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(SERVER_BOOT_WAIT)
    if proc.poll() is not None:
        sys.exit("[train] ERROR: server failed to start")
    print(f"[train] Server running (pid {proc.pid})")
    return proc


def start_bot(opponent: str = "unknown") -> subprocess.Popen:
    print(f"[train] Starting HybridBot (team 0, opponent={opponent})...")
    env = {**os.environ, "TEAM": "0", "BOT_NAME": "HybridBot", "OPPONENT": opponent}
    proc = subprocess.Popen(
        [sys.executable, "hybrid_example.py"],
        cwd=AGENTS_DIR,
        env=env,
    )
    print(f"[train] HybridBot running (pid {proc.pid})")
    return proc


def start_opponent(name: str) -> subprocess.Popen:
    print(f"[train] Starting opponent: {name} (team 1)")
    proc = subprocess.Popen(
        ["node", "client.js", name, "1", f"Opp_{name}"],
        cwd=AGENTS_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc


def stop(proc: subprocess.Popen, label: str):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        print(f"[train] Stopped {label}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-opp", type=int, default=0)
    parser.add_argument("--games", type=int, default=GAMES_PER_OPP)
    args = parser.parse_args()

    games_per_opp = max(EVAL_EVERY, (args.games // EVAL_EVERY) * EVAL_EVERY)
    opp_idx       = args.start_opp

    server_proc = start_server()
    first_opp   = OPPONENTS[opp_idx % len(OPPONENTS)]
    bot_proc    = start_bot(first_opp)
    opp_proc    = None
    opp_start   = read_game_count()

    def shutdown(sig=None, frame=None):
        print("\n[train] Shutting down...")
        stop(opp_proc, "opponent")
        stop(bot_proc, "HybridBot")
        stop(server_proc, "server")
        sys.exit(0)

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f"\n[train] Rotation: {games_per_opp} games per opponent")
    print(f"[train] Order: {' → '.join(OPPONENTS)} → (repeat)\n")

    try:
        while True:
            opp_name = OPPONENTS[opp_idx % len(OPPONENTS)]

            if opp_proc is None or opp_proc.poll() is not None:
                opp_proc  = start_opponent(opp_name)
                opp_start = read_game_count()
                print(f"[train] Now playing vs: {opp_name}")

            time.sleep(POLL_INTERVAL)

            if bot_proc and bot_proc.poll() is not None:
                print("[train] HybridBot crashed — restarting...")
                bot_proc = start_bot(opp_name)

            current      = read_game_count()
            games_vs_opp = current - opp_start
            fitness      = read_best_fitness(opp_name)

            print(f"[train] games={current}  vs={opp_name}({games_vs_opp}/{games_per_opp})  "
                  f"fitness(last20)={fitness:+.0f}")

            if games_vs_opp >= games_per_opp and current % EVAL_EVERY == 0:
                next_opp = OPPONENTS[(opp_idx + 1) % len(OPPONENTS)]
                print(f"\n[train] ── Rotating: {opp_name} → {next_opp} ──\n")
                stop(opp_proc, f"opponent ({opp_name})")
                opp_proc = None
                opp_idx += 1
                stop(bot_proc, "HybridBot (rotation)")
                bot_proc = start_bot(next_opp)

    except Exception as e:
        print(f"[train] Unexpected error: {e}")
        shutdown()


if __name__ == "__main__":
    main()
