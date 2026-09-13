# A restored mesh and the station table it is drawn from

**Status: FIXED.** `captureMesh` keeps the station table as data, and a restore
makes the live GL objects from it. `tests/station_restore.py` is the gate.

## Reproduce

Load 1YNE (a 31-nucleotide RNA hairpin, 20 models). On the side-chain row press
**Hide**, then **Plate**, then **Hide** — or **Hide, Show, Hide**. Before the
fix the hairpin came back as two large translucent spheres and a handful of
stray lines.

```
python3 tests/station_restore.py
```

It was **not** introduced by the three-way Show/Hide/Plate control: it
reproduces at `eefdd66` through the Show/Hide pair and Plate checkbox that
control replaced.

## What it was not

- **Not the outline.** Forcing `cartoonInk = false` changed nothing; the wrong
  shapes were in the fill.
- **Not the selection mark.** Clearing the selection left them.
- **Not the geometry.** The 2D painter drew every one of those states
  correctly.
- **Not the cache keys, and not a missing invalidate.** Every count, key and
  mapping agreed on the broken frame.

## What it was

A station table is CPU arrays — the per-face mapping, the static rows, the
padded geometry — plus **three GL handles**: the row buffer and the station and
piece textures. On the station path the ribbon's instance rows are never built
(`rowsUnused`), so every corner the card draws comes from that table.

The card owns ONE live set of those objects. `installStations` begins with
`clearResidentStations()`, which deletes it.

`captureMesh` kept the table with the mesh as

```js
residentStations: residentStations ? Object.assign({}, residentStations) : null,
```

which copied the **handles** along with the arrays. The build that followed
deleted the objects those handles named. So every mesh in the Tier-1 cache was
holding a table whose buffer and textures no longer existed, and `restoreMesh`
handed that table back:

```
press 1  Hide    rebuild   table live
press 2  Plate   rebuild   table live       <- deletes press 1's GL objects
press 3  Hide    RESTORE   table live=FALSE <- press 1's table, dead handles
```

Nothing noticed, because every guard on the fast path reads the **arrays**,
which were intact: the mapping matched, the counts matched, `stale` was false.
`updateStations` wrote into a deleted texture, which WebGL no-ops without an
error, and the draw bound objects that were gone. `activateMesh` also assigned
the cached table only when there was one, so a mesh cached without a table left
the outgoing table beside it.

It read as a cache or key fault for three rounds, because a forced
`invalidate()` — which throws both halves away — always fixed the picture. What
separated it was asking the card: `stationsResident().live`, which calls
`gl.isBuffer` / `gl.isTexture` on the table's own handles.

## The fix

The cache holds a **snapshot**: every field of the table except the three
handles (`stationsSnapshot`). A restore makes the live set from it
(`activateStations`) — always, whether or not the cached mesh had a table —
through the same `stationTexture` allocation a build uses. That is how
`activateMesh` already treated the fill and the edges: CPU arrays kept, GL
objects re-uploaded. The live table's pads are copied, because
`updateStations` writes into them in place and the snapshot stays in the cache
after a restore.

So the card's objects always belong to exactly one table, the live one, and
there is nothing in the cache for a delete to leave dangling.

## What it costs, measured

The cost is paid on a mesh **exchange** — one buffer upload and two texture
allocations of data already in hand — never on a frame step, which does not
exchange meshes.

| | before | after |
|---|---|---|
| 1YNE, H·P·H, third press | station path, **dead table**, wrong picture | **station path**, live table, 0 px from a rebuild |
| 1YNE, H·S·H, third press | station path, **dead table**, wrong picture | **station path**, live table, 0 px from a rebuild |
| 1TIM trajectory, 20 steps | 0 ribbon rebuilds, 19 station steps | 0 ribbon rebuilds, 19 station steps |
| 1TIM + side chains, 20 steps | 0 / 19 | 0 / 19 |
| 1EHZ trajectory, 12 steps | 3 / 8 | 3 / 8 |

The returning press stays on the station path — the point of the cache — rather
than becoming a rebuild.

🔴 **AND `invalidate()` WAS NOT THE FIX.** Calling
`py2dmolCartoonGPU.invalidate()` from `setBasesFor` and `_setSidechains` made
the pictures correct and was measured and removed: it works by never letting a
restore happen, which is rebuilding to avoid a wrong update — the thing the
station path exists to stop — and it covered only the two doors that had been
found.

## The gate

`tests/station_restore.py` presses the real buttons for H·P·H and H·S·H and
asserts all four of: the third press takes the **station path**; the table is
**live** on every press; the picture equals the same state **rebuilt**; and the
same comparison against a **different** state reports a large difference, so
"matches" cannot mean "cannot see". Mutated back to the shallow copy, it fails
on `live`.

## Unrelated, found on the way

`tests/station_integrated.py` FAILS on `main` and is **not in `tests/run.sh`**,
which is why every green suite misses it. Its counts are healthy — the path is
taken 22/33 with 0 rebuilds — and what it reports is that the station path
measures SLOWER than a plain rebuild on these small trajectories (13.60 ms
against 6.90 on `_traj_1tim.pdb`), and that `_traj_unfold.pdb` draws 0.124% of
its pixels differently from the same frame rebuilt. That last one is the thing
`docs/FRAME_STABILITY.md` already names as shipping unchecked.
