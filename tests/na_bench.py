"""Benchmark: does the nucleic backbone's ribbon face point at the BASE?

The renderer only keeps one C4' per nucleotide, so the backbone frame is derived
rather than read. This scores that derivation against the real thing, using
full-atom structures the viewer never sees.

Metric (lower is better)
    angle( ribbon face normal , C4' -> base centroid )
The base centroid comes from the ring atoms, so it is the direction the base
actually points - which is what the ribbon face should face along.

Also reported, for context:
    facing%   fraction of pairs whose face normal has a positive dot with the
              direction to the partner's C4' - the older, weaker metric: it only
              checks a sign, so it can read 100% while every face is 30 deg off.

The frame construction here MIRRORS viewer-cartoon.js (parallel transport of a
pair-seeded side vector, with damped rotational tracking). It is a replica, not
the renderer itself - see --check, which reprints the facing numbers so they can
be compared against the browser measurements.

    python tests/na_bench.py [--track 0.5] [--check]
"""
import argparse
import os
import urllib.request
import numpy as np
import gemmi

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "pdb")
STRUCTURES = [
    ("1BNA", "B-DNA dodecamer"),
    ("355D", "B-DNA dodecamer"),
    ("1YNE", "RNA hairpin"),
    ("1EHZ", "tRNA-Phe"),
    ("2R8S", "RNA, tertiary"),
]
PUR = {"DA", "DG", "A", "G", "RA", "RG"}
PURINE = ["N9", "C8", "N7", "C5", "C6", "N1", "C2", "N3", "C4"]
PYRIM = ["N1", "C2", "N3", "C4", "C5", "C6"]
MODBASE = {
    'PSU': 'U', 'H2U': 'U', '4SU': 'U', '5MU': 'U', 'UR3': 'U', '2MU': 'U',
    '5MC': 'C', 'OMC': 'C', '4OC': 'C', '5IC': 'C',
    '1MA': 'A', '2MA': 'A', '6MA': 'A', 'MIA': 'A',
    '2MG': 'G', 'M2G': 'G', '7MG': 'G', 'OMG': 'G', '1MG': 'G', 'YYG': 'G', 'YG': 'G',
    'OMU': 'U', '5MB': 'C',
}
# Base direction fitted in the LOCAL (T, N=curvature, B=TxN) frame - see the
# earlier study: it predicts the true base direction to a median of 8-18 deg,
# where the partner's C4' is ~40 deg off it.
DIR_D = np.array([0.012, 0.954, 0.299])   # DNA, local-curvature frame
DIR_R = np.array([0.051, 0.783, -0.620])  # RNA, local-curvature frame
# Same fit in the HYBRID frame (local tangent, but the second axis is the radial
# toward the helix axis instead of the raw curvature). Measured far tighter:
# 8.3 deg median vs 17.6 for DNA.
HDIR_D = np.array([0.024, 0.679, 0.734])
HDIR_R = np.array([0.071, 0.914, 0.400])
AXIS_WIN = 3
PMIN, PMAX, PIDEAL, SEQGAP, STACKW = 12.5, 16.5, 14.6, 3, 1.2
BASE_SEP_MAX, COPLANAR_MIN, RUN_W = 6.8, 0.7, 0.6
RISE_MIN, RISE_MAX, AXIS_OFF, GROW_ROUNDS = 2.5, 5.4, 2.6, 4


def fetch(pdb):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{pdb}.cif")
    if not os.path.exists(path):
        urllib.request.urlretrieve(f"https://files.rcsb.org/download/{pdb}.cif", path)
    return path


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else None


def base_of(nm):
    s = nm.strip().upper()
    if len(s) == 1:
        return s
    if len(s) == 2 and s[0] in "DR":
        return s[1]
    return MODBASE.get(s, "")


def comp(a, b):
    return ((a == "A" and b in "TU") or (b == "A" and a in "TU")
            or (a == "G" and b == "C") or (a == "C" and b == "G"))


def load(pdb):
    """Parse as viewer.py does (C4' per nucleotide, modified residues included),
    and additionally keep the true base centroid for scoring."""
    st = gemmi.read_structure(fetch(pdb))
    st.remove_alternative_conformations()
    st.remove_hydrogens()
    res = []
    for ch in st[0]:
        for r in ch:
            info = gemmi.find_tabulated_residue(r.name)
            isna = bool(info and info.is_nucleic_acid())
            has = lambda *n: any(x in r for x in n)
            if not isna and not (info and info.is_amino_acid()):
                if has("C4'", "C4*") and has("O4'", "O4*") and has("C1'", "C1*"):
                    isna = True
            if not isna or not has("C4'", "C4*"):
                continue
            nm = r.name.strip()
            ring = PURINE if (nm in PUR or base_of(nm) in "AG") else PYRIM
            cen = nrm = None
            pts = [r[a][0].pos.tolist() for a in ring if a in r]
            if len(pts) >= 5:
                A = np.array(pts)
                cen = A.mean(axis=0)
                _, _, vt = np.linalg.svd(A - cen)
                nrm = vt[2]
            res.append({"name": nm, "num": r.seqid.num,
                        "c4": np.array(r["C4'"][0].pos.tolist()),
                        "cen": cen, "nrm": nrm})
    return res


def pair_up(res):
    """Same two passes as the renderer: WC-only greedy with stacking support,
    then grow confirmed stems (wobble allowed there)."""
    m = len(res)
    P = np.array([x["c4"] for x in res])
    D = np.linalg.norm(P[:, None, :] - P[None, :, :], axis=2)
    run = np.zeros(m, dtype=int)
    for i in range(1, m):
        run[i] = run[i - 1] + (0 if D[i - 1, i] <= 7.5 else 1)
    cand = {}
    for a in range(m):
        ba = base_of(res[a]["name"])
        if not ba:
            continue
        for b in range(a + 1, m):
            if run[a] == run[b] and b - a <= SEQGAP:
                continue
            if not comp(ba, base_of(res[b]["name"])):
                continue
            if not (PMIN <= D[a, b] <= PMAX):
                continue
            score = abs(D[a, b] - PIDEAL)
            # real base geometry when the file gave it to us - see viewer-cartoon.js
            if res[a]["cen"] is not None and res[b]["cen"] is not None:
                sep = float(np.linalg.norm(res[a]["cen"] - res[b]["cen"]))
                if sep > BASE_SEP_MAX:
                    continue
                if abs(float(res[a]["nrm"] @ res[b]["nrm"])) < COPLANAR_MIN:
                    continue
                score = sep
            cand[(a, b)] = score
    # Register RUN LENGTH, not immediate support: adjacent pairs in a stack
    # share i+j, so a shifted register is internally just as consistent as the
    # true one and only length separates them.
    scored = []
    for (a, b), s in cand.items():
        run_len = 1
        for da, db in ((1, -1), (-1, 1)):
            c, d = a + da, b + db
            while (min(c, d), max(c, d)) in cand:
                run_len += 1
                c += da
                d += db
        if run_len < 2:
            continue
        scored.append((s - RUN_W * run_len, a, b))
    scored.sort()
    pair = np.full(m, -1, dtype=int)
    for _, a, b in scored:
        if pair[a] < 0 and pair[b] < 0:
            pair[a] = b
            pair[b] = a
    mid = lambda i: (P[i] + P[pair[i]]) / 2 if 0 <= i < m and pair[i] >= 0 else None
    wob = lambda x, y: (x == "G" and y in "UT") or (y == "G" and x in "UT")
    for _ in range(GROW_ROUNDS):
        add = []
        for a in range(m):
            b = pair[a]
            if b < 0 or b < a:
                continue
            for da, db in ((1, -1), (-1, 1)):
                c, d = a + da, b + db
                if not (0 <= c < m and 0 <= d < m) or pair[c] >= 0 or pair[d] >= 0:
                    continue
                if run[c] == run[d] and abs(d - c) <= SEQGAP:
                    continue
                bc, bd = base_of(res[c]["name"]), base_of(res[d]["name"])
                if not bc or not bd or not (comp(bc, bd) or wob(bc, bd)):
                    continue
                if not (PMIN <= D[c, d] <= PMAX):
                    continue
                M0, M1 = (P[a] + P[b]) / 2, (P[c] + P[d]) / 2
                if not (RISE_MIN <= np.linalg.norm(M1 - M0) <= RISE_MAX):
                    continue
                pv = pair[a - da] if 0 <= a - da < m else -1
                if pv >= 0:
                    Mp = (P[a - da] + P[pv]) / 2
                    ax = unit(M0 - Mp)
                    if ax is not None:
                        v = M1 - M0
                        if np.linalg.norm(v - ax * float(v @ ax)) > AXIS_OFF:
                            continue
                add.append((min(c, d), max(c, d)))
        if not add:
            break
        for c, d in add:
            if pair[c] < 0 and pair[d] < 0:
                pair[c] = d
                pair[d] = c
    return pair, P, run


def helix_axis_pt(P, pair, i, win=AXIS_WIN):
    """Axis direction AND a point on it, from a window of pair midpoints. The
    point lets an UNPAIRED residue use the same frame: its radial is then the
    perpendicular from its C4' to the axis line, rather than to its own
    (nonexistent) pair midpoint."""
    pts = []
    for d in range(-win, win + 1):
        k = i + d
        if 0 <= k < len(P) and pair[k] >= 0:
            pts.append((P[k] + P[pair[k]]) / 2)
    if len(pts) < 2:
        return None, None
    A = np.array(pts)
    c = A.mean(axis=0)
    _, _, vt = np.linalg.svd(A - c)
    return unit(vt[0]), c


def helix_axis(P, pair, i, win=AXIS_WIN):
    """Least-squares line through a window of pair midpoints. A pair's midpoint
    does NOT lie on the axis, so two of them are not enough - see na_bench notes."""
    pts = []
    for d in range(-win, win + 1):
        k = i + d
        if 0 <= k < len(P) and pair[k] >= 0:
            pts.append((P[k] + P[pair[k]]) / 2)
    if len(pts) < 2:
        return None
    A = np.array(pts)
    _, _, vt = np.linalg.svd(A - A.mean(axis=0))
    return unit(vt[0])


def base_dir_hybrid(res, P, pair, run, i, wide=AXIS_WIN):
    """Predicted base direction in the hybrid frame: local tangent, second axis
    the radial toward the least-squares helix axis. Works for UNPAIRED residues
    too, by taking the perpendicular to the axis LINE."""
    m = len(P)
    a = i - 1 if i > 0 and run[i - 1] == run[i] else i
    b = i + 1 if i + 1 < m and run[i + 1] == run[i] else i
    if a == b:
        return None
    T = unit(P[b] - P[a])
    ax, apt = helix_axis_pt(P, pair, i, wide)
    if T is None or ax is None:
        return None
    if pair[i] < 0:
        # UNPAIRED: do NOT borrow a nearby stem's axis. Tried both a +/-3 and a
        # +/-6 window; both are worse than the local-curvature fit (median 17.2
        # and 23.2 vs 15.5), because a loop base does not point at the stem's
        # axis. Fall back instead - the renderer does the same.
        return None
    rad = (P[i] + P[pair[i]]) / 2 - P[i]
    rad = rad - ax * float(rad @ ax)
    N = unit(rad - T * float(rad @ T))
    if N is None:
        return None
    B = np.cross(T, N)
    nm = res[i]["name"]
    co = HDIR_D if (nm.startswith("D") or nm == "T") else HDIR_R
    return unit(T * co[0] + N * co[1] + B * co[2])


def base_dir(res, P, run, i):
    """Predicted C4'->base direction from the local curvature frame."""
    m = len(P)
    a = i - 1 if i > 0 and run[i - 1] == run[i] else i
    b = i + 1 if i + 1 < m and run[i + 1] == run[i] else i
    if a == b:
        return None
    T = unit(P[b] - P[a])
    if T is None:
        return None
    c = P[a] - 2 * P[i] + P[b]
    c = c - T * float(c @ T)
    N = unit(c)
    if N is None:
        return None
    B = np.cross(T, N)
    nm = res[i]["name"]
    co = DIR_D if (nm.startswith("D") or nm == "T") else DIR_R
    return unit(T * co[0] + N * co[1] + B * co[2])


def frames(res, pair, P, run, track, target="partner"):
    """Parallel transport with damped rotational tracking - mirrors the JS."""
    m = len(res)
    tang = np.zeros((m, 3))
    for i in range(m):
        a = i - 1 if i > 0 and run[i - 1] == run[i] else i
        b = i + 1 if i + 1 < m and run[i + 1] == run[i] else i
        t = unit(P[b] - P[a]) if b != a else None
        if t is not None:
            tang[i] = t
    side = np.zeros((m, 3))
    for lo in sorted(set(run)):
        idx = [i for i in range(m) if run[i] == lo and np.any(tang[i])]
        s = None
        prevT = None
        for i in idx:
            tv = tang[i]
            want = None
            if target in ("hybrid", "hybrid+wide"):
                w = AXIS_WIN if target == "hybrid" else 6
                want = base_dir_hybrid(res, P, pair, run, i, w)
                if want is None:
                    want = base_dir(res, P, run, i)   # no axis at all
            elif target in ("base", "base+sign"):
                want = base_dir(res, P, run, i)
                if want is not None and target == "base+sign" and pair[i] >= 0:
                    # the fitted direction has no reliable sign of its own, so
                    # take it from the partner: the base points across the pair,
                    # never away from it
                    pv = P[pair[i]] - P[i]
                    if float(want @ pv) < 0:
                        want = -want
            elif pair[i] >= 0:
                want = P[pair[i]] - P[i]
            if want is not None:
                want = unit(want - tv * float(want @ tv))
            if s is None:
                if want is not None:
                    s = unit(np.cross(want, tv))       # face normal -> target
                if s is None:
                    s = unit(np.cross(tv, np.array([0, 0, 1.0])))
                    if s is None:
                        s = unit(np.cross(tv, np.array([1.0, 0, 0])))
                    if s is None:
                        continue
            elif prevT is not None:
                ax = np.cross(prevT, tv)
                sn = np.linalg.norm(ax)
                if sn > 1e-9:
                    u = ax / sn
                    ang = np.arctan2(sn, float(prevT @ tv))
                    ca, sa = np.cos(ang), np.sin(ang)
                    s = s * ca + np.cross(u, s) * sa + u * float(u @ s) * (1 - ca)
                so = unit(s - tv * float(s @ tv))
                if so is not None:
                    s = so
            if track > 0 and want is not None:
                if True:
                    g = unit(np.cross(want, tv))
                    if g is not None:
                        cosA = float(np.clip(s @ g, -1, 1))
                        sinA = float(np.cross(s, g) @ tv)
                        ang = np.arctan2(sinA, cosA) * track
                        ca, sa = np.cos(ang), np.sin(ang)
                        s = s * ca + np.cross(tv, s) * sa + tv * float(tv @ s) * (1 - ca)
                        so2 = unit(s - tv * float(s @ tv))
                        if so2 is not None:
                            s = so2
            side[i] = s
            prevT = tv
    return tang, side


def score(track, target="partner", verbose=True):
    tot_err, tot_face, tot_n = [], 0, 0
    if verbose:
        print(f"{'structure':22s} {'n':>4s} {'face->base err (deg)':>26s} {'facing':>8s}")
        print("-" * 64)
    for pdb, label in STRUCTURES:
        res = load(pdb)
        if len(res) < 4:
            continue
        pair, P, run = pair_up(res)
        tang, side = frames(res, pair, P, run, track, target)
        errs, face_ok, face_n = [], 0, 0
        for i in range(len(res)):
            if not np.any(side[i]) or res[i]["cen"] is None:
                continue
            n = unit(np.cross(tang[i], side[i]))
            if n is None:
                continue
            truth = unit(res[i]["cen"] - P[i])
            if truth is not None:
                errs.append(np.degrees(np.arccos(np.clip(float(n @ truth), -1, 1))))
            if pair[i] >= 0:
                d = unit(P[pair[i]] - P[i])
                if d is not None:
                    face_n += 1
                    face_ok += float(n @ d) > 0
        if not errs:
            continue
        tot_err += errs
        tot_face += face_ok
        tot_n += face_n
        if verbose:
            e = np.array(errs)
            print(f"{pdb + ' ' + label:22.22s} {len(e):4d} "
                  f"mean {e.mean():5.1f} med {np.median(e):5.1f} p90 {np.percentile(e,90):5.1f} "
                  f"{face_ok/max(1,face_n):7.0%}")
    e = np.array(tot_err)
    if verbose:
        print("-" * 64)
        print(f"{'OVERALL':22s} {len(e):4d} mean {e.mean():5.1f} med {np.median(e):5.1f} "
              f"p90 {np.percentile(e,90):5.1f} {tot_face/max(1,tot_n):7.0%}")
    return e.mean(), np.median(e), tot_face / max(1, tot_n)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", type=float, default=0.5)
    ap.add_argument("--sweep", action="store_true", help="score across tracking gains")
    ap.add_argument("--target",
                    choices=("partner", "base", "base+sign", "hybrid", "hybrid+wide"),
                    default="partner")
    args = ap.parse_args()
    if args.sweep:
        print(f"{'track':>6s} {'mean':>7s} {'median':>7s} {'facing':>8s}")
        for g in (0, 0.25, 0.5, 0.75, 1.0):
            mean, med, fac = score(g, args.target, verbose=False)
            print(f"{g:6.2f} {mean:7.1f} {med:7.1f} {fac:8.0%}")
    else:
        print(f"tracking gain = {args.track}   target = {args.target}\n")
        score(args.track, args.target)
