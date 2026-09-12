# Frame-to-frame stability — the clean slate

**Status: NOTHING SHIPPED.** Keep SSE was removed in `0a523bd` to clear the
ground for a better mechanism, not because the problem went away. The problem is
real and measured; this file is what the next attempt should read first, so that
it starts from the dead ends rather than rediscovering them.

## The problem, stated without a solution in it

A trajectory's frames are the same molecule moving. Three answers the cartoon
needs — the secondary-structure assignment, the base pairing, the sheet frames —
are about *which residues these are and how they are connected*, not about where
they currently sit. They are recomputed for every frame anyway, because the
cache key names the frame.

Worse than the recomputation: the answers **change**. Connectivity is inferred
from a bare distance — 5.0 Å between protein alpha carbons, no hysteresis — so a
pair sitting near the threshold crosses it as the structure breathes. Measured
on a 3,348-residue trajectory the segment count goes 3336 → 3337 → 3336, twice
every fifteen frames. The ribbon visibly breaks and rejoins, the face list
changes, and the station fast path's face-to-station mapping stops matching, so
the frame rebuilds instead of uploading two textures.

## What Keep SSE did, and what it cost

It set `stableTopology`, which did three separate things: swapped the cache key
for one that does not name the frame (`_topologyKey`), exempted four caches from
a blanket clear, and relaxed the segment-index cache to hold across frames.

It worked. With it, the station fast path ran on nearly every step; without it:

| fixture | steps on the fast path | speed | picture |
|---|---|---|---|
| `_traj_1tim.pdb` | 22 of 33 | 1.05x / 0.93x — inside the drift | ok |
| `_traj_unfold.pdb` | 22 of 33 | 1.47x / 0.92x | **0.083% of pixels differ** |
| `_traj_1ehz.pdb` | 16 of 33, **6 rebuilds** | 0.89x / 0.52x | ok |

What it cost was a **promise the caller could not verify**. "These frames are one
molecule moving" is true of an MD run, an NMR ensemble and a morph, and false of
a folding trajectory — which is the same objects, the same length and a
different fold in every frame. Nothing in the renderer can tell those apart: a
fingerprint able to notice the fold changing costs about what the assignment
costs, since it is the same CA–CA distance set. So it was opt-in, and an opt-in
correctness promise is a mode that is wrong whenever the reader is wrong.

## 🔴 Do not start by pinning the assignment. It is not what paid.

Measured directly, before the removal. The current frame's letters were written
into `obj.sse` for all 494 protein positions of `_traj_1tim.pdb` — a provably
pinned assignment, **0 letters differing** across a frame step, `forcedSseFor`
confirming the overrides were registered — and the mesh **still rebuilt twice**
over twelve frames, exactly as with no pinning at all.

Then the flag was split into its two halves and each measured alone:

| arm | rebuilds over 12 frames | mesh shapes |
|---|---|---|
| nothing | 2 | 2 |
| the whole flag | **0** | **1** |
| the cache-key/clear half alone | 2 | 2 |
| the segment-cache half alone | 2 | 2 |
| letters pinned in `obj.sse`, no flag | 2 | 2 |

Neither half pays on its own, and the secondary structure is not the mechanism.
Sweeping one axis of a pair says the pair does not pay — the trap is worth
naming because it cost a round here.

## 🔴 Fix this first: the station path already draws the wrong frame

On `_traj_unfold.pdb` the station fast path draws a frame **0.083% different
from a rebuild of the same frame**, worst channel 222. The same numbers appear
on the commit *before* the removal with the pin taken away by hand, so this is
not a consequence of removing anything.

It ships. The station table **auto-enables** for any multi-frame object (the
`stationAuto` block in `cartoon/paintgl.js`), so a folding trajectory gets the
table without asking and nothing checks the result. `paintgl.js` asserted "the
picture is the same either way" and cited `tests/station_integrated.py` for it —
and that probe only ever ran the table *beside* the pin, so the claim it was
credited with was never tested. `station_integrated.py` is an instrument now
rather than a gate, for that reason; read it, do not trust its exit code.

Any stability work that makes the fast path run more often makes this worse.

## Where to start instead

**Hysteresis on the connectivity threshold.** The flicker is a threshold with no
memory: a pair at 4.99 Å is bonded and at 5.01 Å is not, and a breathing
structure crosses it repeatedly. A bond that has to travel a little further to
break than to form removes the flicker at its source. It needs no flag, no mode
and no promise from the reader — which is the whole objection to what was
removed — and it is the thing Keep SSE was papering over.

Two things it does not fix, so measure before assuming: the ribbon's
**subdivision** also moves with geometry (one interval resubdivided in the
trajectory above independently of any letter changing), and the **sheet frames**
are built on the ladders, which are geometric too.

## The instruments that exist

- `tests/station_integrated.py` — both arms over the same frames in one process,
  the picture compared pixel for pixel against a rebuild, and how often the path
  was taken. The 0.083% above comes from here.
- `tests/station_frames.py`, `tests/station_pixels.py` — the fast path's
  correctness and its cost, on fixtures whose topology holds.
- `tests/make_traj.py` — both kinds of trajectory: one that breathes
  (`--amp=`) and one that unfolds. `--amp=0.8` on `1EHZ.cif` is enough to move a
  nucleic structure's base pairing, which the gentler default does not.
- `tests/PERF_NOTES.md` — the measurements taken while the mode existed, marked
  as describing a removed path.

## What was kept, and why

`_topologyKey` in `parts/multi.js` — it is the station fast path's own
topological signature (`cartoon/paintgl.js`), not Keep SSE's, and removing it
would have taken the fast path with it. `set_basepairs` and `obj.pairs` — a
separate capability, declared in `OBJECT_STATE`, renumbered on Copy, and
measured reaching the picture. Only the mode's `_keptSse`/`_keptPairs` snapshots
went with it.
