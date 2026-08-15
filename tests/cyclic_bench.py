"""Build the cyclic-peptide secondary-structure benchmark.

Head-to-tail cyclic peptides have no N or C terminus: the backbone closes into a
ring. Every SS assigner in this repo - and pydssp, and DSSP itself - walks the
chain by index, so the closure is invisible to all of them and an element
spanning it gets cut in two. This benchmark exists to measure exactly that.

TRUTH ON A RING. pydssp is linear, so running it once would bake the same bug
into the reference it is supposed to expose. Instead every chain is scored under
TWO rotations of its residue order (shift 0 and shift n//2). A ring rotates into
a different but equally valid linear chain - the coordinates never move, only
where the artificial break falls - so each residue is assigned twice, once near
a break and once far from it, and the far one is kept. DSSP is local (its
patterns span a few residues), so a residue well away from both ends of its
rotation gets the assignment it would have had on a true ring.

    python tests/cyclic_bench.py --build   # fetch + pydssp -> cyclic_truth.json
    node tests/cyclic_bench.js             # report

Requires pydssp and numpy. Structures are fetched from RCSB once and cached.
"""
import argparse
import json
import os
import urllib.request

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_OUT = os.path.join(_ROOT, "tests", "out")
_CACHE = os.path.join(_OUT, "_cyclic")
TRUTH = os.path.join(_OUT, "cyclic_truth.json")

BACKBONE = ("N", "CA", "C", "O")

# Backbone-cyclised peptides and proteins. Picked to span the SS classes,
# because the whole point is elements that cross the seam:
#   cyclotides / knottins  - beta sheet + cystine knot
#   theta-defensins        - a cyclic beta hairpin, seam inside the sheet
#   SFTI-1                 - 14 residues, beta hairpin
#   AS-48 and relatives    - 60-70 residues, all-alpha, seam inside a HELIX
CANDIDATES = [
    # cyclotides
    "1NB1", "1JJZ", "1KAL", "1DF6", "1BH4", "1YP8", "2KNM", "1ZA8", "1VB8",
    # cyclic knottin trypsin inhibitors
    "1IB9", "1HA9",
    # sunflower trypsin inhibitor
    "1JBL",
    # theta-defensins
    "1HVZ", "2LYE", "1ZMM",
    # cyclic bacteriocins (alpha-helical, the seam-in-helix cases)
    "1E68", "1O82", "1O83", "2KJF", "2N8O", "1RUW", "2KJG",
]

# A closing peptide bond, C(last) -> N(first). The real test of cyclicity:
# a CA-CA proximity test also fires on a hairpin whose termini merely touch.
PEPTIDE_BOND_MAX = 1.8


def fetch(pdb_id):
    os.makedirs(_CACHE, exist_ok=True)
    path = os.path.join(_CACHE, f"{pdb_id}.pdb")
    if not os.path.exists(path):
        url = f"https://files.rcsb.org/download/{pdb_id}.pdb"
        with urllib.request.urlopen(url, timeout=30) as r:
            data = r.read()
        with open(path, "wb") as fh:
            fh.write(data)
    return path


def parse_pdb(path):
    """-> list of (chain, [L,4,3], resids). First MODEL only; residues missing
    any backbone atom are dropped, exactly as ss_bench.py does."""
    out = {}
    with open(path) as fh:
        for line in fh:
            if line.startswith("ENDMDL"):
                break
            if not (line.startswith("ATOM") or line.startswith("HETATM")):
                continue
            name = line[12:16].strip()
            if name not in BACKBONE:
                continue
            alt = line[16]
            if alt not in (" ", "A"):
                continue
            ch = line[21]
            resid = line[22:27].strip()
            xyz = [float(line[30:38]), float(line[38:46]), float(line[46:54])]
            out.setdefault(ch, {}).setdefault(resid, {})[name] = xyz
    res = []
    for ch, residues in out.items():
        coord, ids = [], []
        for resid, atoms in residues.items():
            if any(a not in atoms for a in BACKBONE):
                continue
            coord.append([atoms[a] for a in BACKBONE])
            ids.append(resid)
        if len(coord) >= 8:
            res.append((ch, np.asarray(coord, dtype=np.float32), ids))
    return res


def is_cyclic(coord):
    """coord: [L,4,3] with atom order N, CA, C, O."""
    c_last = coord[-1][BACKBONE.index("C")]
    n_first = coord[0][BACKBONE.index("N")]
    return float(np.linalg.norm(c_last - n_first)) < PEPTIDE_BOND_MAX


def cyclic_truth(coord):
    """DSSP on a ring: assign under two rotations, keep each residue from the
    rotation in which it sits furthest from an artificial chain end."""
    import pydssp

    n = coord.shape[0]
    shifts = (0, n // 2)
    best = [None] * n
    best_margin = [-1] * n
    for s in shifts:
        rot = np.concatenate([coord[s:], coord[:s]], axis=0)
        ss = "".join(np.asarray(pydssp.assign(rot, out_type="c3")).tolist())
        for p, c in enumerate(ss):
            i = (p + s) % n
            margin = min(p, n - 1 - p)
            if margin > best_margin[i]:
                best_margin[i] = margin
                best[i] = c
    return "".join(best), min(best_margin)


def build(limit=None):
    ids = CANDIDATES[:limit] if limit else CANDIDATES
    records, skipped = [], []
    for pdb_id in ids:
        try:
            path = fetch(pdb_id)
        except Exception as exc:
            skipped.append(f"{pdb_id}: fetch failed ({exc})")
            continue
        try:
            chains = parse_pdb(path)
        except Exception as exc:
            skipped.append(f"{pdb_id}: parse failed ({exc})")
            continue
        kept = 0
        for ch, coord, ids_ in chains:
            if not is_cyclic(coord):
                continue
            ss_cyc, margin = cyclic_truth(coord)
            # what a linear reference would have said, for reference only
            import pydssp
            ss_lin = "".join(np.asarray(
                pydssp.assign(coord, out_type="c3")).tolist())
            ca = coord[:, BACKBONE.index("CA"), :]
            records.append({
                "name": pdb_id,
                "chain": ch,
                "n": int(ca.shape[0]),
                "ca": [[round(float(v), 3) for v in p] for p in ca],
                "dssp": ss_cyc,
                "dssp_linear": ss_lin,
                "min_margin": int(margin),
            })
            kept += 1
        if not kept:
            skipped.append(f"{pdb_id}: no cyclic chain "
                           f"(C-N closure over {PEPTIDE_BOND_MAX} A)")
    with open(TRUTH, "w") as fh:
        json.dump(records, fh)
    total = sum(r["n"] for r in records)
    print(f"wrote {TRUTH}: {len(records)} cyclic chains, {total} residues")
    comp = "".join(r["dssp"] for r in records)
    for c in "HE-":
        print(f"  {c}: {comp.count(c)} ({100.0 * comp.count(c) / len(comp):.1f}%)")
    # how much the cyclic reference differs from a naive linear one - this is
    # the headroom the benchmark is measuring
    diff = sum(1 for r in records
               for a, b in zip(r["dssp"], r["dssp_linear"]) if a != b)
    print(f"  cyclic vs linear reference: {diff} residues differ "
          f"({100.0 * diff / total:.1f}%)")
    if skipped:
        print("skipped:")
        for s in skipped:
            print("  " + s)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    if a.build:
        build(a.limit)
    else:
        print("run with --build first, then tests/cyclic_bench.js")
