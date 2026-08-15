"""Fit the peptide table the cartoon rebuilds backbones with, and score the frames.

The cartoon needs to know which way a strand faces. C-alpha curvature does not
say: it is dominated by the pleat, and it knows nothing about the neighbouring
strand, so two hydrogen-bonded residues ended up with their ribbon faces 38.9 deg
apart (median, over the natives) and sheets visibly failed to stack edge to edge.
The frames built here bring that to 21.2 deg, which is the floor: the sheets
themselves twist 20.0 deg between paired residues.

What does say is the backbone - a strand's carbonyls point at the strand it
pairs with, and its hydrogen bonds say which strand that is. py2Dmol only holds
C-alphas, so the backbone is REBUILT from the trace, PULCHRA-style (Rotkiewicz &
Skolnick 2008): bin the local internal coordinates, look up the peptide. PULCHRA
looks up a whole fragment and superimposes it; only C and N are needed here (O
follows from sp2 geometry), so it is one table read per residue.

This script fits that table - PEPTIDE_TABLE in viewer-cartoon.js - and reports
what it is worth on held-out chains. tests/ss_bench.js scores the secondary
structure that DSSP then derives from the rebuilt backbone, and
tests/sheet_bench.js scores the strand frames built on the sheet.

    python tests/sheet_bench.py --build   # natives.zip -> tests/out/sheet_truth.json
    python tests/sheet_bench.py --fit     # print the PEPTIDE_TABLE block
    node tests/sheet_bench.js             # score the frames

natives.zip (151 chains) is the same set ss_bench.py uses and is not in the
repo; put it in the repo root. Chains are split by index: even ones fit the
table, odd ones score it, so nothing is ever scored on its own training data.
"""
import argparse
import io
import json
import os
import zipfile

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_OUT = os.path.join(_ROOT, "tests", "out")
NATIVES = os.path.join(_ROOT, "natives.zip")
TRUTH = os.path.join(_OUT, "sheet_truth.json")

BACKBONE = ("N", "CA", "C", "O")
# H-bond and ladder geometry. O...N under 3.3 A is the usual generous cut; the
# C-alpha window then throws out the i,i+4 helical bonds that also pass it.
HB_MAX = 3.3
LADDER_SEQ_MIN = 4
LADDER_CA_MIN = 4.2
LADDER_CA_MAX = 6.0


def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def parse_natives():
    """-> [{name, ca, c, o, n, ladders}], residues with a full backbone only."""
    if not os.path.exists(NATIVES):
        raise SystemExit(
            f"{NATIVES} not found. It is 3.8 MB of native PDBs (the ss_bench set); "
            "put it in the repo root.")
    out = []
    with zipfile.ZipFile(NATIVES) as z:
        for name in sorted(z.namelist()):
            if not name.endswith(".pdb"):
                continue
            residues, order = {}, []
            for line in io.TextIOWrapper(z.open(name)):
                if not line.startswith("ATOM"):
                    continue
                atom = line[12:16].strip()
                if atom not in BACKBONE:
                    continue
                key = (line[21], line[22:27])
                if key not in residues:
                    residues[key] = {}
                    order.append(key)
                residues[key][atom] = (
                    float(line[30:38]), float(line[38:46]), float(line[46:54]))
            by_chain = {}
            for key in order:
                res = residues[key]
                if all(a in res for a in BACKBONE):
                    by_chain.setdefault(key[0], []).append(res)
            for chain, res in by_chain.items():
                if len(res) < 40:
                    continue
                ca = np.array([r["CA"] for r in res])
                c = np.array([r["C"] for r in res])
                o = np.array([r["O"] for r in res])
                nn = np.array([r["N"] for r in res])
                out.append(dict(
                    name=f"{os.path.basename(name)[:-4]}_{chain}",
                    ca=ca.tolist(),
                    c=c.tolist(),
                    o=o.tolist(),
                    n=nn.tolist(),
                    ladders=_ladders(ca, o, nn)))
    return out


def _ladders(ca, o, n):
    """Backbone H-bonded pairs that look like a beta ladder rung, not a turn."""
    pairs = set()
    for i in range(len(ca)):
        d = np.linalg.norm(n - o[i], axis=1)
        for j in np.flatnonzero(d < HB_MAX):
            if abs(int(j) - i) < LADDER_SEQ_MIN:
                continue
            a, b = min(i, int(j)), max(i, int(j))
            dca = np.linalg.norm(ca[a] - ca[b])
            if LADDER_CA_MIN < dca < LADDER_CA_MAX:
                pairs.add((a, b))
    return sorted(pairs)


# --- the model -------------------------------------------------------------
#
# Local frame on the peptide bond i -> i+1: u along CA(i)->CA(i+1), w normal to
# the CA(i-1),CA(i),CA(i+1) plane, v = w x u. Keys are PULCHRA's internal
# coordinates: r13 = |CA(i+1) - CA(i-1)|, and r14 = |CA(i+2) - CA(i-1)| signed
# by the chirality of the four. r13 separates helix from strand, r14 carries the
# handedness, and between them the peptide orientation is nearly determined.
# PULCHRA also bins the NEXT r13; held out it is worth 0.6 deg here, so it is
# dropped and the table stays one plane. Stored per bin: the offsets of C(i) and
# N(i+1) from CA(i) in that frame. O is not stored - the carbonyl carbon is sp2,
# so O sits in the CA-C-N plane opposite the bisector, 1.231 A out.
NB13, NB14 = 8, 25
R13_LO, R13_STEP = 4.6, 0.4
R14_LO, R14_STEP = -11.0, 0.9
CO_LENGTH = 1.231
MIN_PER_BIN = 5
CA_BOND_MIN, CA_BOND_MAX = 3.0, 4.2


def local_frames(ca):
    """-> (indices, local basis rows, r13, signed r14) for usable residues."""
    idx, frames, r13s, r14s = [], [], [], []
    for i in range(1, len(ca) - 2):
        a = ca[i + 1] - ca[i]
        length = np.linalg.norm(a)
        if not CA_BOND_MIN < length < CA_BOND_MAX:
            continue
        u = a / length
        w = np.cross(u, ca[i - 1] - ca[i])
        wl = np.linalg.norm(w)
        if wl < 1e-6:
            continue
        w = w / wl
        idx.append(i)
        frames.append(np.stack([u, np.cross(w, u), w]))
        r13s.append(np.linalg.norm(ca[i + 1] - ca[i - 1]))
        sign = np.sign(np.dot(np.cross(ca[i] - ca[i - 1], ca[i + 1] - ca[i]),
                              ca[i + 2] - ca[i + 1])) or 1.0
        r14s.append(sign * np.linalg.norm(ca[i + 2] - ca[i - 1]))
    return (np.array(idx, int), np.array(frames).reshape(-1, 3, 3),
            np.array(r13s), np.array(r14s))


def bins_of(r13, r14):
    b13 = np.clip(((r13 - R13_LO) / R13_STEP).astype(int), 0, NB13 - 1)
    b14 = np.clip(((r14 - R14_LO) / R14_STEP).astype(int), 0, NB14 - 1)
    return b13, b14


def fit(chains):
    """-> (grid, cells populated, samples). grid is [NB13, NB14, 6]: C then N."""
    local, b13, b14 = [], [], []
    for ch in chains:
        ca = np.array(ch["ca"])
        c = np.array(ch["c"])
        nn = np.array(ch["n"])
        idx, frames, r13, r14 = local_frames(ca)
        if not len(idx):
            continue
        local.append(np.concatenate([
            np.einsum("nij,nj->ni", frames, c[idx] - ca[idx]),
            np.einsum("nij,nj->ni", frames, nn[idx + 1] - ca[idx])], axis=1))
        a, b = bins_of(r13, r14)
        b13.append(a)
        b14.append(b)
    local = np.concatenate(local)
    b13 = np.concatenate(b13)
    b14 = np.concatenate(b14)
    grid = np.zeros((NB13, NB14, 6))
    count = np.zeros((NB13, NB14), int)
    np.add.at(grid, (b13, b14), local)
    np.add.at(count, (b13, b14), 1)
    filled = count >= MIN_PER_BIN
    grid[filled] /= count[filled][:, None]
    # Empty cells take their nearest filled neighbour so the renderer's lookup
    # is one index with no fallback path. r13 mismatch is weighted double: it is
    # the coarser coordinate and confusing helix with strand is the worse error.
    where = np.argwhere(filled)
    for i in range(NB13):
        for j in range(NB14):
            if filled[i, j]:
                continue
            d = np.abs(where[:, 0] - i) * 2 + np.abs(where[:, 1] - j)
            grid[i, j] = grid[tuple(where[np.argmin(d)])]
    return grid, filled.sum(), len(local)


def rebuild(ca, grid):
    """-> predicted C, O, N arrays (NaN where the frame is undefined)."""
    idx, frames, r13, r14 = local_frames(ca)
    c = np.full_like(ca, np.nan)
    o = np.full_like(ca, np.nan)
    n = np.full_like(ca, np.nan)
    if not len(idx):
        return c, o, n
    b13, b14 = bins_of(r13, r14)
    rows = grid[b13, b14]
    c[idx] = ca[idx] + np.einsum("nji,nj->ni", frames, rows[:, 0:3])
    n[idx + 1] = ca[idx] + np.einsum("nji,nj->ni", frames, rows[:, 3:6])
    # O opposite the CA-C / N-C bisector, in their plane
    bis = _unit(_unit(ca[idx] - c[idx]) + _unit(n[idx + 1] - c[idx]))
    o[idx] = c[idx] - bis * CO_LENGTH
    return c, o, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true",
                    help="parse natives.zip -> tests/out/sheet_truth.json")
    ap.add_argument("--fit", action="store_true",
                    help="fit the table and print the PEPTIDE_TABLE block")
    args = ap.parse_args()
    if not (args.build or args.fit):
        ap.print_help()
        return
    if args.build or not os.path.exists(TRUTH):
        chains = parse_natives()
        for k, ch in enumerate(chains):
            ch["split"] = "fit" if k % 2 == 0 else "score"
        os.makedirs(_OUT, exist_ok=True)
        with open(TRUTH, "w") as fh:
            json.dump(chains, fh)
        print(f"wrote {TRUTH}: {len(chains)} chains, "
              f"{sum(len(c['ca']) for c in chains)} residues, "
              f"{sum(len(c['ladders']) for c in chains)} ladder rungs")
    if args.fit:
        with open(TRUTH) as fh:
            chains = json.load(fh)
        train = [c for c in chains if c["split"] == "fit"]
        grid, nfilled, nsamples = fit(train)
        errC, errN, errCO = [], [], []
        for ch in (c for c in chains if c["split"] == "score"):
            ca = np.array(ch["ca"])
            c_pred, o_pred, n_pred = rebuild(ca, grid)
            ok = ~np.isnan(c_pred[:, 0])
            errC.append(np.linalg.norm(c_pred[ok] - np.array(ch["c"])[ok], axis=1))
            okn = ~np.isnan(n_pred[:, 0])
            errN.append(np.linalg.norm(n_pred[okn] - np.array(ch["n"])[okn], axis=1))
            oko = ~np.isnan(o_pred[:, 0])
            errCO.append(np.degrees(np.arccos(np.clip(np.sum(
                _unit(o_pred[oko] - c_pred[oko])
                * _unit(np.array(ch["o"])[oko] - np.array(ch["c"])[oko]), axis=1), -1, 1))))
        errC = np.concatenate(errC)
        errN = np.concatenate(errN)
        errCO = np.concatenate(errCO)
        print(f"fit on {len(train)} chains / {nsamples} peptides, "
              f"{nfilled} of {NB13 * NB14} cells populated")
        print(f"held out: C {np.sqrt((errC ** 2).mean()):.2f} A rms, "
              f"N {np.sqrt((errN ** 2).mean()):.2f} A rms, "
              f"C=O direction {np.median(errCO):.1f} deg median")
        print("  (node tests/ss_bench.js scores the DSSP that runs on this backbone,")
        print("   node tests/sheet_bench.js the strand frames built from it)")
        flat = np.round(grid.reshape(-1), 3)
        body = ", ".join(f"{x:g}" for x in flat)
        import textwrap
        print("\n// paste into viewer-cartoon.js as PEPTIDE_TABLE:\n")
        print("\n".join("        " + line for line in textwrap.wrap(body, 92)))


if __name__ == "__main__":
    main()
