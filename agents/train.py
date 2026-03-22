"""
Training manager for python_example.py.

Opponent rotation: cycles to the next bot after EVERY completed game.
  Game 1 → aggressive, Game 2 → econ, Game 3 → smarter, Game 4 → aggressive, …

Usage:
  python3 agents/train.py

  # Start from a specific opponent index (0-based):
  python3 agents/train.py --start-opp=1

Press Ctrl+C to stop cleanly.
"""

import argparse, json, os, signal, subprocess, sys, time

ROOT             = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_DIR       = os.path.join(ROOT, "agents")
HISTORY_FILE     = os.path.join(AGENTS_DIR, "learn_history.json")

OPPONENTS        = ["aggressive", "econ", "smarter"]
POLL_INTERVAL    = 3
SERVER_BOOT_WAIT = 3
EVAL_EVERY       = 10  # must match EVAL_EVERY in python_example.py


def read_game_count() -> int:
    try:
        with open(HISTORY_FILE) as f:
            return len(json.load(f))
    except Exception:
        return 0


def read_fitness(opponent: str) -> float:
    try:
        with open(HISTORY_FILE) as f:
            history = json.load(f)
        filtered = [g for g in history if g.get("opponent") == opponent][-20:]
        if not filtered:
            return 0.0
        return sum(g["score_delta"] for g in filtered) / len(filtered)
    except Exception:
        return 0.0


def kill_stale_server():
    """Kill any existing server/bot processes so port 8080 is free."""
    import signal as _signal
    killed = []
    for proc_name in ["server/server.js", "hybrid_example.py", "python_example.py",
                      "aggressive_example.py", "econ_example.py", "monument_example.py",
                      "archer_swarm_example.py"]:
        result = subprocess.run(["pgrep", "-f", proc_name], capture_output=True, text=True)
        for pid_str in result.stdout.split():
            try:
                os.kill(int(pid_str), _signal.SIGKILL)
                killed.append(pid_str)
            except ProcessLookupError:
                pass
    if killed:
        print(f"[train] Killed stale processes: {', '.join(killed)}")
        time.sleep(1)


def start_server() -> subprocess.Popen:
    kill_stale_server()
    print("[train] Starting server...")
    proc = subprocess.Popen(
        ["node", "server/server.js", "--tournament"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(SERVER_BOOT_WAIT)
    if proc.poll() is not None:
        sys.exit("[train] ERROR: server failed to start")
    print(f"[train] Server running (pid {proc.pid})")
    return proc


def start_bot(opponent: str) -> subprocess.Popen:
    env  = {**os.environ, "TEAM": "0", "BOT_NAME": "PyBot", "OPPONENT": opponent}
    proc = subprocess.Popen(
        [sys.executable, "python_example.py"],
        cwd=AGENTS_DIR, env=env,
    )
    return proc


def start_opponent(name: str) -> subprocess.Popen:
    print(f"[train] Next opponent: {name}")
    return subprocess.Popen(
        ["node", "client.js", name, "1", f"Opp_{name}"],
        cwd=AGENTS_DIR,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


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
    args = parser.parse_args()

    opp_idx     = args.start_opp
    server_proc = start_server()
    opp_name    = OPPONENTS[opp_idx % len(OPPONENTS)]
    bot_proc    = start_bot(opp_name)
    opp_proc    = start_opponent(opp_name)
    last_count  = read_game_count()

    print(f"[train] Rotating every game. Order: {' → '.join(OPPONENTS)} → (repeat)")
    print(f"[train] Game 1 vs: {opp_name}\n")

    def shutdown(sig=None, frame=None):
        print("\n[train] Shutting down...")
        stop(opp_proc, "opponent")
        stop(bot_proc,  "PyBot")
        stop(server_proc, "server")
        sys.exit(0)

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        while True:
            time.sleep(POLL_INTERVAL)

            if bot_proc.poll() is not None:
                print("[train] PyBot crashed — restarting...")
                bot_proc = start_bot(opp_name)

            current    = read_game_count()
            games_done = current - last_count

            if games_done > 0:
                fitness = read_fitness(opp_name)
                print(f"[train] game={current}  vs={opp_name}  fitness={fitness:+.0f}")

                for _ in range(games_done):
                    opp_idx += 1
                last_count = current

                opp_name = OPPONENTS[opp_idx % len(OPPONENTS)]
                stop(opp_proc, "opponent")
                opp_proc = start_opponent(opp_name)

            elif opp_proc.poll() is not None:
                opp_proc = start_opponent(opp_name)

    except Exception as e:
        print(f"[train] Unexpected error: {e}")
        shutdown()


if __name__ == "__main__":
    main()
