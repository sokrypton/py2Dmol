#!/bin/zsh
# THE SUITE, IN LANES AND IN PARALLEL.
#
#   tests/run.sh          everything (the default)
#   tests/run.sh node     the node checks alone - seconds, no browser
#   tests/run.sh ui       the browser probes that drive the app
#   tests/run.sh gpu      the GPU probes, which time themselves and so run alone
#
# WHY LANES. The node checks are 3 seconds and catch most regressions in the
# code they read; the browser probes cost 3-4 seconds of Chrome start each
# before they measure anything. Running what you touched is the point.
#
# WHY PARALLEL. Each probe is its own process, its own port and its own Chrome
# profile, so they do not interact - except the GPU ones, which MEASURE TIME
# ("the reused toggles are not faster than the builds") and would be timing
# each other's contention. Those run one at a time, after the rest.
# 🔴 THE UI LANE FAILS ABOUT ONE RUN IN SIX, AND IT IS NOT THE PARALLELISM.
#
# A probe reports "page error: no result posted" or is KILLED, passes on its own
# a moment later, and a different probe fails next time. The obvious reading is
# contention between six Chromes, and it was asserted several times before it
# was measured. It is wrong. Alternating whole-lane runs on the same machine:
#
#     JOBS=6   0, 0, 0 failures     68s, 78s, 77s
#     JOBS=1   1, 0, 0 failures     70s, 76s, 65s
#     JOBS=3   2, 0                 79s, 77s
#     JOBS=2   0                    69s
#
# Same failure rate serial as six-way, and the same wall time - the lane is
# ~70s either way, so the parallelism is not buying much either. Whatever the
# cause is, it is not how many browsers are running.
#
# WHAT TO DO WITH A FAILURE, THEN: run that probe on its own. If it passes, it
# is this. If it fails, it is real. Do not lower JOBS and conclude anything
# from one green run, and do not attribute it to load without measuring - that
# reasoning cost most of a session.
#
# 🔴 AND FAILS ON DRIFT, NOT ONLY ON CONTENTION. It asserts
# the fast path is FASTER, and on _traj_1ehz.pdb - 85 residues - both arms are
# under 2 ms, so a 5% wobble reads as "2.00 ms against 1.90 - it is not
# faster". Run it alone and look at the MARGIN: 1.4x to 2.0x is healthy, and a
# genuine regression takes the ratio to about 1.0 on every structure it tests,
# not on the smallest one only.
set -u
cd "$(dirname "$0")/.."
LANE="${1:-all}"
JOBS="${JOBS:-6}"
fail=0

if [[ "$LANE" == "all" || "$LANE" == "node" ]]; then
  # WHICH FILES, from tools/bundle.py rather than a copy of the list. This loop
  # named five sources by hand: it built viewer-seq.js, which nothing consumes,
  # and never built viewer-scatter.js, which viewer.py inlines - so the notebook
  # could ship a scatter bundle older than its source and no test would know.
  python3 tools/bundle.py build >/dev/null || { print "bundle build failed"; exit 1 }
  # THE EXIT STATUS COUNTS, NOT JUST THE WORD "FAIL".
  #
  # This grepped for a line starting with FAIL and reported everything else as
  # ok. A test that CRASHED - a lift that could not find its target, a syntax
  # error, a missing file - prints a stack trace containing no such line, and
  # was reported as passing. tests/interaction.js died on startup for a whole
  # commit that way, and the suite said ALL GREEN.
  for f in interaction smoke sequence copy_selection sidechain_chain covalent_links short_peptide na_frame align paint_trace cartoon_station station_faces math config msa_paired heatmap_resolve cyclic_partner cyclic_bench; do
    out=$(node tests/$f.js 2>&1); rc=$?
    if (( rc != 0 )); then
      fail=1; print "NODE $f: exit $rc"
      print -r -- "$out" | grep -E '^FAIL|Error' | head -3
    else
      print "node $f: ok"
    fi
  done
  # ...and the five hand-maintained lists of which JS files exist still agree
  # with the one manifest they are supposed to derive from.
  if python3 tools/bundle.py check >/dev/null 2>&1; then
    print "node manifest: ok"
  else
    fail=1; print "NODE manifest:"; python3 tools/bundle.py check 2>&1 | grep '^FAIL' | head -3
  fi

  # ...and every resource viewer.py opens is one setup.py ships. Static, so it
  # costs nothing; the wheel it protects is built by CI, where no revision
  # control plugin covers for a package_data omission.
  if python3 tests/packaging.py >/dev/null 2>&1; then
    print "node packaging: ok"
  else
    fail=1; print "NODE packaging:"; python3 tests/packaging.py 2>&1 | grep '^FAIL' | head -3
  fi

  # ...and a grid emits ONE output. Grid.view() said "do not show yourself" by
  # setting _is_live, which also means "you are on the page" - so every add()
  # during collection wrote an update for a viewer that did not exist yet, and
  # a four-viewer grid came to twenty-eight outputs. No browser: the count is
  # the whole of the fault.
  if python3 tests/grid.py >/dev/null 2>&1; then
    print "node grid: ok"
  else
    fail=1; print "NODE grid:"; python3 tests/grid.py 2>&1 | grep -E '^FAIL|^  -' | head -3
  fi

  # ...and a ribose-bearing cofactor is a LIGAND, not a nucleotide. SAM, ATP
  # and NAD all carry one, and the structural test that keeps 1EHZ's modified
  # bases in its chain collapsed them onto a single position - twenty-seven
  # atoms drawn as one sphere.
  if python3 tests/parse_ligand.py >/dev/null 2>&1; then
    print "node parse_ligand: ok"
  else
    fail=1; print "NODE parse_ligand:"; python3 tests/parse_ligand.py 2>&1 | grep -E '^FAIL|^  -' | head -3
  fi

  # ...and the three spellings of a contact agree, including the one that can
  # only ever draw nothing. No browser: this is the Python side of the payload,
  # and the fault was that nothing between the caller and mol.js knew which
  # form it was looking at.
  if python3 tests/contacts_forms.py >/dev/null 2>&1; then
    print "node contacts_forms: ok"
  else
    fail=1; print "NODE contacts_forms:"; python3 tests/contacts_forms.py 2>&1 | grep -E '^FAIL|^  -' | head -3
  fi

  # ...and every probe in tests/ is named in tests/README.md, with the lane
  # that runs it. Sixty-nine of about ninety were in it nowhere, which is how a
  # gate can sit outside run.sh for a session while three files measure the
  # same property. Generated and checked, because a hand-written index of
  # ninety files is wrong within a week.
  if python3 tests/index.py --check >/dev/null 2>&1; then
    print "node index: ok"
  else
    fail=1; print "NODE index:"; python3 tests/index.py --check 2>&1 | head -4
  fi

  # ...and every path a comment or a doc points a reader at still exists. The
  # rename that split the renderer left 236 wrong pointers behind, and nothing
  # in the suite could tell.
  if python3 tests/paths.py >/dev/null 2>&1; then
    print "node paths: ok"
  else
    fail=1; print "NODE paths:"; python3 tests/paths.py 2>&1 | grep '^FAIL' | head -3
  fi

  # ...and every SHIPPED BUNDLE puts the right names on the page and none of the
  # wrong ones. This replaced running smoke.js against the notebook bundle,
  # which cannot work now that the bundle is GPU-only: node has no WebGL2, so it
  # correctly draws nothing here. The picture is checked where a picture can
  # exist - minimal_input.py for the notebook bundle, embed.py for the embed,
  # multi_object.py for the web one.
  if node tests/bundles.js >/dev/null 2>&1; then
    print "node bundles: ok"
  else
    fail=1; print "NODE bundles:"; node tests/bundles.js 2>&1 | grep '^FAIL' | head -3
  fi
fi

# A BACKSTOP KILL, at twice the probe's own deadline. Each probe caps its wait
# and parses its page script before starting a browser, so a hang should be
# impossible - but "should be impossible" is exactly what the 400-second stalls
# were, and a suite that can hang is a suite nobody runs.
CAP="${CAP:-60}"
# ...in half-seconds, so 60 is thirty wall-clock. TWO PROBES NEED LONGER, and
# say so here rather than by raising the ceiling for everything: tests/embed.py
# drives its own eight viewers and then every live example on embed.html, which
# is eleven more. Killed at thirty seconds it reported "no .canvas-box viewers
# found" - what an unfinished page looks like, and nothing to do with the page.
# tests/colab.py starts SIX browsers one after another, because each one is a
# different arrival order of the same cell outputs and they cannot share a page.
# ...and tests/focus_mode.py drives EIGHT legs through two structures, with a
# camera flight to wait out at nearly every step: 18 s alone, and the parallel
# lane doubles it. Killed at thirty it reported "no result posted", which is
# what an unfinished page looks like and nothing to do with the page - the same
# disguise the note above describes.
# ...and tests/mobile_layout.py loads the page at FIVE viewport widths and then
# resizes it at three more, each a full reload of index.html's 34 scripts. It is
# 6.7 s alone and was killed at thirty in the parallel lane, where six browsers
# are up at once - reported once as a strip "924 logical px in a 0px box", which
# is a measurement taken before the layout settled rather than a broken layout.
# The same disguise a third time: what these three share is that the cap fires
# during setup and the probe reports whatever the half-built page said.
probe_cap () {
  case $1 in
    (embed) print 240 ;;
    # both build a mesh per value of several controls, so they are long by
    # construction rather than by being slow
    (topology_survey) print 300 ;;
    (station_controls) print 300 ;;
    (rebuild_actions) print 240 ;;
    (rebuild_returns) print 300 ;;
    (render_counts) print 240 ;;
    (diffusion_connectivity) print 300 ;;
    # 10,800 points, each picked twice, on three structures
    (pick_index) print 400 ;;
    (halo_partial) print 300 ;;
    (load_work) print 200 ;;
    (station_unpinned) print 400 ;;
    (panel_idle) print 200 ;;
    (frame_share) print 240 ;;
    (colour_cache) print 300 ;;
    (ss_agree) print 300 ;;
    (splice_window) print 300 ;;
    (station_rows) print 300 ;;
    (station_edges) print 300 ;;
    (outline_sync) print 400 ;;
    (capture_once) print 240 ;;
    (arrow_rebuilds) print 300 ;;
    # three structures, and a mesh built per letter edit on each
    (ss_axis) print 300 ;;
    # three sizes, each with a reuse, a floor, a control and a rebuild
    (resize_reuse) print 300 ;;
    # six frames out and back, a picture captured at every step
    (frame_revisit) print 300 ;;
    (colab) print 160 ;;
    (focus_mode) print 120 ;;
    (mobile_layout) print 120 ;;
    # 🔴 RAISING A CAP TO CURE CONTENTION MAKES IT WORSE, measured: capping
    # selection_panel and align_objects up took the ui lane from two "no result
    # posted" to FIVE. A higher cap does not make a probe finish, it lets a
    # struggling one hold its slot longer, so the lane stays congested for
    # longer and the next probe is the one that is killed. The three heavy
    # probes that caused the congestion run in the serial lane instead - see
    # export_html, opacity and default_object there.
    (export_html) print 300 ;;
    (default_object) print 300 ;;
    (opacity) print 200 ;;
    (python_opacity) print 200 ;;
    (named_object) print 200 ;;
    (*) print $CAP ;;
  esac
}
run_probe () {   # name, then its arguments
  local name=$1; shift
  local log=/tmp/py2dmol-test-$name.log
  local cap=$(probe_cap $name)
  python3 tests/$name.py "$@" >$log 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 $pid 2>/dev/null && (( waited < cap )); do
    sleep 0.5; waited=$((waited + 1))
  done
  if kill -0 $pid 2>/dev/null; then
    kill -9 $pid 2>/dev/null
    print "PROBE $name: KILLED after $((cap / 2))s"; return 1
  fi
  if wait $pid; then
    print "probe $name: ok"
  else
    print "PROBE $name: FAILED"; grep -E '^FAIL|error|does not parse' $log | head -3; return 1
  fi
}

if [[ "$LANE" == "all" || "$LANE" == "ui" ]]; then
  UI=(pick_empty selection_mark focus_mode hover_echo heatmap_objects heatmap_visibility hidden_reload cut_ligands
      sidechain_toggle nucleic_multi save_multi selection_panel minimal_input
      object_reload python_page python_multi style_per_object align_objects embed panel
      msa_paired_ui selection_shells mobile_layout notebook_narrow play_stop heatmap_maps heatmap_names
      render_page frame_policy)
  pids=(); names=()
  for t in $UI; do
    ( run_probe $t ) & pids+=($!); names+=($t)
    # ...at most JOBS at a time: every one of them is a browser
    while (( $(jobs -r | wc -l) >= JOBS )); do sleep 0.2; done
  done
  ( run_probe multi_object 1BBH.cif 1EHZ.cif ) & pids+=($!); names+=(multi_object)
  ( run_probe multi_frame_fit ) & pids+=($!); names+=(multi_frame_fit)
  for p in $pids; do wait $p || fail=1; done

  # ...and then colab, ALONE. Not because it measures time - it does not - but
  # because it is six browsers back to back, each holding four iframes of half
  # a megabyte, and run in the batch above it starved tests/embed.py into a
  # timeout. A probe heavy enough to change its neighbours' results is a probe
  # that has to run by itself.
  run_probe colab || fail=1
fi

if [[ "$LANE" == "all" || "$LANE" == "gpu" ]]; then
  for t in multi_step gpu_recolour gpu_mesh_reuse gpu_tube_reuse gpu_mixed_style gpu_stick_flat disulfides sequence_connectivity dev_rebuild_light colour_repaint station_shader station_corners station_pixels station_frames station_foldcuts station_overlay station_sidechains topology_survey station_controls rebuild_actions rebuild_returns render_counts diffusion_connectivity pick_index halo_partial load_work station_unpinned panel_idle frame_share colour_cache ss_agree splice_window station_rows station_edges sheet_merge outline_sync capture_once arrow_rebuilds ss_axis resize_reuse frame_revisit export_html opacity default_object python_opacity named_object; do
    run_probe $t || fail=1
  done
  # ...and the same file again with a TAIL in it: 1EHZ's nine ions are rebuilt
  # at the mesh's own scale and cannot follow a canvas change, so the path has
  # to stand down there. Both directions of that are the claim.
  run_probe resize_reuse 1EHZ.cif || fail=1
fi

print "=== $( (( fail == 0 )) && print ALL GREEN || print SOMETHING FAILED )"
exit $fail
