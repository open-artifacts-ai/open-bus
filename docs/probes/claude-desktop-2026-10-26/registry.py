"""Redacted snapshot of ~/.claude/sessions: one JSON line per <pid>.json.

Prints field names (values only for kind/entrypoint/version/status), the
socket's mode and owner, the sibling .key's mode, size and field names, and
which launcher the pid's parent chain reaches (Claude.app, tmux, pty host).
Never prints a peerToken, a key file name, a session name or a cwd.

    python3 -I registry.py > registry.redacted.jsonl
"""
import glob
import json
import os
import stat
import subprocess

D = os.environ.get("OPENBUS_CLAUDE_SESSIONS_DIR") or os.path.expanduser("~/.claude/sessions")
SHOW = ("kind", "entrypoint", "version", "status")


def ps(pid):
    r = subprocess.run(["ps", "-o", "ppid=,command=", "-p", str(pid)],
                       capture_output=True, text=True).stdout.strip()
    if not r:
        return None
    pp, c = r.split(None, 1)
    return int(pp), c


def launcher(pid):
    p = pid
    for _ in range(12):
        r = ps(p)
        if not r:
            return "gone"
        if "Claude.app" in r[1]:
            return "Claude.app"
        if r[1].startswith("tmux"):
            return "tmux"
        if "--bg-pty-host" in r[1]:
            return "claude bg pty host"
        if r[0] <= 1:
            return "launchd"
        p = r[0]
    return "deep"


def mode(st):
    return oct(stat.S_IMODE(st.st_mode))


for f in sorted(glob.glob(D + "/*.json"), key=lambda x: int(os.path.basename(x).split(".")[0])):
    j = json.load(open(f))
    pid = int(os.path.basename(f).split(".")[0])
    out = {
        "pid": "<pid>",
        "alive": ps(pid) is not None,
        "launcher": launcher(pid) if ps(pid) else None,
        "values": {k: j.get(k) for k in SHOW if k in j},
        "fields": sorted(j.keys()),
    }
    sock = j.get("messagingSocketPath")
    if isinstance(sock, str):
        try:
            st = os.stat(sock)
            out["socket"] = {"is_socket": stat.S_ISSOCK(st.st_mode), "mode": mode(st),
                             "owner_is_me": st.st_uid == os.getuid(),
                             "dir_mode": mode(os.stat(os.path.dirname(sock)))}
        except FileNotFoundError:
            out["socket"] = "missing"
    keys = glob.glob(f"{D}/{pid}.*.key")
    if keys:
        k = keys[0]
        st = os.stat(k)
        try:
            body = json.load(open(k))
            kf = {name: (len(v) if isinstance(v, str) and name == "peerToken" else type(v).__name__)
                  for name, v in body.items()}
        except Exception:
            kf = "unreadable"
        out["key"] = {"count": len(keys), "mode": mode(st), "bytes": st.st_size,
                      "name_suffix_hex_len": len(os.path.basename(k).split(".")[1]),
                      "fields": kf}
    print(json.dumps(out))
