"""Does one amino acid bleed through one helical turn? Worked out, not drawn.

No renderer, no canvas, no pixels. An ideal alpha helix and an ideal side chain
are built from their own geometry, the renderer's SORT KEYS are evaluated on
them exactly, and the result is compared against the TRUE occlusion order,
which for two disjoint convex solids is a fact about the pair and the view
direction and nothing else.

THE TWO QUESTIONS ARE DIFFERENT AND ARE ASKED SEPARATELY.

  1. Do the solids INTERSECT? That is rotation-invariant - a rigid motion
     cannot separate two bodies that overlap - so it is asked once per
     thickness, over no rotations at all. If they intersect, NO paint order is
     correct and no sort can fix it.

  2. Given they are disjoint, does the KEY order them the way the geometry
     does? That is rotation-dependent, and is asked over the whole sphere of
     view directions. Roll about the view axis is not sampled because it
     changes neither depth nor overlap - only the direction matters, so
     "all rotations" is a sphere, not SO(3).

TRUE ORDER, EXACTLY. For disjoint convex A and B, let D = A (-) B be the
Minkowski difference. Along view direction v the projections of A and B overlap
if and only if the line {t*v} meets D, and A is then in FRONT of B if and only
if it meets it at t > 0 (a = b + t*v puts a nearer). D is convex and does not
contain the origin, so the intersection lies entirely on one side of zero and
the order is unambiguous. No sampling, no rasterising.
"""
import numpy as np
from itertools import product
from scipy.spatial import ConvexHull, Delaunay

# ---- the renderer's own constants (py2Dmol/resources/viewer-cartoon.js) ----
SS_HALF_A_H   = 1.3     # helix half-width, Angstrom, before the Width slider
LIGAND_STICK_H = 0.30
LIGAND_WIDTH   = 2.5
LIGAND_TH_MAX  = 0.5
STICK_HW = LIGAND_STICK_H * (LIGAND_WIDTH / 3.0)     # 0.25 A
NSUB = 4                # stations per residue at cartoonDetail 4
                        # _cuts 'quarter' with nsub 4 cuts at [0,1,2,3,4],
                        # so ONE PIECE IS ONE SUB-QUAD - a quarter residue.

# ---- ideal alpha helix ----
R_HELIX = 2.3           # CA radius
RISE    = 1.5           # per residue
DTHETA  = np.deg2rad(100.0)
N_RES   = 6             # 500 deg: one full turn and a little, so the ribbon
                        # comes back round past the side chain
OWNER   = 2             # the residue that carries the amino acid


def helix(u):
    """CA curve at continuous residue parameter u, and its Frenet-free frame.

    The renderer's frame: width direction n, face normal b = t x n, corners at
    centre +- n*halfW +- b*halfT. For an ideal helix the peptide-plane normal
    that feeds n is the axial-ish direction perpendicular to the tangent, which
    makes b come out RADIAL - the flat faces look in and out, which is the
    helix everyone draws and is what "inner and outer face" means.
    """
    th = u * DTHETA
    c, s = np.cos(th), np.sin(th)
    C = np.array([R_HELIX * c, R_HELIX * s, RISE * u])
    t = np.array([-R_HELIX * s * DTHETA, R_HELIX * c * DTHETA, RISE])
    t /= np.linalg.norm(t)
    z = np.array([0.0, 0.0, 1.0])
    n = z - np.dot(z, t) * t
    n /= np.linalg.norm(n)
    b = np.cross(t, n)
    return C, t, n, b


def rib_pieces(halfT, halfW):
    """One prim per sub-quad: 8 corners, its own key. Exactly what the renderer
    emits at default detail."""
    out = []
    for i in range(N_RES - 1):
        for k in range(NSUB):
            corners = []
            for u in (i + k / NSUB, i + (k + 1) / NSUB):
                C, t, n, b = helix(u)
                for sn, sb in product((1, -1), (1, -1)):
                    corners.append(C + sn * halfW * n + sb * halfT * b)
            out.append(np.array(corners))
    return out


def stick_boxes(halfT, stickHT, tilt_deg):
    """The amino acid: CA->CB->tip, as the two square-section boxes the
    renderer builds, starting AT THE RIBBON SURFACE rather than at the CA."""
    C, t, n, b = helix(OWNER)
    a = np.deg2rad(tilt_deg)
    d = np.cos(a) * b + np.sin(a) * n      # radial, optionally tilted axially
    d /= np.linalg.norm(d)
    # where it leaves the slab: the ray/slab exit, face at halfT/|d.b| against
    # edge at halfW/|d.n| - the smaller wins
    ex_face = halfT / max(abs(np.dot(d, b)), 1e-9)
    ex_edge = SS_HALF_A_H / max(abs(np.dot(d, n)), 1e-9)
    exit_len = min(ex_face, ex_edge)
    P = [C + exit_len * d, C + 1.53 * d, C + 3.0 * d]
    e1 = np.cross(d, [0, 0, 1.0])
    if np.linalg.norm(e1) < 1e-6:
        e1 = np.cross(d, [1.0, 0, 0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(d, e1)
    # THE FLUSH CUT, which is the whole point and which a first version of this
    # left out - it built square ends instead, and then measured 0.24 A of
    # "penetration" that was nothing but the corner of a square end poking
    # through a plane it was never meant to be perpendicular to. A FLAT,
    # UNTWISTED beam scored the same 0.24 A, which is what gave it away: a flat
    # ribbon has no twist to blame.
    #
    # The real cut slides each of the four corners of the near end ALONG THE
    # BOND until it reaches the surface plane, so the end face lies IN the
    # surface. That is also where the corner travel 1/|d.n| comes from.
    surf_p = C + exit_len * d
    surf_n = b if ex_face <= ex_edge else n
    dn = float(np.dot(d, surf_n))
    boxes = []
    for bi, (A, B) in enumerate(((P[0], P[1]), (P[1], P[2]))):
        corners = []
        for ei, end in enumerate((A, B)):
            for s1, s2 in product((1, -1), (1, -1)):
                c = end + s1 * STICK_HW * e1 + s2 * max(stickHT, 1e-4) * e2
                if bi == 0 and ei == 0 and abs(dn) > 1e-6:
                    c = c + d * (float(np.dot(surf_p - c, surf_n)) / dn)
                corners.append(c)
        boxes.append(np.array(corners))
    return boxes, exit_len, ('face' if ex_face <= ex_edge else 'edge')


# ---- geometry helpers ----
def gap(A, B):
    """SIGNED clearance between two convex hulls, in Angstrom.

    > 0  disjoint by that much
    = 0  touching - which is what a flush cut is BY CONSTRUCTION, so it must
         not be reported as a bleed
    < 0  really interpenetrating, by that depth: no paint order is correct

    From the facets of the Minkowski difference D = A (-) B. scipy gives each
    facet as n.x + d <= 0 with n a unit normal, so the value at the origin is
    just d: the largest d over the facets is the separation along the best
    separating plane, and if every d is negative the origin is inside and the
    least negative one is the penetration depth.
    """
    D = (A[:, None, :] - B[None, :, :]).reshape(-1, 3)
    try:
        h = ConvexHull(D)
    except Exception:
        return 0.0
    return float(h.equations[:, 3].max())


def sphere(n):
    """View directions, spread evenly. Roll is not sampled: it changes neither
    depth nor which things overlap."""
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    gold = np.pi * (1 + 5 ** 0.5)
    th = gold * i
    return np.stack([np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)], 1)


KEY_BIAS = np.zeros(3)   # control: corrupt the ribbon key and watch it fail


def audit(A, B, views):
    """For every view: do the projections overlap, who is really in front, and
    does the mean-of-corners key agree?

    Returns (overlap, true_A_front, key_A_front) as boolean arrays over views.
    """
    D = (A[:, None, :] - B[None, :, :]).reshape(-1, 3)
    try:
        hull = ConvexHull(D)
        D = D[hull.vertices]
    except Exception:
        pass
    kA = A.mean(0)
    kB = B.mean(0) + KEY_BIAS
    w = kA - kB
    key_front = views @ w > 0

    # the line {t*v} meets D  <=>  the origin lies in D projected along v.
    # D is convex, so that is a 2D convex-hull containment; and where it holds,
    # every point of D on the line has the same sign of t, so the sign of the
    # nearest such point IS the true order.
    overlap = np.zeros(len(views), bool)
    truth = np.zeros(len(views), bool)
    for vi, v in enumerate(views):
        e1 = np.cross(v, [0, 0, 1.0])
        if np.linalg.norm(e1) < 1e-6:
            e1 = np.cross(v, [1.0, 0, 0])
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(v, e1)
        P = np.stack([D @ e1, D @ e2], 1)
        try:
            tri = Delaunay(P)
        except Exception:
            continue
        if tri.find_simplex(np.zeros(2)) < 0:
            continue
        overlap[vi] = True
        # t of the points of D whose projection is nearest the origin: take the
        # simplex containing the origin and interpolate t across it
        s = tri.find_simplex(np.zeros(2))
        verts = tri.simplices[s]
        M = np.vstack([P[verts].T, np.ones(3)])
        lam = np.linalg.solve(M, np.array([0.0, 0.0, 1.0]))
        truth[vi] = float(lam @ (D[verts] @ v)) > 0
    return overlap, truth, key_front


# ---- run ----
VIEWS = sphere(400)
print(f'ideal alpha helix, {N_RES} residues ({N_RES * 100} deg), amino acid on '
      f'residue {OWNER}')
print(f'half-width {SS_HALF_A_H} A, stick half-width {STICK_HW} A, '
      f'{len(VIEWS)} view directions\n')

import sys
if len(sys.argv) > 1 and sys.argv[1] == 'control':
    KEY_BIAS = np.array([0.0, 0.0, 3.0])
    print('CONTROL RUN: ribbon key deliberately shifted 3 A - expect failures\n')

for tilt in (0.0, 30.0):
    print(f'--- side chain tilted {tilt:.0f} deg off radial ---')
    print('  thick  halfT  exit    via   penetration (A)     views with   worst key')
    print('                               own piece   other    wrong order  error (A)')
    for th in (0.0, 0.15, 0.3, 0.5, 0.75, 1.0, 1.25, 1.5):
        halfT = th / 2.0
        stickHT = min(LIGAND_TH_MAX, th) / 2.0 if th > 0 else 0.0
        pieces = rib_pieces(halfT, SS_HALF_A_H)
        boxes, exit_len, via = stick_boxes(halfT, stickHT, tilt)
        TOL = 1e-6
        worst_pen, worst_who = 0.0, ''
        own = (OWNER - 1) * NSUB, (OWNER + 1) * NSUB   # pieces touching residue OWNER
        pen_own, pen_other = 0.0, 0.0
        bad = np.zeros(len(VIEWS), bool)
        worst = 0.0
        n_dis = n_touch = n_pen = 0
        n_ovl = 0
        for bi, bx in enumerate(boxes):
            for pi, pc in enumerate(pieces):
                g = gap(bx, pc)
                if g < -TOL:
                    if own[0] <= pi < own[1]:
                        pen_own = min(pen_own, g)
                    else:
                        pen_other = min(pen_other, g)
                    if g < worst_pen:
                        worst_pen, worst_who = g, f'bond{bi} vs piece{pi}'
                    n_pen += 1
                    continue
                if g < TOL:
                    n_touch += 1
                    continue    # touching: the flush joint, not a bleed
                n_dis += 1
                ov, tr, ky = audit(bx, pc, VIEWS)
                n_ovl += int(ov.sum())
                wrong = ov & (tr != ky)
                bad |= wrong
                if wrong.any():
                    w = bx.mean(0) - pc.mean(0)
                    worst = max(worst, float(np.abs(VIEWS[wrong] @ w).max()))
        print(f'  {th:4.2f}  {halfT:5.3f}  {exit_len:4.2f}  {via:>5}  '
              f'{pen_own:9.4f} {pen_other:8.4f}   {100 * bad.mean():8.2f}%   '
              f'{worst:8.3f}   [{n_dis} disjoint pairs, {n_touch} touching, '
              f'{n_pen} penetrating; {n_ovl} overlapping pair-views examined]')
    print()
