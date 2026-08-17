"""Can an sp3 (tetrahedral) junction be mitred the way a planar one is?

    python tests/junction_sp3.py

The renderer mitres a junction by clipping each leg against the plane that
bisects it and each neighbour, then filling the hole the legs leave with one
polygon at each end. That construction is live for 3-way centres and for 4-way
centres whose legs stand around a common axis; a tetrahedral centre falls
through to plain overlap.

The question here is WHY, and whether the same idea reaches it. Everything is
checked numerically. Nothing in this file draws.

The construction, stated once:

    ax            an axis. Each leg's section is rolled so that its u axis is
                  ax rejected onto the plane across the leg, which is what lets
                  two neighbours meet corner to corner instead of edge to edge.
    order         legs are walked in ANGULAR order about ax, and each
                  consecutive pair shares two corners (one at +u, one at -u).
    clip          corner c of leg i is pushed out along d_i until it is on its
                  own side of every bisector plane it faces.
    fill          the n shared +u corners make one polygon, the n shared -u
                  corners the other.

So the construction needs a cyclic order of the legs about an axis. That is a
two-dimensional assumption, and it is the thing a tetrahedral centre has to
satisfy - not the mitre itself.
"""
import math
from collections import Counter
from itertools import combinations

import numpy as np

MARGIN = 1e-3     # how far a section must clear any foreign corner (A)
W = 0.25          # section half-width  (stickHW in the renderer)
T = 0.25          # section half-thickness at the square default (stickHT)


# --- vectors ---------------------------------------------------------------
def unit(a):
    a = np.asarray(a, float)
    n = np.linalg.norm(a)
    return a / n if n > 1e-12 else None


def rej(a, d):
    """a with its component along unit d removed."""
    return np.asarray(a, float) - np.dot(a, d) * np.asarray(d, float)


# ---------------------------------------------------------------------------
# THE CASES
# ---------------------------------------------------------------------------
def ideal_tetra():
    return [unit(v) for v in [(1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1)]]


def planar3():
    return [unit(v) for v in [(1, 0, 0), (-0.5, math.sqrt(3) / 2, 0),
                              (-0.5, -math.sqrt(3) / 2, 0)]]


def planar4():
    return [unit(v) for v in [(1, 0, 0), (0, 1, 0), (-1, 0, 0), (0, -1, 0)]]


def sp3_three():
    """an sp3 carbon with one leg dropped - VAL CB, ILE CB, a ribose carbon"""
    t = ideal_tetra()
    return t[:3]


# GDP out of 12KZ: the two phosphates are the real 4-way sp3 centres.
GDP_XYZ = np.array([
    [-0.985, -4.405, -3.571],   # 0  PB
    [-1.379, -5.427, -2.547],   # 1  O1B
    [0.331, -4.668, -4.234],    # 2  O2B
    [-2.073, -4.087, -4.555],   # 3  O3B
    [-0.769, -3.055, -2.736],   # 4  O3A
    [0.302, -1.904, -2.988],    # 5  PA
    [1.617, -2.339, -2.428],    # 6  O1A
    [0.200, -1.449, -4.416],    # 7  O2A
    [-0.232, -0.747, -2.022],   # 8  O5'
    [-1.510, -0.186, -2.253],   # 9  C5'
    [-1.562, 1.207, -1.654],    # 10 C4'
    [-1.482, 1.123, -0.235],    # 11 O4'
    [-0.392, 2.059, -2.098],    # 12 C3'
    [-0.878, 3.392, -2.232],    # 13 O3'
    [0.572, 1.996, -0.935],     # 14 C2'
    [1.374, 3.170, -0.802],     # 15 O2'
    [-0.366, 1.857, 0.243],     # 16 C1'
])


def gdp_centre(at, nbrs):
    return [unit(GDP_XYZ[j] - GDP_XYZ[at]) for j in nbrs]


CASES = [
    ("planar 3-way (ideal)", planar3()),
    ("planar 4-way (ideal)", planar4()),
    ("sp3 3-way (one leg dropped)", sp3_three()),
    ("TETRAHEDRAL (ideal sp3)", ideal_tetra()),
    ("GDP PB  (phosphate, 4 legs)", gdp_centre(0, [1, 2, 3, 4])),
    ("GDP PA  (phosphate, 4 legs)", gdp_centre(5, [4, 6, 7, 8])),
    ("GDP C4' (ribose, 3 legs)", gdp_centre(10, [9, 11, 12])),
    ("GDP C3' (ribose, 3 legs)", gdp_centre(12, [10, 13, 14])),
]


# ---------------------------------------------------------------------------
# STAGE 1 - what the SHIPPED rule picks, and why a tetrahedron falls through
# ---------------------------------------------------------------------------
def shipped_axis(dirs):
    """plane normal if the legs lie near one, else the apex. Returns (ax, why)."""
    n = np.zeros(3)
    for a, b in combinations(dirs, 2):
        c = np.cross(a, b)
        if np.dot(n, c) < 0:
            c = -c
        n = n + c
    if np.linalg.norm(n) > 1e-6:
        n3 = unit(n)
        tilt = max(abs(np.dot(d, n3)) for d in dirs)
        if tilt < 0.50:
            return n3, "plane"
    s = sum(dirs)
    if np.linalg.norm(s) > 0.2:
        return unit(s), "apex"
    return None, "none"


def stage1():
    print("=" * 74)
    print("STAGE 1 - the shipped axis rule, and the tilt each case comes out at")
    print("=" * 74)
    print("tilt = max |d . ax|: 0 means every leg is perpendicular to the axis,")
    print("i.e. they stand around it. The mitre needs that to order them.")
    print(f"  {'case':<30} {'axis from':<7} {'tilt':>6}  {'shipped':>8}")
    for name, dirs in CASES:
        ax, why = shipped_axis(dirs)
        if ax is None:
            print(f"  {name:<30} {'-':<7} {'-':>6}  {'overlap':>8}")
            continue
        tilt = max(abs(np.dot(d, ax)) for d in dirs)
        # the shipped gate: >3 legs must also stand around the axis
        ok = (len(dirs) <= 3) or (tilt <= 0.50)
        print(f"  {name:<30} {why:<7} {tilt:>6.3f}  "
              f"{'MITRE' if ok else 'overlap':>8}")
    print()
    print("  An ideal tetrahedron sums to ZERO, so it has no apex and no plane:")
    s = np.linalg.norm(sum(ideal_tetra()))
    print(f"    |sum(dirs)| = {s:.2e}  -> the axis rule returns nothing at all.")
    print("  A real phosphate is not quite ideal, so it DOES find an apex - and")
    print("  that apex is the worst possible axis, with the legs bunched around")
    print("  it rather than standing around it. That is what the tilt gate")
    print("  catches. The gate is right; the axis it was handed is wrong.")
    print()


# ---------------------------------------------------------------------------
# STAGE 2 - the axis the legs actually stand around
# ---------------------------------------------------------------------------
# The mitre wants the legs as close to PERPENDICULAR to the axis as it can get
# them, because that is what makes their angular order meaningful. So the axis
# to pick is the one minimising the worst |d . a| - a min-max problem on the
# sphere, not a sum of anything.
def equatorial_axis(dirs, refine=3):
    """argmin over unit a of max_i |d_i . a|, by grid then local refinement."""
    best, bestf = None, 1e9

    def f(a):
        return max(abs(np.dot(d, a)) for d in dirs)

    # coarse spherical grid (Fibonacci) - the objective is not convex
    N = 4000
    i = np.arange(N) + 0.5
    phi = np.arccos(1 - 2 * i / N)
    tha = math.pi * (1 + 5 ** 0.5) * i
    grid = np.stack([np.cos(tha) * np.sin(phi),
                     np.sin(tha) * np.sin(phi), np.cos(phi)], axis=1)
    for a in grid:
        v = f(a)
        if v < bestf:
            bestf, best = v, a
    # refine: random small perturbations, shrinking
    step = 0.2
    rng = np.random.default_rng(0)
    for _ in range(refine):
        for _ in range(3000):
            a = unit(best + step * rng.normal(size=3))
            v = f(a)
            if v < bestf:
                bestf, best = v, a
        step *= 0.25
    return unit(best), bestf


def stage2():
    print("=" * 74)
    print("STAGE 2 - the most EQUATORIAL axis: argmin max |d . a|")
    print("=" * 74)
    print(f"  {'case':<30} {'shipped':>8} {'best':>8}   what the best axis is")
    for name, dirs in CASES:
        ax, why = shipped_axis(dirs)
        t_ship = max(abs(np.dot(d, ax)) for d in dirs) if ax is not None else float('nan')
        bax, t_best = equatorial_axis(dirs)
        note = ""
        if len(dirs) == 4 and t_best < 0.60:
            # is it the S4 axis of the tetrahedron? two legs up, two down
            ups = sum(1 for d in dirs if np.dot(d, bax) > 0)
            note = f"S4-like ({ups} up / {len(dirs)-ups} down)"
        elif t_best < 1e-3:
            note = "the legs' own plane"
        print(f"  {name:<30} {t_ship:>8.3f} {t_best:>8.3f}   {note}")
    print()
    print("  A regular tetrahedron has three S4 axes, and along each one the")
    print("  four legs project to a SQUARE - two above the equator, two below.")
    print(f"  The tilt there is exactly 1/sqrt(3) = {1/math.sqrt(3):.4f}, which is")
    print("  the best any axis can do. So a tetrahedral centre DOES have a")
    print("  usable cyclic order; the shipped rule simply never looks for it,")
    print("  and the 0.50 gate would reject it by 0.077 even if it did.")
    print()


# ---------------------------------------------------------------------------
# STAGE 3 - build the mitre on a given axis, and check it closes
# ---------------------------------------------------------------------------
def build_mitre(dirs, ax):
    """The renderer's construction. Returns (legs, shareTop, shareBot, info)."""
    n = len(dirs)
    # roll each section so u is ax across the leg
    u, v = [], []
    for d in dirs:
        ui = unit(rej(ax, d))
        if ui is None:
            return None
        u.append(ui)
        v.append(np.cross(d, ui))
    # angular order about ax
    e1 = unit(rej(dirs[0], ax))
    e2 = np.cross(ax, e1)
    ang = []
    for i, d in enumerate(dirs):
        p = rej(d, ax)
        if np.linalg.norm(p) < 1e-9:
            return None                      # a leg ALONG the axis has no angle
        ang.append((math.atan2(np.dot(p, e2), np.dot(p, e1)), i))
    ang.sort()
    order = [i for _, i in ang]

    # corner offsets, in the cycle (+u+v, +u-v, -u-v, -u+v)
    signs = [(+1, +1), (+1, -1), (-1, -1), (-1, +1)]
    corner = {}
    setback = {}
    for i in range(n):
        cs = []
        for (su, sv) in signs:
            off = su * T * u[i] + sv * W * v[i]
            s = 0.0
            for j in range(n):
                if j == i:
                    continue
                m = dirs[i] - dirs[j]
                den = np.dot(dirs[i], m)
                if den <= 1e-9:
                    continue
                s = max(s, -np.dot(off, m) / den)
            cs.append(s * dirs[i] + off)
            setback[(i, len(cs) - 1)] = s
        corner[i] = cs

    # snap the corners each ANGULARLY ADJACENT pair shares
    # leg a's (+u,-v)=1 and (-u,-v)=2 meet leg b's (+u,+v)=0 and (-u,+v)=3
    gaps = []
    for k in range(n):
        a, b = order[k], order[(k + 1) % n]
        for (ia, ib) in ((1, 0), (2, 3)):
            pa, pb = corner[a][ia], corner[b][ib]
            gaps.append(np.linalg.norm(pa - pb))
            mid = 0.5 * (pa + pb)
            corner[a][ia] = mid
            corner[b][ib] = mid

    share_top = [corner[order[k]][0] for k in range(n)]   # +u, +v side
    share_bot = [corner[order[k]][3] for k in range(n)]
    info = {
        "gaps": gaps,
        "setback": max(setback.values()),
        "order": order,
    }
    return corner, share_top, share_bot, info


def closure(corner, share_top, share_bot, order):
    """Every edge of the junction surface must be used exactly twice."""
    n = len(order)
    key = {}
    pts = []

    def kid(p):
        k = tuple(np.round(p, 6))
        if k not in key:
            key[k] = len(pts)
            pts.append(p)
        return key[k]

    faces = []
    # each leg's four side faces run off to infinity; the junction only owns
    # the CUT face (the quad through its four clipped corners)
    for i in range(n):
        faces.append([kid(p) for p in corner[i]])
    faces.append([kid(p) for p in share_top])
    faces.append([kid(p) for p in reversed(share_bot)])
    ec = Counter()
    for f in faces:
        for a in range(len(f)):
            e = (f[a], f[(a + 1) % len(f)])
            ec[(min(e), max(e))] += 1
    return ec, faces


def stage3():
    print("=" * 74)
    print("STAGE 3 - does the mitre CLOSE on the equatorial axis?")
    print("=" * 74)
    print("  parity: every edge of the junction shell used exactly twice.")
    print("  gap:    how far apart the two corners were before snapping - the")
    print("          construction is exact only where this is 0.")
    print(f"  {'case':<30} {'axis':>9} {'tilt':>6} {'parity':>7} "
          f"{'max gap':>8} {'setback':>8}")
    for name, dirs in CASES:
        for label, ax in (("shipped", shipped_axis(dirs)[0]),
                          ("equator", equatorial_axis(dirs)[0])):
            if ax is None:
                print(f"  {name:<30} {label:>9} {'-':>6} {'-':>7} {'-':>8} {'-':>8}")
                continue
            built = build_mitre(dirs, ax)
            if built is None:
                print(f"  {name:<30} {label:>9} {'-':>6} {'DEGEN':>7}")
                continue
            corner, st, sb, info = built
            ec, _ = closure(corner, st, sb, info["order"])
            bad = sum(1 for c in ec.values() if c != 2)
            tilt = max(abs(np.dot(d, ax)) for d in dirs)
            print(f"  {name:<30} {label:>9} {tilt:>6.3f} "
                  f"{'closed' if bad == 0 else str(bad) + ' bad':>7} "
                  f"{max(info['gaps']):>8.4f} {info['setback']:>8.3f}")
    print()


# ---------------------------------------------------------------------------
# STAGE 4 - the honest limit: where the shared corner is a LIE
# ---------------------------------------------------------------------------
# Snapping two corners to their midpoint closes the surface by construction -
# parity 2 is guaranteed and proves nothing on its own. What matters is how far
# the two corners were apart BEFORE the snap: that distance is daylight the
# renderer is papering over, and it shows as a kink at the joint.
def stage4():
    print("=" * 74)
    print("STAGE 4 - how big a lie is the snap? (gap before snapping)")
    print("=" * 74)
    print(f"  section is {2*W:.2f} A wide by {2*T:.2f} A thick; a gap of that")
    print("  order is a visible break, not a rounding error.")
    print(f"  {'case':<30} {'axis':>9} {'max gap':>9} {'as % of width':>14}")
    for name, dirs in CASES:
        for label, ax in (("shipped", shipped_axis(dirs)[0]),
                          ("equator", equatorial_axis(dirs)[0])):
            if ax is None:
                continue
            built = build_mitre(dirs, ax)
            if built is None:
                continue
            g = max(built[3]["gaps"])
            print(f"  {name:<30} {label:>9} {g:>9.4f} {100*g/(2*W):>13.1f}%")
    print()


# ---------------------------------------------------------------------------
# STAGE 5 - the construction that DOES reach a tetrahedron: a convex hull
# ---------------------------------------------------------------------------
# Stage 4 says the mitre is exact for three legs at any tilt, and for four only
# when they stand around the axis. The reason is a counting one: a shared corner
# is fixed by the two legs that meet there, so with three legs the three corners
# are free to be whatever the geometry says. With four, the four "top" corners
# must ALSO be coplanar enough to bound one filling polygon, and nothing makes
# them so unless the legs are equatorial.
#
# So drop the shared corner. Cut each leg square, and let the hole be closed by
# the CONVEX HULL of the sections' corners. This is the same idea the user
# described for the three-way - stop the boxes where they would run into each
# other, then fill the hole - with the assumption of a cyclic order removed:
#
#   * it needs no axis, no angular order and no snapping
#   * it is closed by construction (a hull is a closed convex polyhedron)
#   * it is exact: nothing is averaged, so there is no gap to paper over
#   * for coplanar legs it degenerates to exactly the present triangle/quad
#     fill, so the cases that already look right keep their geometry
from scipy.spatial import ConvexHull


def build_hull(dirs, rolls=None):
    """Square-cut each leg at its clip setback, then hull the corners."""
    n = len(dirs)
    # a roll for each leg. Any roll works; use the one the renderer would pick
    # from the local plane so the comparison is fair.
    if rolls is None:
        rolls = []
        for i, d in enumerate(dirs):
            seed = None
            for j, e in enumerate(dirs):
                if j != i:
                    c = np.cross(d, e)
                    if np.linalg.norm(c) > 1e-6:
                        seed = unit(np.cross(c, d))
                        break
            rolls.append(seed if seed is not None else unit(rej((0, 0, 1), d)))
    secs, corners, sb = [], [], []
    for i, d in enumerate(dirs):
        u = rolls[i]
        v = np.cross(d, u)
        # square cut: the setback is the WORST of the four corners' clips, so
        # the whole section clears every bisector plane
        s = 0.0
        for (su, sv) in [(+1, +1), (+1, -1), (-1, -1), (-1, +1)]:
            off = su * T * u + sv * W * v
            for j in range(n):
                if j == i:
                    continue
                m = dirs[i] - dirs[j]
                den = np.dot(dirs[i], m)
                if den > 1e-9:
                    s = max(s, -np.dot(off, m) / den)
        sb.append(s)
    # THE SECTION MUST BE A SUPPORTING PLANE OF THE WHOLE POINT SET, or the hull
    # closes OVER it and the filler gets painted inside that leg - which, with no
    # depth buffer, is not a sorting problem but a hole. The bisector clip alone
    # only guarantees the legs do not interpenetrate; on an irregular centre a
    # neighbour's corner can still reach past this leg's cut. So push each
    # setback out until every corner is behind it, and iterate: moving one leg
    # out moves its corners, which is a constraint on the others.
    # This terminates whenever the legs are mutually obtuse - moving leg j out
    # along d_j moves its corners BACKWARDS along d_i when d_i . d_j < 0, which
    # is every bonded angle over 90 deg. The cap is a guard, not a design.
    def corners_of(i, s):
        u = rolls[i]
        v = np.cross(dirs[i], u)
        return [s * dirs[i] + su * T * u + sv * W * v
                for (su, sv) in [(+1, +1), (+1, -1), (-1, -1), (-1, +1)]]

    for _ in range(64):
        moved = 0.0
        for i in range(n):
            need = sb[i]
            for j in range(n):
                if j == i:
                    continue
                for c in corners_of(j, sb[j]):
                    # STRICTLY behind, not level with. A foreign corner landing
                    # exactly ON the section plane joins that hull face, so the
                    # face has five vertices while the leg's own end has four -
                    # a T-junction, and the edge it splits is then used once by
                    # the leg and once by nothing. Measured as C(n,2) unclosed
                    # edges, one per pair of legs, before this margin.
                    need = max(need, np.dot(c, dirs[i]) + MARGIN)
            moved = max(moved, need - sb[i])
            sb[i] = need
        if moved < 1e-12:
            break
    for i in range(n):
        quad = corners_of(i, sb[i])
        secs.append(quad)
        corners.extend(quad)
    return np.array(corners), secs, sb


def hull_report(dirs):
    P, secs, sb = build_hull(dirs)
    # a degenerate (coplanar) point set has no 3D hull - that is the flat case
    try:
        h = ConvexHull(P)
    except Exception:
        return None
    # merge coplanar simplices into faces
    faces = {}
    for eq, simp in zip(h.equations, h.simplices):
        k = tuple(np.round(eq, 5))
        faces.setdefault(k, set()).update(simp.tolist())
    # Is each section a face? Compare by SUPPORTING PLANE, not by vertex index:
    # where the mitre is exact the neighbouring corners coincide, and qhull then
    # keeps one representative index for the shared point, so an index-subset
    # test reports a face that is plainly there as missing.
    on = 0
    for i, quad in enumerate(secs):
        d = dirs[i]
        s = sb[i]
        if all(np.dot(pt, d) <= s + 1e-9 for pt in P):
            on += 1
    return {"nfaces": len(faces), "sections_on_hull": on, "nlegs": len(dirs),
            "setback": max(sb), "extra": len(faces) - on}


def stage5():
    print("=" * 74)
    print("STAGE 5 - square cut + CONVEX HULL of the sections")
    print("=" * 74)
    print("  sections on hull: every leg's cut face must be a face of the hull,")
    print("  or the hull would cut into that leg and paint inside it.")
    print(f"  {'case':<30} {'legs':>4} {'faces':>6} {'secs on':>8} "
          f"{'filler':>7} {'setback':>8}")
    for name, dirs in CASES:
        r = hull_report(dirs)
        if r is None:
            print(f"  {name:<30} {len(dirs):>4} {'flat - no 3D hull (planar case)':>30}")
            continue
        ok = "OK" if r["sections_on_hull"] == r["nlegs"] else "MISSING"
        print(f"  {name:<30} {r['nlegs']:>4} {r['nfaces']:>6} "
              f"{str(r['sections_on_hull']) + '/' + str(r['nlegs']):>8} "
              f"{r['extra']:>7} {r['setback']:>8.3f}   {ok}")
    print()


def stage6():
    print("=" * 74)
    print("STAGE 6 - mitre vs hull, side by side")
    print("=" * 74)
    print(f"  {'case':<30} {'mitre gap':>10} {'mitre sb':>9} {'hull sb':>8} {'verdict':>9}")
    for name, dirs in CASES:
        ax = equatorial_axis(dirs)[0]
        built = build_mitre(dirs, ax)
        g = max(built[3]["gaps"]) if built else float('nan')
        msb = built[3]["setback"] if built else float('nan')
        r = hull_report(dirs)
        hsb = r["setback"] if r else 0.0
        verdict = "mitre" if g < 0.01 else "hull"
        print(f"  {name:<30} {g:>10.4f} {msb:>9.3f} {hsb:>8.3f} {verdict:>9}")
    print()
    print("  The mitre is EXACT (gap 0) for every 3-leg centre and for coplanar")
    print("  4-leg ones - keep it there, unchanged. It is only the genuinely")
    print("  non-planar 4-leg centres that need the hull, and there the hull is")
    print("  exact where the mitre is off by most of a stick width.")
    print()


# ---------------------------------------------------------------------------
# STAGE 7 - the whole solid is watertight, and the filler is not slivers
# ---------------------------------------------------------------------------
# Parity is the only proof that matters: assemble what would actually be drawn -
# each leg's four side faces and its far cap, plus the hull's faces MINUS the
# sections (a section is shared by the leg and the hull, so it is interior and
# must never be painted, exactly like a mitred cut today) - and require every
# edge to be used exactly twice.
def stage7():
    print("=" * 74)
    print("STAGE 7 - closure of the whole assembly, and the size of the filler")
    print("=" * 74)
    print(f"  {'case':<30} {'faces':>6} {'edges':>6} {'parity':>8} "
          f"{'min facet':>10} {'as % sec':>9}")
    for name, dirs in CASES:
        P, secs, sb = build_hull(dirs)
        try:
            h = ConvexHull(P)
        except Exception:
            print(f"  {name:<30} {'(planar - no 3D hull)':>30}")
            continue
        merged = {}
        for eq, simp in zip(h.equations, h.simplices):
            merged.setdefault(tuple(np.round(eq, 5)), set()).update(simp.tolist())

        key, pts = {}, []

        def kid(pt):
            k = tuple(np.round(pt, 5))
            if k not in key:
                key[k] = len(pts)
                pts.append(np.asarray(pt, float))
            return key[k]

        def order_ring(idxs, nrm):
            """put a planar face's vertices into a cycle"""
            P2 = [pts[i] for i in idxs]
            c = sum(P2) / len(P2)
            e1 = unit(P2[0] - c)
            e2 = np.cross(nrm, e1)
            return [i for _, i in sorted(
                (math.atan2(np.dot(pts[i] - c, e2), np.dot(pts[i] - c, e1)), i)
                for i in idxs)]

        faces = []
        # the legs: four sides + a far cap, running outward from the section
        for i, d in enumerate(dirs):
            near = [kid(p) for p in secs[i]]
            far = [kid(p + 1.5 * d) for p in secs[i]]
            for a2 in range(4):
                b2 = (a2 + 1) % 4
                faces.append([near[a2], near[b2], far[b2], far[a2]])
            faces.append(far[::-1])
        # the hull, minus each section (interior: the leg is on the other side)
        filler_area = []
        for eqk, vset in merged.items():
            nrm = np.array(eqk[:3], float)
            off = -eqk[3]
            is_section = any(
                abs(np.dot(nrm, dirs[i]) - 1) < 1e-4 and abs(off - sb[i]) < 1e-4
                for i in range(len(dirs)))
            if is_section:
                continue
            ring = order_ring([kid(P[v]) for v in vset], nrm)
            faces.append(ring)
            A = 0.0
            for a2 in range(1, len(ring) - 1):
                A += 0.5 * np.linalg.norm(np.cross(
                    pts[ring[a2]] - pts[ring[0]], pts[ring[a2 + 1]] - pts[ring[0]]))
            filler_area.append(A)
        ec = Counter()
        for f in faces:
            for a2 in range(len(f)):
                e = (f[a2], f[(a2 + 1) % len(f)])
                ec[(min(e), max(e))] += 1
        bad = sum(1 for c in ec.values() if c != 2)
        secA = (2 * W) * (2 * T)
        mn = min(filler_area) if filler_area else 0.0
        print(f"  {name:<30} {len(faces):>6} {len(ec):>6} "
              f"{'CLOSED' if bad == 0 else str(bad) + ' bad':>8} "
              f"{mn:>10.4f} {100 * mn / secA:>8.1f}%")
    print()
    print("  A facet far under ~1% of the section is a sliver: it costs a prim")
    print("  and a depth-sort slot to paint something under a pixel across.")
    print()


# ---------------------------------------------------------------------------
# STAGE 8 - three legs mitred, the fourth carried out on a collar
# ---------------------------------------------------------------------------
# The four sp3 directions sum to zero, so the sum of any THREE is exactly minus
# the fourth. The mitre's axis for a triple is that sum - therefore the omitted
# leg leaves exactly along the axis, straight out through the bottom triangle
# the mitre leaves behind. Nothing has to be invented: the fourth leg is already
# pointing down the hole.
#
# So: mitre three legs (exact, unchanged), and instead of filling the bottom
# triangle, run a COLLAR from it to the fourth leg's square section. Triangle to
# square, both roughly square-on to the fourth leg - a 7-sided ring, stitched.
def stitch(ring_a, ring_b, axis):
    """triangulate the band between two convex rings, by angle about axis."""
    e1 = unit(rej(ring_a[0] - np.mean(ring_a, axis=0), axis))
    e2 = np.cross(axis, e1)

    def ang(p, ring):
        q = rej(p - np.mean(ring, axis=0), axis)
        return math.atan2(np.dot(q, e2), np.dot(q, e1)) % (2 * math.pi)

    A = sorted(range(len(ring_a)), key=lambda i: ang(ring_a[i], ring_a))
    B = sorted(range(len(ring_b)), key=lambda i: ang(ring_b[i], ring_b))
    # start B at the vertex angularly nearest A's first
    a0 = ang(ring_a[A[0]], ring_a)
    B = sorted(B, key=lambda j: (ang(ring_b[j], ring_b) - a0) % (2 * math.pi))
    faces, i, j = [], 0, 0
    na, nb = len(A), len(B)
    while i < na or j < nb:
        ai, aj = A[i % na], B[j % nb]
        an = A[(i + 1) % na], B[(j + 1) % nb]
        # advance whichever ring is angularly behind
        da = (ang(ring_a[an[0]], ring_a) - a0) % (2 * math.pi) if i < na else 9
        db = (ang(ring_b[an[1]], ring_b) - a0) % (2 * math.pi) if j < nb else 9
        if (i < na) and (j >= nb or da <= db):
            faces.append([ring_a[ai], ring_b[aj], ring_a[an[0]]])
            i += 1
        else:
            faces.append([ring_b[aj], ring_b[an[1]], ring_a[ai]])
            j += 1
    return faces


def build_triple_plus(dirs):
    """mitre the best three, collar the fourth. Returns faces + diagnostics."""
    n = len(dirs)
    assert n == 4
    # pick the triple whose omitted leg lies closest to the axis it leaves along
    best = None
    for omit in range(4):
        tri = [dirs[i] for i in range(4) if i != omit]
        ax = unit(sum(tri))
        a = math.degrees(math.acos(max(-1, min(1, float(np.dot(dirs[omit], -ax))))))
        if best is None or a < best[0]:
            best = (a, omit, ax)
    off_axis, omit, ax = best
    tri = [dirs[i] for i in range(4) if i != omit]
    built = build_mitre(tri, ax)
    if built is None:
        return None
    corner, share_top, share_bot, info = built
    d4 = dirs[omit]
    # the fourth leg: clear of the three, and clear of the bottom triangle
    u4 = unit(rej(ax, d4)) if np.linalg.norm(rej(ax, d4)) > 1e-6 else \
        unit(rej(np.array([0.0, 0.0, 1.0]), d4))
    v4 = np.cross(d4, u4)
    s4 = 0.0
    for (su, sv) in [(+1, +1), (+1, -1), (-1, -1), (-1, +1)]:
        o = su * T * u4 + sv * W * v4
        for e in tri:
            m = d4 - e
            den = float(np.dot(d4, m))
            if den > 1e-9:
                s4 = max(s4, -float(np.dot(o, m)) / den)
    for p in share_bot:
        s4 = max(s4, float(np.dot(p, d4)) + MARGIN)
    sec4 = [s4 * d4 + su * T * u4 + sv * W * v4
            for (su, sv) in [(+1, +1), (+1, -1), (-1, -1), (-1, +1)]]
    collar = stitch(list(share_bot), sec4, d4)
    return {"off_axis": off_axis, "omit": omit, "gap": max(info["gaps"]),
            "corner": corner, "share_top": share_top, "share_bot": share_bot,
            "sec4": sec4, "collar": collar, "s4": s4, "tri": tri, "d4": d4,
            "u4": u4}


def stage8():
    print("=" * 74)
    print("STAGE 8 - mitre three, collar the fourth")
    print("=" * 74)
    print("  off-axis: how far the omitted leg is from the axis it leaves along.")
    print("  0 means it exits exactly down the middle of the bottom triangle.")
    print(f"  {'case':<28} {'omit':>5} {'off-axis':>9} {'3-way gap':>10} "
          f"{'collar':>7} {'parity':>8}")
    for name, dirs in CASES:
        if len(dirs) != 4:
            continue
        r = build_triple_plus(dirs)
        if r is None:
            print(f"  {name:<28} {'-':>5} {'DEGENERATE':>9}")
            continue
        # assemble and check closure
        key, pts = {}, []

        def kid(p):
            k = tuple(np.round(p, 5))
            if k not in key:
                key[k] = len(pts)
                pts.append(np.asarray(p, float))
            return key[k]

        faces = []
        for i, d in enumerate(r["tri"]):
            near = [kid(p) for p in r["corner"][i]]
            far = [kid(p + 1.5 * d) for p in r["corner"][i]]
            for a2 in range(4):
                b2 = (a2 + 1) % 4
                faces.append([near[a2], near[b2], far[b2], far[a2]])
            faces.append(far[::-1])
        faces.append([kid(p) for p in r["share_top"]])
        near4 = [kid(p) for p in r["sec4"]]
        far4 = [kid(p + 1.5 * r["d4"]) for p in r["sec4"]]
        for a2 in range(4):
            b2 = (a2 + 1) % 4
            faces.append([near4[a2], near4[b2], far4[b2], far4[a2]])
        faces.append(far4[::-1])
        for f in r["collar"]:
            faces.append([kid(p) for p in f])
        ec = Counter()
        for f in faces:
            for a2 in range(len(f)):
                e = (f[a2], f[(a2 + 1) % len(f)])
                ec[(min(e), max(e))] += 1
        bad = sum(1 for c in ec.values() if c != 2)
        print(f"  {name:<28} {r['omit']:>5} {r['off_axis']:>8.2f}d "
              f"{r['gap']:>10.4f} {len(r['collar']):>7} "
              f"{'CLOSED' if bad == 0 else str(bad) + ' bad':>8}")
    print()


if __name__ == "__main__":
    stage1()
    stage2()
    stage3()
    stage4()
    stage5()
    stage6()
    stage7()
    stage8()
