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
  for f in py2Dmol/resources/viewer-mol.js py2Dmol/resources/viewer-cartoon.js \
           py2Dmol/resources/viewer-cartoon-gpu.js py2Dmol/resources/viewer-pae.js \
           py2Dmol/resources/viewer-seq.js; do
    npx terser "$f" -c -m -o "${f%.js}.min.js" || { print "terser failed: $f"; exit 1 }
  done
  for f in interaction smoke sequence copy_selection sidechain_chain na_frame; do
    out=$(node tests/$f.js 2>&1)
    if print -r -- "$out" | grep -q '^FAIL'; then
      fail=1; print "NODE $f:"; print -r -- "$out" | grep '^FAIL' | head -3
    else
      print "node $f: ok"
    fi
  done
  # ...and the minified bundles draw the same picture as the sources
  node tests/smoke.js py2Dmol/resources/viewer-cartoon.min.js >/dev/null 2>&1 \
    && print "node smoke (min): ok" || { fail=1; print "NODE smoke (min): FAILED" }
fi

run_probe () {   # name, then its arguments
  local name=$1; shift
  local log=/tmp/py2dmol-test-$name.log
  if python3 tests/$name.py "$@" >$log 2>&1; then
    print "probe $name: ok"
  else
    print "PROBE $name: FAILED"; grep -E '^FAIL|error' $log | head -3; return 1
  fi
}

if [[ "$LANE" == "all" || "$LANE" == "ui" ]]; then
  UI=(pick_empty pae_objects pae_visibility hidden_reload cut_ligands
      sidechain_toggle nucleic_multi save_multi selection_panel minimal_input
      object_reload python_page style_per_object)
  pids=(); names=()
  for t in $UI; do
    ( run_probe $t ) & pids+=($!); names+=($t)
    # ...at most JOBS at a time: every one of them is a browser
    while (( $(jobs -r | wc -l) >= JOBS )); do sleep 0.2; done
  done
  ( run_probe multi_object 1BBH.cif 1EHZ.cif ) & pids+=($!); names+=(multi_object)
  for p in $pids; do wait $p || fail=1; done
fi

if [[ "$LANE" == "all" || "$LANE" == "gpu" ]]; then
  for t in gpu_recolour gpu_mesh_reuse gpu_tube_reuse gpu_mixed_style; do
    run_probe $t || fail=1
  done
fi

print "=== $( (( fail == 0 )) && print ALL GREEN || print SOMETHING FAILED )"
exit $fail
