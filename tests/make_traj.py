"""A synthetic trajectory whose secondary structure cannot change.

    python3 tests/make_traj.py           # writes _traj_{3chy,1tim,1aoi}.pdb
    python3 tests/make_traj.py 1UBQ.cif  # one structure

Input for tests/anim_profile.py and tests/stable_topology.py. Every model is the
same molecule under a smooth, low-spatial-frequency breathing displacement: the
wavelength is hundreds of
residues, so neighbours move together and bond lengths, dihedrals and the fold
are all preserved. That is the case the topology caches would be kept across -
an MD trajectory, an NMR ensemble, a morph.

🔴 IT IS NOT A FOLDING TRAJECTORY, AND THE DIFFERENCE IS THE WHOLE POINT. A
diffusion trajectory starts as noise and acquires its fold on the way, so its
assignment changes every frame and must keep being recomputed. Anything
measured here says what a CONSTANT-topology trajectory costs and nothing about
that one.
"""
import math, sys

CARTN = ("Cartn_x", "Cartn_y", "Cartn_z")


def read_cif(path):
    header, rows, in_loop = [], [], False
    for line in open(path):
        s = line.strip()
        if s.startswith("_atom_site."):
            header.append(s.split(".", 1)[1]); in_loop = True; continue
        if in_loop:
            if s.startswith(("ATOM", "HETATM")):
                rows.append(s.split())
            elif rows:
                break
    return header, rows


def read_loop(path, prefix):
    """Every row of one mmCIF loop, with its column names, as read_cif does for
    _atom_site."""
    header, rows, in_loop = [], [], False
    for line in open(path):
        t = line.strip()
        if t.startswith(prefix):
            header.append(t.split(".", 1)[1]); in_loop = True; continue
        if in_loop:
            if t and not t.startswith(("#", "loop_", "_")):
                rows.append(t.split())
            elif rows or t.startswith(("#", "loop_")):
                break
    return header, rows


def ssbond_lines(src):
    """The source's disulfides, as PDB SSBOND records.

    🔴 WITHOUT THESE A TRAJECTORY FIXTURE CANNOT DECLARE ANYTHING, and every
    fixture in this file is a multi-model PDB. The renderer then falls back to a
    2.5 A distance over every SG pair, re-derived per frame - which on a moving
    structure is not stable: measured on _traj_3ptb.pdb, four distinct disulfide
    counts in six frames, taking the segment list and the ribbon with it.

    🔴 AND THEY ARE WRITTEN IN AUTH NUMBERING, because that is what the ATOM
    records below use. A PDB has no label/auth split, so whatever is written
    here is what the reader will look up - get it wrong and the record resolves
    to a different residue rather than to nothing, which is a fault that returns
    a number instead of an error. See tests/disulfides.py.
    """
    try:
        header, rows = read_loop(src, "_struct_conn.")
    except OSError:
        return []
    if not rows:
        return []
    idx = {n: i for i, n in enumerate(header)}
    need = ["conn_type_id", "ptnr1_auth_asym_id", "ptnr1_auth_seq_id",
            "ptnr2_auth_asym_id", "ptnr2_auth_seq_id"]
    if any(n not in idx for n in need):
        return []
    out = []
    for r in rows:
        if len(r) <= max(idx[n] for n in need):
            continue
        if r[idx["conn_type_id"]] != "disulf":
            continue
        c1 = r[idx["ptnr1_auth_asym_id"]][:1]
        c2 = r[idx["ptnr2_auth_asym_id"]][:1]
        try:
            s1 = int(r[idx["ptnr1_auth_seq_id"]])
            s2 = int(r[idx["ptnr2_auth_seq_id"]])
        except ValueError:
            continue
        # fixed columns, 0-based: 0-5 name, 7-9 serial, 11-13 CYS, 15 chain,
        # 17-20 seq, 25-27 CYS, 29 chain, 31-34 seq
        b = [" "] * 80
        def put(at, txt):
            for k, ch in enumerate(txt):
                b[at + k] = ch
        put(0, "SSBOND")
        put(7, f"{len(out) + 1:>3}")
        put(11, "CYS"); put(15, c1); put(17, f"{s1:>4}")
        put(25, "CYS"); put(29, c2); put(31, f"{s2:>4}")
        out.append("".join(b).rstrip())
    return out


def emit(src, dst, models=30, amp=0.45, ca_only=False):
    header, rows = read_cif(src)
    idx = {name: i for i, name in enumerate(header)}
    need = ["label_atom_id", "label_comp_id", "auth_asym_id", "auth_seq_id",
            "type_symbol", *CARTN]
    missing = [n for n in need if n not in idx]
    if missing:
        raise SystemExit(f"{src}: no {missing} in the atom_site loop")
    if ca_only:
        # 🔴 THE TRACE IS ALL A CARTOON READS, and the difference is a factor of
        # eight in the file: 9FOG is 28,716 atoms a model and 3,361 alpha
        # carbons. A demo nobody can download is not a demo.
        rows = [r for r in rows if r[idx["label_atom_id"]].strip('"') == "CA"]
    out = list(ssbond_lines(src))
    for m in range(models):
        ph = 2 * math.pi * m / models
        out.append(f"MODEL     {m + 1:>4}")
        for serial, r in enumerate(rows, 1):
            x, y, z = (float(r[idx[c]]) for c in CARTN)
            i = float(r[idx["auth_seq_id"]].replace("?", "0") or 0)
            x += amp * math.sin(2 * math.pi * i / 180 + ph)
            y += amp * math.sin(2 * math.pi * i / 220 + ph * 1.3)
            z += amp * math.sin(2 * math.pi * i / 260 + ph * 0.7)
            name = r[idx["label_atom_id"]].strip('"')
            name = f" {name:<3}" if len(name) < 4 else name
            out.append(
                f"ATOM  {serial % 100000:>5} {name:<4} {r[idx['label_comp_id']]:>3}"
                f" {r[idx['auth_asym_id']][:1]:1}{r[idx['auth_seq_id']]:>4}    "
                f"{x:>8.3f}{y:>8.3f}{z:>8.3f}{1.0:>6.2f}{0.0:>6.2f}"
                f"{'':10}{r[idx['type_symbol']]:>2}")
        out.append("ENDMDL")
    out.append("END")
    open(dst, "w").write("\n".join(out) + "\n")
    print(f"{dst}  models={models}  atoms/model={len(rows)}")


def emit_collapsed(src, dst, models=16, tightness=0.04):
    """The OTHER track a sampler step carries: the DENOISED prediction.

    A step has two coordinate sets - the noisy x_t and the model's estimate of
    the clean structure, x0 - and localfold has a probe whose whole subject is
    which of them is the picture. They
    fail the viewer in OPPOSITE directions, and both are worth a fixture:

      x_t   spread out at high sigma. Consecutive CAs metres apart, so the
            5.0 A chainbreak cuts every one of them and the chain shatters.
            emit_diffusion above.

      x0    COLLAPSED at high sigma. A denoiser handed almost pure noise
            returns something close to the dataset mean, so the early
            predictions are a tight blob near the centroid - every atom inside
            every other atom's bonding distance. That is the case where a
            distance rule invents bonds rather than losing them.

    Frame 0 puts every atom at `tightness` of its true offset from the centroid
    - a blob a couple of Angstrom across - and the last frame is the structure.
    """
    header, rows = read_cif(src)
    idx = {name: i for i, name in enumerate(header)}
    xyz = [tuple(float(r[idx[c]]) for c in CARTN) for r in rows]
    cx = sum(q[0] for q in xyz) / len(xyz)
    cy = sum(q[1] for q in xyz) / len(xyz)
    cz = sum(q[2] for q in xyz) / len(xyz)
    out = list(ssbond_lines(src))
    for m in range(models):
        t = m / (models - 1) if models > 1 else 1.0
        # tight blob -> full structure, and the early steps are the point
        k = tightness + (1.0 - tightness) * (t ** 2)
        out.append(f"MODEL     {m + 1:>4}")
        for serial, r in enumerate(rows, 1):
            x0, y0, z0 = xyz[serial - 1]
            x = cx + (x0 - cx) * k
            y = cy + (y0 - cy) * k
            z = cz + (z0 - cz) * k
            name = r[idx["label_atom_id"]].strip('"')
            name = f" {name:<3}" if len(name) < 4 else name
            out.append(
                f"ATOM  {serial % 100000:>5} {name:<4} {r[idx['label_comp_id']]:>3}"
                f" {r[idx['auth_asym_id']][:1]:1}{r[idx['auth_seq_id']]:>4}    "
                f"{x:>8.3f}{y:>8.3f}{z:>8.3f}{1.0:>6.2f}{0.0:>6.2f}"
                f"{'':10}{r[idx['type_symbol']]:>2}")
        out.append("ENDMDL")
    out.append("END")
    open(dst, "w").write("\n".join(out) + "\n")
    print(f"{dst}  models={models}  atoms/model={len(rows)}"
          f"  (COLLAPSED at step 0: every atom inside every other's bond radius)")


def emit_diffusion(src, dst, models=16, seed=7, sigma_max=40.0,
                   sigma_min=0.05, rho=7.0):
    """A DIFFUSION trajectory: noise at step 0, the structure at the last step.

    This is the shape a sampler actually produces - localfold's ESMFold2 and
    AF3 heads both run an EDM sampler - and it is the case every distance-based
    rule in this viewer is worst at, because the early steps are not a molecule
    yet. They are a cloud with the right number of atoms in it.

    🔴 SYNTHETIC, AND SAYING SO. A real trajectory needs a GPU and six minutes;
    this is the native coordinates plus a fixed noise draw scaled by the Karras
    sigma schedule (rho=7), which reproduces the GEOMETRY STATISTICS the viewer
    trips over - consecutive CAs metres apart at step 0, everything within
    bonding distance of everything - without pretending to be a fold. If a rule
    holds here it holds on the real thing for the same reason; if it fails here
    it fails there sooner.

    🔴 AND THE NOISE DIRECTION IS FIXED, not redrawn per step. A real sampler
    re-noises, which makes consecutive frames jump; holding the direction and
    shrinking sigma gives a trajectory that CONVERGES smoothly, so anything
    that churns frame to frame here is the viewer's rule churning and not the
    input. That is the point of the fixture.
    """
    import random
    header, rows = read_cif(src)
    idx = {name: i for i, name in enumerate(header)}
    rng = random.Random(seed)
    noise = [(rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1)) for _ in rows]
    a = sigma_max ** (1.0 / rho)
    b = sigma_min ** (1.0 / rho)
    out = list(ssbond_lines(src))
    for m in range(models):
        t = m / (models - 1) if models > 1 else 1.0
        sigma = (a + t * (b - a)) ** rho
        out.append(f"MODEL     {m + 1:>4}")
        for serial, r in enumerate(rows, 1):
            x, y, z = (float(r[idx[c]]) for c in CARTN)
            nx, ny, nz = noise[serial - 1]
            x += nx * sigma; y += ny * sigma; z += nz * sigma
            name = r[idx["label_atom_id"]].strip('"')
            name = f" {name:<3}" if len(name) < 4 else name
            out.append(
                f"ATOM  {serial % 100000:>5} {name:<4} {r[idx['label_comp_id']]:>3}"
                f" {r[idx['auth_asym_id']][:1]:1}{r[idx['auth_seq_id']]:>4}    "
                f"{x:>8.3f}{y:>8.3f}{z:>8.3f}{1.0:>6.2f}{0.0:>6.2f}"
                f"{'':10}{r[idx['type_symbol']]:>2}")
        out.append("ENDMDL")
    out.append("END")
    open(dst, "w").write("\n".join(out) + "\n")
    print(f"{dst}  models={models}  atoms/model={len(rows)}"
          f"  sigma {sigma_max:g} -> {sigma_min:g}  (NOISE at step 0)")


def emit_unfolding(src, dst, models=30):
    """The OTHER kind of trajectory, and the reason stableTopology is opt-in.

    Frame k blends the native coordinates towards an extended chain, so the
    fold - and with it the secondary structure - is different in every frame.
    Keeping frame 0's assignment across this one is wrong, and
    tests/stable_topology.py asserts that it is wrong rather than trusting the
    argument.
    """
    header, rows = read_cif(src)
    idx = {name: i for i, name in enumerate(header)}
    seq = {}
    for r in rows:
        key = (r[idx["auth_asym_id"]], r[idx["auth_seq_id"]])
        if key not in seq:
            seq[key] = len(seq)
    out = list(ssbond_lines(src))
    for m in range(models):
        t = m / (models - 1)
        out.append(f"MODEL     {m + 1:>4}")
        for serial, r in enumerate(rows, 1):
            x, y, z = (float(r[idx[c]]) for c in CARTN)
            k = seq[(r[idx["auth_asym_id"]], r[idx["auth_seq_id"]])]
            # ...towards a straight line at 3.8 A a residue along x.
            ex, ey, ez = 3.8 * k, 0.0, 0.0
            x, y, z = (x + (ex - x) * t, y + (ey - y) * t, z + (ez - z) * t)
            name = r[idx["label_atom_id"]].strip('"')
            name = f" {name:<3}" if len(name) < 4 else name
            out.append(
                f"ATOM  {serial % 100000:>5} {name:<4} {r[idx['label_comp_id']]:>3}"
                f" {r[idx['auth_asym_id']][:1]:1}{r[idx['auth_seq_id']]:>4}    "
                f"{x:>8.3f}{y:>8.3f}{z:>8.3f}{1.0:>6.2f}{0.0:>6.2f}"
                f"{'':10}{r[idx['type_symbol']]:>2}")
        out.append("ENDMDL")
    out.append("END")
    open(dst, "w").write("\n".join(out) + "\n")
    print(f"{dst}  models={models}  atoms/model={len(rows)}  (fold CHANGES)")


def emit_synthetic(n, dst, models=20, amp=None, seed=0):
    """A trajectory of a chain that does not exist, at whatever size is asked.

    🔴 SYNTHETIC BECAUSE THE REAL ONES STOP AT 3,361 RESIDUES. The largest
    structure in this repository is 9FOG, and the question "does a 10,000
    residue protein animate" cannot be answered by extrapolating from 494.
    tests/make_bench.py has made synthetic chains for the render benchmarks for
    the same reason, and this is its make_chain with a trajectory around it:
    alternating helical runs and loops, so the assignment produces a realistic
    mix of stations rather than one uniform element.
    """
    import numpy as np
    rng = np.random.default_rng(seed)
    pts = []
    pos = np.zeros(3)
    i = 0
    while i < n:
        if rng.random() < 0.65:
            run = min(int(rng.integers(8, 25)), n - i)
            t = np.arange(run) * np.deg2rad(100.0)
            local = np.stack([2.30 * np.cos(t), 2.30 * np.sin(t),
                              1.50 * np.arange(run)], axis=1)
        else:
            run = min(int(rng.integers(4, 12)), n - i)
            step = rng.normal(size=(run, 3))
            step /= np.linalg.norm(step, axis=1, keepdims=True)
            local = np.cumsum(step * 3.8, axis=0)
        q = rng.normal(size=(3, 3))
        qq, _ = np.linalg.qr(q)
        local = local @ qq
        local = local - local[0] + pos
        pts.append(local)
        pos = local[-1] + rng.normal(size=3) * 0.5
        i += run
    xyz = np.concatenate(pts, axis=0)[:n]
    xyz = xyz - xyz.mean(axis=0)
    # 🔴 THE BREATH HAS TO BE VISIBLE AT THE ZOOM THE STRUCTURE IS DRAWN AT.
    # 0.45 A is a clear motion on ubiquitin and invisible on a chain ten times
    # the size, because the camera fits the whole thing: at 2,500 residues
    # consecutive frames differed by 0.1% of pixels, which is below what any
    # comparison here can see. Scaled to the structure's own extent instead.
    if amp is None:
        amp = max(0.45, float(np.abs(xyz).max()) * 0.02)
    out = list(ssbond_lines(src))
    for m in range(models):
        ph = 2 * math.pi * m / models
        out.append(f"MODEL     {m + 1:>4}")
        for k in range(n):
            x, y, z = xyz[k]
            x += amp * math.sin(2 * math.pi * k / 900 + ph)
            y += amp * math.sin(2 * math.pi * k / 1100 + ph * 1.3)
            z += amp * math.sin(2 * math.pi * k / 1300 + ph * 0.7)
            out.append(
                f"ATOM  {(k + 1) % 100000:>5}  CA  ALA A{(k + 1) % 10000:>4}    "
                f"{x:>8.3f}{y:>8.3f}{z:>8.3f}{1.0:>6.2f}{0.0:>6.2f}"
                f"{'':10}{'C':>2}")
        out.append("ENDMDL")
    out.append("END")
    open(dst, "w").write("\n".join(out) + "\n")
    print(f"{dst}  models={models}  residues={n}")


def emit_flicker(dst, n=60, models=12, at=30):
    """A chain with ONE bond sitting on the connectivity threshold.

    🔴 THE SMALLEST THING THAT REPRODUCES THE HITCH. Connectivity between
    protein alpha carbons is a distance test at 5.0 A with no hysteresis, so a
    pair near it crosses back and forth as a structure breathes - and every
    crossing changes the segment count, breaks the ribbon, and throws away every
    cache keyed on the geometry. On a real 3,348-residue trajectory that was two
    frames in fifteen at 200 ms against 25; here it is one pair, on purpose, so
    a gate can watch it without a four-megabyte fixture.

    Residue `at` steps away from its neighbour and back across the threshold;
    everything else is a straight chain at 3.8 A.
    """
    out = list(ssbond_lines(src))
    for m in range(models):
        gap = 4.6 + 0.8 * (m % 2)          # 4.6 A then 5.4 A: under, then over
        out.append(f"MODEL     {m + 1:>4}")
        x = 0.0
        for k in range(n):
            step = gap if k == at else 3.8
            if k: x += step
            out.append(
                f"ATOM  {k + 1:>5}  CA  ALA A{k + 1:>4}    "
                f"{x:>8.3f}{0.0:>8.3f}{0.0:>8.3f}{1.0:>6.2f}{0.0:>6.2f}"
                f"{'':10}{'C':>2}")
        out.append("ENDMDL")
    out.append("END")
    open(dst, "w").write("\n".join(out) + "\n")
    print(f"{dst}  models={models}  residues={n}  (one bond crosses 5.0 A)")


if __name__ == "__main__":
    ca = "--ca" in sys.argv
    amps = [a for a in sys.argv[1:] if a.startswith("--amp=")]
    amp = float(amps[0].split("=", 1)[1]) if amps else 0.45
    nmod = [a for a in sys.argv[1:] if a.startswith("--models=")]
    models = int(nmod[0].split("=", 1)[1]) if nmod else 30
    big = [a for a in sys.argv[1:] if a.startswith("--n=")]
    if big:
        for a in big:
            n = int(a.split("=", 1)[1])
            emit_synthetic(n, f"_traj_syn{n}.pdb")
        sys.exit(0)
    if "--collapsed" in sys.argv:
        for src in ([a for a in sys.argv[1:] if not a.startswith("--")]
                    or ["3CHY.cif"]):
            emit_collapsed(src, "_traj_collapsed_"
                           + src.split(".")[0].lower() + ".pdb", models=models)
        sys.exit(0)
    if "--diffusion" in sys.argv:
        for src in ([a for a in sys.argv[1:] if not a.startswith("--")]
                    or ["3CHY.cif"]):
            emit_diffusion(src, "_traj_diffusion_"
                           + src.split(".")[0].lower() + ".pdb", models=models)
        sys.exit(0)
    named = [a for a in sys.argv[1:] if not a.startswith("--")]
    if named:
        for src in named:
            emit(src, "_traj_" + src.split(".")[0].lower() + ".pdb",
                 models=models, amp=amp, ca_only=ca)
    else:
        for src in ("3CHY.cif", "1TIM.cif", "1AOI.cif"):
            emit(src, "_traj_" + src.split(".")[0].lower() + ".pdb")
        emit_unfolding("3CHY.cif", "_traj_unfold.pdb")
        # ...and a sampler-shaped one, which is what every distance-based rule
        # in the viewer is worst at: step 0 is a cloud, not a molecule.
        emit_diffusion("3CHY.cif", "_traj_diffusion.pdb")
        # ...and a nucleic one, for the base plates: they are rib prims built by
        # a different emitter, and no protein trajectory exercises them.
        emit("1EHZ.cif", "_traj_1ehz.pdb", models=8, amp=0.45)
        emit_flicker("_traj_flicker.pdb")
