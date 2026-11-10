#!/usr/bin/env python3
"""Resolve a cargo-build-sbf-compatible dependency lock for this project.

cargo-build-sbf on solana 1.18.26 uses platform-tools v1.41 (cargo 1.75),
which cannot parse edition-2024 manifests. Current crates.io resolves many
transitive dependencies of the anchor 0.30 / solana 1.18 tree to exactly
those. This script loops the sbf build: on each unparseable-manifest failure
it pins the offending crate to the newest older release that cargo 1.75 can
parse; when the graph refuses (a parent requires the new major), it pins the
parent instead. Run from the repo root. The final Cargo.lock is committed;
CI never needs this script.
"""

import json
import re
import subprocess
import sys
import tomllib
import urllib.request

CARGO = "cargo"
MANIFEST = "programs/token22_vesting/Cargo.toml"
PIN_TOOLCHAIN = "+1.75.0"
MAX_ROUNDS = 80


def run_build():
    proc = subprocess.run(
        ["cargo-build-sbf", "--manifest-path", MANIFEST],
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def offender_of(log):
    m = re.search(r"failed to parse manifest at `([^`]+)`", log)
    if m:
        base = m.group(1).rstrip("/Cargo.toml").split("/")[-1]
        mm = re.match(r"^(.+?)-v?(\d[\w.+]*)$", base)
        if mm:
            return mm.group(1), mm.group(2)
        return None
    # cargo itself names packages whose rust-version is too new for the
    # active toolchain; the fix is the same pin
    m = re.search(r"package `(\S+) v(\S+)` cannot be built", log)
    if m:
        return m.group(1), m.group(2)
    return None


def version_key(num):
    parts = []
    for piece in num.split(".")[:3]:
        digits = re.match(r"\d+", piece)
        parts.append(int(digits.group(0)) if digits else 0)
    return parts


def is_release(num):
    return bool(re.fullmatch(r"d+(.d+)*", num))


def rust_ok(rv):
    if not rv:
        return True
    parts = re.match(r"(d+).(d+)", rv)
    if not parts:
        return True
    return [int(parts.group(1)), int(parts.group(2))] <= [1, 75]


def candidates(name, floor):
    url = "https://crates.io/api/v1/crates/%s/versions" % name
    req = urllib.request.Request(url, headers={"User-Agent": "token22-vesting-resolver"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except Exception as exc:  # noqa: BLE001
        print("   api error for %s: %s" % (name, exc))
        return []
    picked = [
        v["num"]
        for v in data["versions"]
        if not v.get("yanked") and is_release(v["num"]) and rust_ok(v.get("rust_version"))
    ]
    picked.sort(key=version_key, reverse=True)
    return [v for v in picked if version_key(v) < version_key(floor)][:12]


def pin(name, from_ver):
    for cand in candidates(name, from_ver):
        cmd = [
            CARGO, PIN_TOOLCHAIN, "update", "-p", "%s@%s" % (name, from_ver),
            "--precise", cand,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode == 0:
            print("   pinned %s %s -> %s" % (name, from_ver, cand))
            return True
        retry = [CARGO, PIN_TOOLCHAIN, "update", "-p", name, "--precise", cand]
        proc2 = subprocess.run(retry, capture_output=True, text=True)
        if proc2.returncode == 0:
            print("   pinned %s %s -> %s (unqualified)" % (name, from_ver, cand))
            return True
    return False


def lock_packages():
    with open("Cargo.lock", "rb") as fh:
        return tomllib.load(fh)["package"]


def parents_of(name):
    out = []
    for pkg in lock_packages():
        for dep in pkg.get("dependencies", []):
            dep_name = dep.split(" ")[0]
            if dep_name == name:
                out.append((pkg["name"], pkg["version"]))
                break
    return out


def main():
    seen = set()
    for round_no in range(1, MAX_ROUNDS + 1):
        code, log = run_build()
        if code == 0:
            print("== sbf build succeeded after %d fix round(s)" % (round_no - 1))
            return 0
        offender = offender_of(log)
        if offender is None:
            print("== sbf build failed for a non-manifest reason:")
            print(log[-2000:])
            return 1
        name, ver = offender
        print("[%d] offender: %s@%s" % (round_no, name, ver))
        if (name, ver) in seen:
            print("== already handled %s@%s; stopping" % (name, ver))
            print(log[-800:])
            return 1
        seen.add((name, ver))

        if pin(name, ver):
            continue

        print("   direct pin impossible; walking parents")
        fixed = False
        for pname, pver in parents_of(name):
            if (pname, pver) in seen:
                continue
            seen.add((pname, pver))
            print("   parent: %s@%s" % (pname, pver))
            if pin(pname, pver):
                fixed = True
                break
        if not fixed:
            print("== no pin unblocked %s@%s; giving up" % (name, ver))
            print(log[-800:])
            return 1
    print("== round limit reached")
    return 1


if __name__ == "__main__":
    sys.exit(main())
