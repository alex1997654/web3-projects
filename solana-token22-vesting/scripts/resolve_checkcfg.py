#!/usr/bin/env python3
"""Pin down crates whose manifests carry a [lints] table.

The sbf toolchain rustc (1.84.1-dev) rejects the --check-cfg flags that cargo
1.99 emits for such crates. Cargo only adds those flags when a dependency
declares [lints], so pinning each offender to an older release without that
table restores the build. Runs cargo-build-sbf repeatedly until it passes.

Usage: python3 scripts/resolve_checkcfg.py
"""

import json
import re
import subprocess
import sys
import urllib.request

MANIFEST = "programs/token22_vesting/Cargo.toml"
CUTOFF = "2024-12-31"
API = "https://crates.io/api/v1/crates/%s/versions"


def vkey(num):
    parts = []
    for piece in num.split(".")[:3]:
        digits = re.match(r"\d+", piece)
        parts.append(int(digits.group(0)) if digits else 0)
    return parts


def is_release(num):
    return bool(re.fullmatch(r"\d+(\.\d+)*", num))


def releases(name):
    req = urllib.request.Request(API % name, headers={"User-Agent": "t22v-resolver"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)["versions"]
    except Exception as exc:
        print("api failed for %s: %s" % (name, exc))
        return []


def build():
    proc = subprocess.run(
        ["cargo-build-sbf", "--manifest-path", MANIFEST],
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def offender(log):
    m = re.search(r"error: could not compile \x60([^\x60]+)\x60 \(lib\)", log)
    if m and "check-cfg" in log:
        return m.group(1)
    return None


def current_version(name):
    lock = open("Cargo.lock").read()
    m = re.search(r'name = "%s"\nversion = "([^"]+)"' % re.escape(name), lock)
    return m.group(1) if m else None


def pin(name, target):
    last_err = ""
    for spec in ("%s@%s" % (name, current_version(name)), name):
        proc = subprocess.run(
            ["cargo", "update", "-p", spec, "--precise", target],
            capture_output=True, text=True,
        )
        if proc.returncode == 0:
            subprocess.run(["sed", "-i", "0,/^version = 4$/s//version = 3/", "Cargo.lock"])
            return True
        last_err = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else ""
    print("  pin %s -> %s failed: %s" % (name, target, last_err))
    return False


def main():
    for round_no in range(40):
        code, log = build()
        if code == 0:
            print("== sbf build clean after %d pin round(s)" % round_no)
            return 0
        name = offender(log)
        if not name:
            print("== sbf build failed for a non-checkcfg reason:")
            print("\n".join(log.strip().splitlines()[-12:]))
            return 1
        ver = current_version(name)
        print("[%d] offender: %s@%s" % (round_no, name, ver))
        vers = releases(name)
        cands = [
            v["num"] for v in vers
            if not v.get("yanked")
            and is_release(v["num"])
            and (v.get("created_at", "")[:10] <= CUTOFF)
            and vkey(v["num"]) < vkey(ver)
        ]
        cands.sort(key=vkey, reverse=True)
        for cand in cands[:8]:
            print("   trying %s -> %s" % (name, cand))
            if pin(name, cand):
                print("   pinned %s -> %s" % (name, cand))
                break
        else:
            print("   no pin worked for %s" % name)
            return 1
    print("== gave up after 40 rounds")
    return 1


if __name__ == "__main__":
    sys.exit(main())
