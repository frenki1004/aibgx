"""
Training manager for python_example.py.

Starts the game server in tournament mode, runs the Python bot, and automatically
rotates through opponent bots every GAMES_PER_OPPONENT games.  Rotating opponents
prevents the weights from over-fitting to any single bot's style.

Usage:
  python3 agents/train.py

  # Start from a specific opponent index (0-based):
  python3 agents/train.py --start-opp=2

  # Override games per opponent:
  python3 agents/train.py --games=30

Press Ctrl+C to stop cleanly.

Opponent rotation order (repeats):
  smart → smart2 → smarter → econ → dumb → (repeat)
"""

import argparse, json, os, signal, subprocess, sys, time

ROOT             = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_DIR       = os.path.join(ROOT, "agents")
HISTORY_FILE     = os.path.join(AGENTS_DIR, "learn_history.json")
BEST_FILE        = os.path.join(AGENTS_DIR, "learn_best_weights.json")

OPPONENTS        = ["aggressive", "econ", "smarter"]
GAMES_PER_OPP    = 200      # default; override with --games
POLL_INTERVAL    = 5        # seconds between history checks
SERVER_BOOT_WAIT = 3        # seconds to wait for server to start

# Rotation is snapped to eval boundaries so the fitness window is never
# split across two different opponents (avoids polluting the learning signal)
EVAL_EVERY       = 10       # must match EVAL_EVERY in python_example.py


def read_history() -> list:
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def read_game_count() -> int:
    return len(read_history())


def read_best_fitness(opponent: str) -> float:
    """
    Fitness computed only from games against the current opponent.
    This avoids the mixed-signal problem where easy wins vs 'dumb'
    inflate fitness and suppress useful mutations before facing 'smarter'.
    """
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


def start_python_bot(opponent: str = "unknown") -> subprocess.Popen:
    print(f"[train] Starting Python bot (team 0, opponent={opponent})...")
    env = {**os.environ, "TEAM": "0", "BOT_NAME": "PyBot", "OPPONENT": opponent}
    proc = subprocess.Popen(
        [sys.executable, "python_example.py"],
        cwd=AGENTS_DIR,
        env=env,
    )
    print(f"[train] Python bot running (pid {proc.pid})")
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
    parser.add_argument("--start-opp", type=int, default=0,
                        help="Index into OPPONENTS list to start from (default 0)")
    parser.add_argument("--games", type=int, default=GAMES_PER_OPP,
                        help=f"Games per opponent (default {GAMES_PER_OPP})")
    args = parser.parse_args()

    games_per_opp = args.games
    opp_idx       = args.start_opp

    server_proc = start_server()
    bot_proc    = None   # started after first opponent name is known
    opp_proc    = None

    first_opp      = OPPONENTS[opp_idx % len(OPPONENTS)]
    bot_proc       = start_python_bot(first_opp)
    baseline_count = read_game_count()
    opp_start      = baseline_count   # game count when current opponent started

    def shutdown(sig=None, frame=None):
        print("\n[train] Shutting down...")
        stop(opp_proc, "opponent")
        stop(bot_proc, "Python bot")
        stop(server_proc, "server")
        sys.exit(0)

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Snap games_per_opp to a multiple of EVAL_EVERY so we never rotate
    # mid-eval-window — otherwise the fitness window spans two opponents
    # and the learning signal becomes meaningless
    games_per_opp = max(EVAL_EVERY, (games_per_opp // EVAL_EVERY) * EVAL_EVERY)

    print(f"\n[train] Rotation: {games_per_opp} games per opponent (snapped to eval boundary)")
    print(f"[train] Order: {' → '.join(OPPONENTS)} → (repeat)\n")

    try:
        while True:
            opp_name = OPPONENTS[opp_idx % len(OPPONENTS)]

            # (Re)start opponent if not running
            if opp_proc is None or opp_proc.poll() is not None:
                opp_proc  = start_opponent(opp_name)
                opp_start = read_game_count()
                print(f"[train] Now playing vs: {opp_name}")

            time.sleep(POLL_INTERVAL)

            # Restart python bot if it crashed
            if bot_proc and bot_proc.poll() is not None:
                print("[train] Python bot crashed — restarting...")
                bot_proc = start_python_bot(opp_name)

            current      = read_game_count()
            games_vs_opp = current - opp_start
            fitness      = read_best_fitness(opp_name)

            print(f"[train] games={current}  vs={opp_name}({games_vs_opp}/{games_per_opp})  "
                  f"fitness_vs_{opp_name}(last20)={fitness:+.0f}")

            # Only rotate on an eval boundary to keep each fitness window clean
            if games_vs_opp >= games_per_opp and current % EVAL_EVERY == 0:
                next_opp = OPPONENTS[(opp_idx + 1) % len(OPPONENTS)]
                print(f"\n[train] ── Rotating: {opp_name} → {next_opp} ──\n")
                stop(opp_proc, f"opponent ({opp_name})")
                opp_proc = None
                opp_idx += 1
                # Restart bot with updated OPPONENT env var so new games
                # are tagged correctly in learn_history.json
                stop(bot_proc, "Python bot (rotation)")
                bot_proc = start_python_bot(next_opp)

    except Exception as e:
        print(f"[train] Unexpected error: {e}")
        shutdown()


if __name__ == "__main__":
    main()
