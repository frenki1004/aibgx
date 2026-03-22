"""
Training manager for econ_example.py.

Opponent rotation: cycles to the next bot after EVERY completed game.
  Game 1 → aggressive, Game 2 → hybrid, Game 3 → smarter, Game 4 → python,
  Game 5 → monument, Game 6 → archer_swarm, Game 7 → aggressive, …

Usage:
  python3 agents/train_econ.py

  # Start from a specific opponent index (0-based):
  python3 agents/train_econ.py --start-opp=1

Press Ctrl+C to stop cleanly.
"""

import argparse, json, os, signal, subprocess, sys, time

ROOT             = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_DIR       = os.path.join(ROOT, "agents")
HISTORY_FILE     = os.path.join(AGENTS_DIR, "econ_history.json")

OPPONENTS        = ["aggressive", "hybrid", "smarter", "python", "monument", "archer_swarm"]
POLL_INTERVAL    = 3
SERVER_BOOT_WAIT = 3
EVAL_EVERY       = 10  # must match EVAL_EVERY in econ_example.py

PYTHON_BOTS = {
    "hybrid":        "hybrid_example.py",
    "python":        "python_example.py",
    "monument":      "monument_example.py",
    "archer_swarm":  "archer_swarm_example.py",
}


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
    env  = {**os.environ, "TEAM": "0", "BOT_NAME": "EconBot", "OPPONENT": opponent}
    proc = subprocess.Popen(
        [sys.executable, "econ_example.py"],
        cwd=AGENTS_DIR, env=env,
    )
    return proc


def start_opponent(name: str) -> subprocess.Popen:
    print(f"[train] Next opponent: {name}")
    script = PYTHON_BOTS.get(name)
    if script:
        env  = {**os.environ, "TEAM": "1", "BOT_NAME": f"Opp_{name}"}
        return subprocess.Popen(
            [sys.executable, script],
            cwd=AGENTS_DIR, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
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
    parser.add_argument("--opponents", type=str, default=None,
                        help="Comma-separated list of opponents, e.g. python or aggressive,econ")
    parser.add_argument("--max-games", type=int, default=0,
                        help="Stop after this many games (0 = run forever)")
    args = parser.parse_args()

    opponents   = [o.strip() for o in args.opponents.split(",")] if args.opponents else OPPONENTS
    max_games   = args.max_games
    opp_idx     = args.start_opp
    server_proc = start_server()
    opp_name    = opponents[opp_idx % len(opponents)]
    bot_proc    = start_bot(opp_name)
    opp_proc    = start_opponent(opp_name)
    start_count = read_game_count()
    last_count  = start_count

    limit_str = f"  max={max_games} games" if max_games else ""
    print(f"[train] Rotating every game. Order: {' → '.join(opponents)} → (repeat){limit_str}")
    print(f"[train] Game 1 vs: {opp_name}\n")

    def shutdown(sig=None, frame=None):
        print("\n[train] Shutting down...")
        stop(opp_proc, "opponent")
        stop(bot_proc,  "EconBot")
        stop(server_proc, "server")
        sys.exit(0)

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        while True:
            time.sleep(POLL_INTERVAL)

            if bot_proc.poll() is not None:
                print("[train] EconBot crashed — restarting...")
                bot_proc = start_bot(opp_name)

            current    = read_game_count()
            games_done = current - last_count

            if games_done > 0:
                fitness = read_fitness(opp_name)
                games_this_run = current - start_count
                print(f"[train] game={current} (+{games_this_run})  vs={opp_name}  fitness={fitness:+.0f}")

                for _ in range(games_done):
                    opp_idx += 1
                last_count = current

                if max_games and games_this_run >= max_games:
                    print(f"\n[train] Reached {max_games} games — stopping.")
                    shutdown()

                opp_name = opponents[opp_idx % len(opponents)]
                stop(opp_proc, "opponent")
                opp_proc = start_opponent(opp_name)
                print(f"[train] Next game vs: {opp_name}")

            elif opp_proc.poll() is not None:
                opp_proc = start_opponent(opp_name)

    except Exception as e:
        print(f"[train] Unexpected error: {e}")
        shutdown()


if __name__ == "__main__":
    main()
