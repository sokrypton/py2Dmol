"""Geometry of the ligand sticks in the cartoon renderer, derived and checked.

    python tests/junction_math.py

A ligand bond is drawn as a BOX: two square end faces of half-side h, joined by
four ruled faces. Where bonds meet, one of two things happens, and which one is
decided by the geometry rather than by preference:

    coplanar legs   the boxes are MITRED into each other - each pair of
                    neighbours shares the corner where their side faces cross,
                    and the polygon left in the middle is filled top and bottom
    anything else   the boxes simply OVERLAP, running atom to atom

The second case needs no geometry at all, and the first is exact, so there is
no case left over where something has to be invented.

Everything below is checked numerically rather than by eye, in the order the
maths was worked out. The renderer implements exactly this; the constants
LIGAND_HALF_A and LIGAND_EAT come from stage 4.
"""
import math
from collections import Counter
from itertools import combinations

# --- vectors ---------------------------------------------------------------
def sub(a, b): return tuple(x - y for x, y in zip(a, b))
def add(a, b): return tuple(x + y for x, y in zip(a, b))
def mul(a, s): return tuple(x * s for x in a)
def dot(a, b): return sum(x * y for x, y in zip(a, b))
def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def unit(a):
    n = math.sqrt(dot(a, a))
    return tuple(x / n for x in a) if n > 1e-12 else None


# ---------------------------------------------------------------------------
# STAGE 1 - a bond is a box, and the box is closed
# ---------------------------------------------------------------------------
# 8 vertices: the two end squares. 6 faces, wound counter-clockwise seen from
# outside. The two ends may have DIFFERENT frames - a bond between two planar
# fragments that are twisted relative to each other has a twisted box - so the
# four long faces are ruled quads rather than rectangles.

FACES = [(0, 1, 2, 3),      # cap at A, outward -t
         (7, 6, 5, 4),      # cap at B, outward +t
         (0, 4, 5, 1),      # +n
         (2, 6, 7, 3),      # -n
         (1, 5, 6, 2),      # -b
         (3, 7, 4, 0)]      # +b

def box(A, B, frameA, frameB, h):
    V = []
    for P, (n, b) in ((A, frameA), (B, frameB)):
        for sn, sb in ((1, 1), (1, -1), (-1, -1), (-1, 1)):
            V.append(add(P, add(mul(n, sn * h), mul(b, sb * h))))
    return V

def closed(faces):
    c = Counter()
    for f in faces:
        for i in range(len(f)):
            c[tuple(sorted((f[i], f[(i + 1) % len(f)])))] += 1
    return sorted(set(c.values())), len(c)

def stage1():
    t = unit((1, 0, 0)); n = (0, 1, 0); b = cross(t, n)
    V = box((0, 0, 0), (1.5, 0, 0), (n, b), (n, b), 0.30)
    par, ne = closed(FACES)
    print(f"  box: {len(V)} vertices, {len(FACES)} faces, {ne} edges, parity {par}"
          + ("  CLOSED" if par == [2] else "  *** OPEN ***"))


# ---------------------------------------------------------------------------
# STAGE 2 - which edges are drawn
# ---------------------------------------------------------------------------
# An edge is a SILHOUETTE edge iff exactly one of the two faces meeting there
# faces the viewer. Interior creases - both faces visible, like the edge running
# along a stick you can see two sides of - are not drawn, which is the same rule
# the cartoon already applies to its loops.
#
# This is what makes a line across a face impossible: every drawn edge has a
# hidden face on one side of it, so by construction it lies on the outline.

def face_normal(V, f):
    return unit(cross(sub(V[f[1]], V[f[0]]), sub(V[f[2]], V[f[0]])))

def silhouette(V, eye):
    owner = {}
    for fi, f in enumerate(FACES):
        for i in range(len(f)):
            e = tuple(sorted((f[i], f[(i + 1) % len(f)])))
            owner.setdefault(e, []).append(fi)
    front = [dot(face_normal(V, f), eye) > 0 for f in FACES]
    sil = [e for e, fs in owner.items() if front[fs[0]] != front[fs[1]]]
    crease = [e for e, fs in owner.items()
              if front[fs[0]] and front[fs[1]]]
    return sil, crease

def stage2():
    t = unit((1, 0, 0)); n = (0, 1, 0); b = cross(t, n)
    V = box((0, 0, 0), (1.5, 0, 0), (n, b), (n, b), 0.30)
    for deg in (0, 20, 45, 70, 90):
        a = math.radians(deg)
        sil, cre = silhouette(V, unit((0, math.sin(a), math.cos(a))))
        print(f"  view {deg:3d} deg: {len(sil)} silhouette edges drawn, "
              f"{len(cre)} interior creases left alone")


# ---------------------------------------------------------------------------
# STAGE 3 - the roll of each box
# ---------------------------------------------------------------------------
# A square section has a roll angle, and if two bonds sharing an atom disagree
# about it the joint looks like two randomly twisted sticks. The roll must be a
# function of the molecule (so it turns with it) and must AGREE between bonds
# that share a plane.
#
# Taking the local plane normal does both:  n  proportional to  sum t x (q-mid)
# over the bonded neighbours of either atom. Each term is perpendicular to the
# bond and to the plane through it and that neighbour, so for neighbours sharing
# a plane with the bond they all point the same way.

def roll(A, B, neighbours, centre=(0, 0, 0)):
    t = unit(sub(B, A))
    mid = mul(add(A, B), 0.5)
    m = (0.0, 0.0, 0.0)
    for q in neighbours:
        u = unit(sub(q, mid))
        if u:
            m = add(m, cross(t, u))
    def perp(v):
        if v is None:
            return None
        return unit(sub(v, mul(t, dot(v, t))))
    n = perp(unit(m) if unit(m) else None) or perp(sub(centre, mid)) \
        or perp((1, 0, 0)) or perp((0, 1, 0))
    return t, n, cross(t, n)

def disagreement(f1, f2):
    """angle between two section axes, modulo the square's 90 deg symmetry"""
    a = math.degrees(math.acos(max(-1, min(1, abs(dot(f1[1], f2[1]))))))
    return min(a, abs(90 - a))

def stage3():
    ring = [(math.cos(math.radians(60 * i)) * 1.4,
             math.sin(math.radians(60 * i)) * 1.4, 0.0) for i in range(6)]
    f1 = roll(ring[0], ring[1], [ring[2], ring[5]])
    f2 = roll(ring[1], ring[2], [ring[0], ring[3]])
    print(f"  aromatic ring, adjacent bonds : {disagreement(f1, f2):5.1f} deg apart")
    c = [(0, 0, 0), (1.5, 0, 0), (2.0, 1.4, 0.4), (3.5, 1.4, 1.0)]
    g1 = roll(c[0], c[1], [c[2]])
    g2 = roll(c[1], c[2], [c[0], c[3]])
    print(f"  sp3 chain, adjacent bonds     : {disagreement(g1, g2):5.1f} deg apart"
          "   (boxes overlap, so it does not show)")


# ---------------------------------------------------------------------------
# STAGE 4 - how thick a stick may be
# ---------------------------------------------------------------------------
# A mitred junction sets each leg back. Two square legs at angle theta touch at
# a corner d along each of them, and the whole construction follows from
#
#       d = h * cot(theta / 2)
#
# A bond has a junction at each end, and what is left between them is the stick,
# so d_a + d_b must stay well under the bond length. Allowing a junction to eat
# at most LIGAND_EAT of a bond and solving for h:
#
#       h <= LIGAND_EAT * L * tan(theta / 2)

LIGAND_EAT = 0.30
NOMINAL_H = 0.30

def setback(h, theta_deg):
    return h / math.tan(math.radians(theta_deg) / 2)

def h_cap(L, theta_deg):
    return LIGAND_EAT * L * math.tan(math.radians(theta_deg) / 2)

def stage4():
    print(f"  {'geometry':<34}{'L':>6}{'theta':>8}{'h cap':>8}{'setback at h=0.30':>20}")
    for name, L, th in (("sp2 trigonal (aromatic)", 1.39, 120.0),
                        ("sp3 tetrahedral", 1.54, 109.5),
                        ("four-way", 2.00, 90.0),
                        ("three-membered ring", 1.51, 60.0)):
        cap = h_cap(L, th)
        h = min(NOMINAL_H, cap)
        d = setback(h, th)
        print(f"  {name:<34}{L:6.2f}{th:8.1f}{cap:8.3f}"
              f"{d:12.3f} A ({100*d/L:.0f}% of the bond)")


# ---------------------------------------------------------------------------
# STAGE 5 - the mitred junction, and when it applies
# ---------------------------------------------------------------------------
# Adjacent legs' facing side planes meet at one point. In the junction's plane
# that is a line-line intersection, and it lands exactly where stage 4 says.
# The corners form the middle polygon; extruded by +-h it closes into a solid.
#
# All of which assumes the legs SHARE A PLANE. A tetrahedral centre has none, so
# there is no "above and below" to fill and the construction does not apply -
# there the boxes just overlap, which is stage 6.

def corner(u1, u2, h):
    """The corner in the gap between two legs, taken with a fixed HANDEDNESS:
    leg 1's counter-clockwise side against leg 2's clockwise side, read off the
    order the legs were sorted into around the plane normal.

    Not "whichever side faces the other leg". That picks the inner side both
    times, so an atom with TWO bonds gets the same corner twice - and a box
    whose two corners coincide has no width at all. Two legs have a corner on
    each side of them; which is which is handedness, not proximity. The k=2
    case below is the one that catches this, and it is the commonest junction
    there is: every atom in a ring."""
    n1, n2 = (-u1[1], u1[0]), (-u2[1], u2[0])
    det = n1[0] * n2[1] - n1[1] * n2[0]
    if abs(det) < 1e-12:
        return None
    return ((h * n2[1] + h * n1[1]) / det, -(n1[0] * h + n2[0] * h) / det)

def flatness(dirs):
    """max |leg . n| over the best-fit plane normal; 0 means coplanar"""
    best = 9.0
    N = 90
    for i in range(N):
        for j in range(2 * N):
            th, ph = math.pi * i / N, math.pi * j / N
            n = (math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph),
                 math.cos(th))
            best = min(best, max(abs(dot(d, n)) for d in dirs))
    return best

def stage5():
    h = 0.30
    for label, angles in (("two legs, 120 deg (a ring atom)", [0, 120]),
                          ("two legs, 109 deg", [0, 109]),
                          ("three coplanar legs, 120 deg", [0, 120, 240]),
                          ("three coplanar legs, uneven", [0, 100, 215]),
                          ("four coplanar legs", [0, 90, 180, 270])):
        legs = [(math.cos(math.radians(a)), math.sin(math.radians(a)))
                for a in angles]
        k = len(legs)
        cs = [corner(legs[i], legs[(i + 1) % k], h) for i in range(k)]
        worst = 0.0
        for i in range(k):
            u1, u2 = legs[i], legs[(i + 1) % k]
            th = math.acos(max(-1, min(1, dot(u1, u2))))
            want = setback(h, math.degrees(th))
            # |.| because with only two legs one corner sits on each side of
            # them, and the far one is at a negative distance along the leg
            got1 = abs(cs[i][0] * u1[0] + cs[i][1] * u1[1])
            got2 = abs(cs[i][0] * u2[0] + cs[i][1] * u2[1])
            worst = max(worst, abs(got1 - want), abs(got2 - want))
        across = min(abs(cs[i][0] * (-legs[i][1]) + cs[i][1] * legs[i][0]
                         - (cs[(i - 1) % k][0] * (-legs[i][1])
                            + cs[(i - 1) % k][1] * legs[i][0]))
                     for i in range(k))
        print(f"  {label:<32} {k} corners, "
              f"vs h*cot(theta/2): {worst:.1e}, "
              f"corners of a leg {across:.3f} apart across it "
              + ("OK" if across > 1.5 * h else "*** COLLAPSED ***"))
    print()
    T = 1 / math.sqrt(3)
    for name, dirs in (("sp2 trigonal", [(1, 0, 0), (-.5, .866, 0), (-.5, -.866, 0)]),
                       ("sp3 pyramidal", [(T, T, T), (T, -T, -T), (-T, T, -T)]),
                       ("sp3 tetrahedral", [(T, T, T), (T, -T, -T), (-T, T, -T),
                                            (-T, -T, T)])):
        f = flatness(dirs)
        print(f"  {name:<30} out of plane {f:.3f} -> "
              + ("mitred" if f < 0.10 else "boxes overlap"))


# ---------------------------------------------------------------------------
# STAGE 6 - overlap is safe
# ---------------------------------------------------------------------------
# Where the boxes are not mitred they run to the atom and interpenetrate. The
# union of two opaque solids is a solid, so the only question is whether any
# drawn edge of one ends up in front of the other, where it would appear as a
# line across a face. It does not: everything of A inside B is behind B.

def inside(A, B, frame, h, p, eps=1e-9):
    t = unit(sub(B, A)); n, b = frame
    d = dot(sub(p, A), t)
    return (-eps <= d <= dot(sub(B, A), t) + eps
            and abs(dot(sub(p, A), n)) <= h + eps
            and abs(dot(sub(p, A), b)) <= h + eps)

def stage6():
    h = 0.30
    A, M, C = (-1.4, 0, 0), (0, 0, 0), (0.7, 1.21, 0)
    n = (0, 0, 1)
    t1 = unit(sub(M, A)); f1 = (unit(sub(n, mul(t1, dot(n, t1)))), None)
    f1 = (f1[0], cross(t1, f1[0]))
    t2 = unit(sub(C, M)); f2 = (unit(sub(n, mul(t2, dot(n, t2)))), None)
    f2 = (f2[0], cross(t2, f2[0]))
    V1 = box(A, M, f1, f1, h)
    sil, _ = silhouette(V1, (0, 0, 1))
    checked = infront = 0
    for (i, j) in sil:
        for s in (k / 20 for k in range(21)):
            p = add(mul(V1[i], 1 - s), mul(V1[j], s))
            if inside(M, C, f2, h, p):
                checked += 1
                zs = []
                V2 = box(M, C, f2, f2, h)
                for f in FACES:
                    nf = face_normal(V2, f)
                    if abs(nf[2]) < 1e-9:
                        continue
                    zf = V2[f[0]][2] + (nf[0] * (V2[f[0]][0] - p[0])
                                        + nf[1] * (V2[f[0]][1] - p[1])) / nf[2]
                    zs.append(zf)
                if zs and p[2] > max(zs) + 1e-9:
                    infront += 1
    print(f"  120 deg joint: {checked} silhouette samples of one box lie inside "
          f"the other,\n  of which {infront} are in front of it "
          "(any would draw a line across a face)")


if __name__ == "__main__":
    for name, fn in (("STAGE 1  a bond is a closed box", stage1),
                     ("STAGE 2  only silhouette edges are drawn", stage2),
                     ("STAGE 3  the roll of each box", stage3),
                     ("STAGE 4  how thick a stick may be", stage4),
                     ("STAGE 5  the mitred junction, where it applies", stage5),
                     ("STAGE 6  and overlap everywhere else", stage6)):
        print(f"\n{name}\n" + "-" * len(name))
        fn()
