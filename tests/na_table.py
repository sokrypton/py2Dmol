"""Fit the base-frame table the cartoon predicts nucleotide bases with.

py2Dmol keeps one atom per nucleotide, the C4'. Where a base points - the
direction from that C4' to the base ring's centroid, and the plane the ring
lies in - is what the ribbon faces along and what the base plates are drawn
from. It used to be read from the file (`base_frames`); now it is PREDICTED
from the trace, the same way the peptide backbone is (tests/sheet_bench.py):
bin the local internal coordinates, look up a direction.

    python tests/na_table.py --build   # fetch/parse -> tests/out/na_truth.json
    python tests/na_table.py --fit     # fit, score held out, print NA_BASE_TABLE
    node tests/na_bench.js             # score what the renderer actually ships

It is a WEAKER predictor than the peptide one, for a physical reason rather
than a fitting one. Held out by chain the direction lands ~17 deg median but
with a ~75 deg p90 tail, against 8.8 / 24 for the peptide. Even knowing the bin
exactly the true direction varies 21 deg around the bin mean, and clustering
inside the best-populated bins finds a tight ~10 deg majority plus a 3-25%
minority pointing 43-165 deg away: a base can sit anti or syn on an identical
backbone and the trace cannot tell which. Coverage explains the rest - residues
whose bin was well sampled score 12.6 deg, sparse ones 31-40.

That tail is why the renderer treats predicted frames differently from stored
ones: the pairing test widens to catch only gross violations, the pairing is
used to fix the sign of a base that points away from its partner, and the
ribbon's twist per residue is capped. See viewer-cartoon.js.
"""
import argparse
import json
import os
import urllib.request

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_OUT = os.path.join(_ROOT, "tests", "out")
CACHE = os.path.join(_OUT, "pdb")
TRUTH = os.path.join(_OUT, "na_truth.json")

# Duplexes, tRNAs, riboswitches, ribozymes and protein-nucleic complexes, so the
# table sees A-form, B-form and the loops between them rather than one geometry.
STRUCTURES = """
1BNA 355D 1D23 1D29 2BNA 1EN9 1D8G 157D 1ZIH 4TNA 1EHZ 2R8S 1YNE 1MME 1F7Y
2A43 1AOI 5H0R 1QC0 1DUX 3BSE 1G4Q 1KD3 1XJR 2NOK 1I9V 1NUJ 1CX0 1P79 1RNA
1FIR 1B23 2TRA 1EVV 1GID 1L2X 1MHK 1KXK 1U9S 2GIS 3IRW 3OWI 2QUS 1Y26 3D2G
1NBS 1HR2 1U6B 2OIU 1SJ3 1DDY 1E8O 1FFY 2FMT 1H4S 1QF6 1SER 1ASY 1EIY 1IL2
2DU3 1N78 1J1U 1F7U 2ZUE 3FOZ 1GAX 1QTQ 2CSX 1EFW 1WZ2 2AZX 3CUL 1S03 1VQ8
1JJ2 2QBG 1UTD 1M5O 2BTE 1ZBI 1ZBH 1I6U 1MFQ 2FDT 1YFG 6TNA 1TN2 1TRA 3TRA
""".split()

PURINES = {"DA", "DG", "A", "G", "RA", "RG", "I", "DI"}
PURINE_RING = ["N9", "C8", "N7", "C5", "C6", "N1", "C2", "N3", "C4"]
PYRIMIDINE_RING = ["N1", "C2", "N3", "C4", "C5", "C6"]

# The bins the renderer reads (NA_NB13 / NA_NB14 in viewer-cartoon.js). Coarse
# on purpose: finer bins were swept and land within 0.5 deg of these, because
# the limit is the spread inside a bin, not the bin size.
NB13, NB14 = 8, 10
LO13, ST13 = 4.5, 1.0
LO14, ST14 = -20.0, 4.0
MIN_PER_BIN = 5
# A C4'-C4' step along the backbone; anything else is a chain break.
STEP_MIN, STEP_MAX = 4.5, 7.5


def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def fetch(pdb):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{pdb}.cif")
    if not os.path.exists(path):
        urllib.request.urlretrieve(f"https://files.rcsb.org/download/{pdb}.cif", path)
    return path


def parse(pdb):
    """-> [{name, c4, dirs, norms, pur, kinds}] per chain with >= 8 nucleotides."""
    import gemmi
    try:
        st = gemmi.read_structure(fetch(pdb))
    except Exception as exc:                      # network or parse failure
        print(f"  skip {pdb}: {exc}")
        return []
    st.setup_entities()
    out = []
    for chain in st[0]:
        c4, dirs, norms, pur, kinds = [], [], [], [], []
        for res in chain:
            info = gemmi.find_tabulated_residue(res.name)
            name = res.name.strip().upper()
            # structural test as well as the dictionary: modified nucleotides
            # (PSU, 5MC, OMG ...) are tabulated but not flagged nucleic
            is_na = info.is_nucleic_acid() or all(
                a in res for a in ("C4'", "O4'", "C1'"))
            if not is_na or "C4'" not in res:
                continue
            ring = PURINE_RING if name in PURINES else PYRIMIDINE_RING
            pts = [res[a][0].pos.tolist() for a in ring if a in res]
            if len(pts) < 5:                      # incomplete base
                continue
            arr = np.array(pts)
            centre = arr.mean(axis=0)
            normal = np.linalg.svd(arr - centre)[2][2]
            q = np.array(res["C4'"][0].pos.tolist())
            c4.append(q.tolist())
            dirs.append((centre - q).tolist())
            norms.append(normal.tolist())
            pur.append(1 if name in PURINES else 0)
            # the 2'-OH is what separates ribose from deoxyribose
            kinds.append("D" if (name.startswith("D") or "O2'" not in res) else "R")
        if len(c4) >= 8:
            out.append(dict(name=f"{pdb}_{chain.name}", c4=c4, dirs=dirs,
                            norms=norms, pur=pur, kinds=kinds))
    return out


def local_frames(c4):
    """-> (indices, basis rows, r13, signed r14) for residues with a full window.

    The frame is built on the step to the next residue: u along C4'(i)->C4'(i+1),
    w normal to the C4'(i-1),C4'(i),C4'(i+1) plane, v = w x u. Keys are the two
    internal coordinates PULCHRA bins on, r13 and a chirality-signed r14.
    """
    idx, frames, r13s, r14s = [], [], [], []
    for i in range(1, len(c4) - 2):
        a = c4[i + 1] - c4[i]
        step = np.linalg.norm(a)
        if not STEP_MIN < step < STEP_MAX:
            continue
        u = a / step
        w = np.cross(u, c4[i - 1] - c4[i])
        wl = np.linalg.norm(w)
        if wl < 1e-6:
            continue
        w = w / wl
        idx.append(i)
        frames.append(np.stack([u, np.cross(w, u), w]))
        r13s.append(np.linalg.norm(c4[i + 1] - c4[i - 1]))
        sign = np.sign(np.dot(np.cross(c4[i] - c4[i - 1], c4[i + 1] - c4[i]),
                              c4[i + 2] - c4[i + 1])) or 1.0
        r14s.append(sign * np.linalg.norm(c4[i + 2] - c4[i - 1]))
    return (np.array(idx, int), np.array(frames).reshape(-1, 3, 3),
            np.array(r13s), np.array(r14s))


def bins_of(r13, r14):
    b13 = np.clip(((r13 - LO13) / ST13).astype(int), 0, NB13 - 1)
    b14 = np.clip(((r14 - LO14) / ST14).astype(int), 0, NB14 - 1)
    return b13, b14


def fit(chains):
    """-> (grid[2, NB13, NB14, 6], cells populated, samples). DNA plane first."""
    grid = np.zeros((2, NB13, NB14, 6))
    count = np.zeros((2, NB13, NB14), int)
    samples = 0
    for ch in chains:
        c4 = np.array(ch["c4"])
        dirs = _unit(np.array(ch["dirs"]))
        norms = _unit(np.array(ch["norms"]))
        idx, frames, r13, r14 = local_frames(c4)
        if not len(idx):
            continue
        b13, b14 = bins_of(r13, r14)
        for k, i in enumerate(idx):
            plane = 0 if ch["kinds"][i] == "D" else 1
            cell = grid[plane, b13[k], b14[k]]
            local_dir = frames[k] @ dirs[i]
            local_nrm = frames[k] @ norms[i]
            # the ring normal's sign is arbitrary - align before averaging or
            # the two halves of a bin cancel
            if count[plane, b13[k], b14[k]] and np.dot(local_nrm, cell[3:6]) < 0:
                local_nrm = -local_nrm
            cell[0:3] += local_dir
            cell[3:6] += local_nrm
            count[plane, b13[k], b14[k]] += 1
            samples += 1
    filled = count >= MIN_PER_BIN
    for plane in range(2):
        where = np.argwhere(filled[plane])
        for i in range(NB13):
            for j in range(NB14):
                if filled[plane, i, j]:
                    grid[plane, i, j, 0:3] = _unit(grid[plane, i, j, 0:3])
                    grid[plane, i, j, 3:6] = _unit(grid[plane, i, j, 3:6])
                elif len(where):
                    # empty cells take their nearest filled neighbour, so the
                    # renderer's lookup is one index with no fallback path
                    d = np.abs(where[:, 0] - i) + np.abs(where[:, 1] - j)
                    grid[plane, i, j] = grid[plane, where[np.argmin(d)][0],
                                             where[np.argmin(d)][1]]
    return grid, int(filled.sum()), samples


def score(chains, grid):
    """-> (direction errors, normal errors) in degrees, over whole chains."""
    ed, en = [], []
    for ch in chains:
        c4 = np.array(ch["c4"])
        dirs = _unit(np.array(ch["dirs"]))
        norms = _unit(np.array(ch["norms"]))
        idx, frames, r13, r14 = local_frames(c4)
        if not len(idx):
            continue
        b13, b14 = bins_of(r13, r14)
        for k, i in enumerate(idx):
            plane = 0 if ch["kinds"][i] == "D" else 1
            row = grid[plane, b13[k], b14[k]]
            pd = _unit(frames[k].T @ row[0:3])
            pn = _unit(frames[k].T @ row[3:6])
            ed.append(np.degrees(np.arccos(np.clip(np.dot(pd, dirs[i]), -1, 1))))
            cos = abs(float(np.dot(pn, norms[i])))
            en.append(np.degrees(np.arccos(np.clip(cos, 0, 1))))
    return np.array(ed), np.array(en)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true",
                    help="fetch and parse the structure set -> tests/out/na_truth.json")
    ap.add_argument("--fit", action="store_true",
                    help="fit the table, score it held out, print NA_BASE_TABLE")
    args = ap.parse_args()
    if not (args.build or args.fit):
        ap.print_help()
        return
    if args.build or not os.path.exists(TRUTH):
        chains = []
        for pdb in STRUCTURES:
            chains.extend(parse(pdb))
        os.makedirs(_OUT, exist_ok=True)
        with open(TRUTH, "w") as fh:
            json.dump(chains, fh)
        print(f"wrote {TRUTH}: {len(chains)} chains, "
              f"{sum(len(c['c4']) for c in chains)} nucleotides")
    if args.fit:
        with open(TRUTH) as fh:
            chains = json.load(fh)
        # split by chain, so nothing is scored on its own training data
        rng = np.random.default_rng(0)
        order = rng.permutation(len(chains))
        train = [chains[i] for i in order[:len(chains) // 2]]
        held = [chains[i] for i in order[len(chains) // 2:]]
        grid, cells, samples = fit(train)
        ed, en = score(held, grid)
        print(f"fit on {len(train)} chains / {samples} nucleotides, "
              f"{cells} of {2 * NB13 * NB14} cells populated")
        print(f"held out  direction: median {np.median(ed):5.1f} deg  "
              f"p90 {np.percentile(ed, 90):5.1f}")
        print(f"held out  normal   : median {np.median(en):5.1f} deg  "
              f"p90 {np.percentile(en, 90):5.1f}")
        print("  (node tests/na_bench.js scores the predictor the renderer ships)")
        import textwrap
        body = ", ".join(f"{x:g}" for x in np.round(grid.reshape(-1), 3))
        print("\n// paste into viewer-cartoon.js as NA_BASE_TABLE:\n")
        print("\n".join("        " + line for line in textwrap.wrap(body, 92)))


if __name__ == "__main__":
    main()
