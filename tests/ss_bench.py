"""Score the renderer's secondary-structure assignment against pydssp.

The cartoon renderer assigns SS from the C-alpha trace alone (TM-align's
make_sec, plus smoothing and an extension pass). pydssp implements real DSSP,
which uses backbone N/CA/C/O hydrogen bonding. This measures how far the
CA-only approximation is from that reference, per class, so the approximation
can be tuned against something other than opinion.

Both sides MUST see the same residue list. pydssp needs all four backbone
atoms, so residues missing any of them are dropped - and the CA trace handed
to the renderer is built from exactly the surviving residues. Scoring a
different index set silently invalidates everything (that mistake cost a full
round of results on the nucleic benchmark).

    python tests/ss_bench.py --build      # parse + run pydssp -> ss_truth.json
    python tests/ss_bench.py              # (after node) print the report
"""
import argparse
import json
import os
import sys
import zipfile

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_OUT = os.path.join(_ROOT, "tests", "out")
TRUTH = os.path.join(_OUT, "ss_truth.json")

BACKBONE = ("N", "CA", "C", "O")


def parse_pdb(path):
    """-> list of (chain_id, [L,4,3] float array, [resid...]) keeping only
    residues that have all four backbone atoms."""
    chains = {}
    order = []
    with open(path) as fh:
        for line in fh:
            if not line.startswith("ATOM"):
                continue
            alt = line[16]
            if alt not in (" ", "A"):
                continue
            name = line[12:16].strip()
            if name not in BACKBONE:
                continue
            ch = line[21]
            resid = line[22:27]          # resseq + icode
            key = (ch, resid)
            if key not in chains:
                chains[key] = {}
                order.append(key)
            chains[key][name] = (
                float(line[30:38]), float(line[38:46]), float(line[46:54]))

    out = {}
    for (ch, resid) in order:
        atoms = chains[(ch, resid)]
        if any(a not in atoms for a in BACKBONE):
            continue                      # incomplete backbone: unusable
        out.setdefault(ch, {"coord": [], "resid": []})
        out[ch]["coord"].append([atoms[a] for a in BACKBONE])
        out[ch]["resid"].append(resid.strip())
    return [(ch, np.asarray(v["coord"], dtype=np.float32), v["resid"])
            for ch, v in out.items() if len(v["coord"]) >= 5]


def build(zip_path, limit=None):
    import pydssp

    tmp = os.path.join(_OUT, "_natives")
    if not os.path.isdir(tmp):
        os.makedirs(tmp, exist_ok=True)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(tmp)
    root = os.path.join(tmp, "natives")
    files = sorted(f for f in os.listdir(root) if f.endswith(".pdb"))
    if limit:
        files = files[:limit]

    records = []
    for fn in files:
        try:
            for ch, coord, resid in parse_pdb(os.path.join(root, fn)):
                # numpy path; 'c3' returns one of '-', 'H', 'E' per residue
                ss = pydssp.assign(coord, out_type="c3")
                ss = "".join(np.asarray(ss).tolist())
                ca = coord[:, 1, :]       # index 1 == CA, same residues
                records.append({
                    "name": os.path.splitext(fn)[0],
                    "chain": ch,
                    "n": int(ca.shape[0]),
                    "ca": [[round(float(v), 3) for v in p] for p in ca],
                    "dssp": ss,
                })
        except Exception as exc:
            print(f"  skip {fn}: {exc}")
    with open(TRUTH, "w") as fh:
        json.dump(records, fh)
    total = sum(r["n"] for r in records)
    print(f"wrote {TRUTH}: {len(records)} chains, {total} residues")
    comp = "".join(r["dssp"] for r in records)
    for c in "HE-":
        print(f"  {c}: {comp.count(c)} ({100.0 * comp.count(c) / len(comp):.1f}%)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--zip", default=os.path.join(_ROOT, "natives.zip"))
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    os.makedirs(_OUT, exist_ok=True)
    if a.build:
        build(a.zip, a.limit)
    else:
        print("run with --build first, then tests/ss_bench.js")
