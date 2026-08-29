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
  for f in interaction smoke sequence copy_selection sidechain_chain na_frame align paint_trace math config; do
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
probe_cap () {
  case $1 in
    (embed) print 240 ;;
    (colab) print 160 ;;
    (focus_mode) print 120 ;;
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
  UI=(pick_empty selection_mark focus_mode hover_echo pae_objects pae_visibility hidden_reload cut_ligands
      sidechain_toggle nucleic_multi save_multi selection_panel minimal_input
      object_reload python_page python_multi style_per_object align_objects embed panel)
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
  for t in gpu_recolour gpu_mesh_reuse gpu_tube_reuse gpu_mixed_style gpu_stick_flat; do
    run_probe $t || fail=1
  done
fi

print "=== $( (( fail == 0 )) && print ALL GREEN || print SOMETHING FAILED )"
exit $fail
