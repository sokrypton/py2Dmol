"""What an edit leaves behind: the object's LIGAND GROUPS.

    python3 tests/cut_ligands.py

Ligand atoms are grouped into whole ligands once, when a frame is added, and
the map is a set of POSITION INDICES per group. Cut and Delete rewrite the
frames in place and renumber everything else keyed by position - the mask, the
side chains, the contacts, the MSA - but the ligand map was left in the old
numbering. Cut one chain out of 4HHB and the remaining object's ligands point
at whatever residues have moved into those slots: the strip stops collapsing
them to one token, and the viewer draws the atoms as loose spheres.

Checks the groups against the frame that is actually there: in range, all one
residue, all of them ligand atoms - before the cut, after it, and against the
same structure loaded fresh with that chain never present.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, threading, time, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, DEADLINE, check_js  # noqa: E402
ROOT="/Users/mini/Documents/GitHub/py2Dmol"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE=os.path.join(ROOT,"_cutlig.html")
JS="""
<script>
window.addEventListener('load', () => {
  const load = async (f) => {
    const txt = await (await fetch('/' + f)).text();
    await window.processFiles([{name: f, readAsync: () => Promise.resolve(txt)}], false);
  };
  // EVERY GROUP, SCORED AGAINST THE FRAME THAT IS THERE.
  const audit = (r, name) => {
    const o = r.objectsData[name];
    const f = o.frames[0];
    const n = f.coords.length;
    const types = f.position_types || [];
    const chains = f.chains || [];
    const nums = f.residue_numbers || [];
    const names = f.position_names || [];
    // DERIVED from the frame, not stored on the object - see
    // ligandGroupsForFrame in core/mol.js
    const groups = r.ligandGroupsOf(name) || new Map();
    let bad = [];
    let atoms = 0;
    for (const [key, idxs] of groups) {
      atoms += idxs.length;
      const seen = new Set();
      for (const i of idxs) {
        if (i < 0 || i >= n) { bad.push(key + ': index ' + i + ' of ' + n); continue; }
        if (types[i] !== 'L') bad.push(key + ': index ' + i + ' is a ' + types[i]);
        seen.add(chains[i] + '/' + nums[i] + '/' + names[i]);
      }
      if (seen.size > 1) bad.push(key + ': spans ' + Array.from(seen).join(' + '));
    }
    // ...and every ligand atom in the frame is in some group
    let loose = 0;
    const inGroup = new Set();
    for (const [, idxs] of groups) for (const i of idxs) inGroup.add(i);
    for (let i = 0; i < n; i++) if (types[i] === 'L' && !inGroup.has(i)) loose++;
    // ...AND THE BONDS THAT HOLD EACH LIGAND TOGETHER. They are position
    // indices like everything else, and the renderer reads them from the
    // OBJECT (see _resolvedFrame), not from the frame - so an edit that
    // renumbers the frames leaves them pointing anywhere. A ligand with no
    // bonds left is a handful of loose atoms drawn as spheres.
    const bonds = o.bonds || f.bonds || [];
    let outOfRange = 0;
    let crossResidue = 0;
    const perGroup = {};
    const groupOf = new Map();
    for (const [key, idxs] of groups) for (const i of idxs) groupOf.set(i, key);
    for (const b of bonds) {
      const [i, j] = b;
      if (i < 0 || j < 0 || i >= n || j >= n) { outOfRange++; continue; }
      const gi = groupOf.get(i);
      const gj = groupOf.get(j);
      if (gi && gi === gj) perGroup[gi] = (perGroup[gi] || 0) + 1;
      // a bond between two DIFFERENT ligands is not a thing any file says
      else if (gi && gj && gi !== gj) crossResidue++;
    }
    return {groups: groups.size, atoms, loose, bad: bad.slice(0, 6), n,
            bonds: bonds.length, outOfRange, crossResidue, perGroup};
  };
  //HELPERS
  const go = async () => {
    const R = {};
    try {
      await load('4HHB.cif'); await until(loaded); await settle();
      const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
      r.useGPU = false;
      const NAME = r.currentObjectName;
      R.name = NAME;
      R.before = audit(r, NAME);

      // SELECT CHAIN D and cut it out
      const f = r.objectsData[NAME].frames[0];
      const sel = new Set();
      for (let i = 0; i < f.chains.length; i++) if (f.chains[i] === 'D') sel.add(i);
      R.selected = sel.size;
      // how many LIGAND atoms are going with it - which for a protein chain
      // may be none, and the map still has to survive the renumbering
      let ligCut = 0;
      for (const i of sel) if (f.position_types[i] === 'L') ligCut++;
      R.ligandsCut = ligCut;
      r.residueSelection = sel;
      const made0 = r.cutSelection();
      const made = made0 && (made0.name || made0);
      await settle();
      R.made = made;
      R.objects = Object.keys(r.objectsData);

      // back to the object that was cut FROM
      r._showObject(NAME);
      await settle();
      R.after = audit(r, NAME);
      R.cutOut = made ? audit(r, made) : null;

      // ...AND NOW A CUT THAT DOES TAKE A LIGAND. Chain D is protein; the
      // haems sit in chains of their own, so cutting one of those is the case
      // where groups have to LEAVE the map as well as renumber.
      const f2 = r.objectsData[NAME].frames[0];
      const ligChain = f2.chains[f2.position_types.indexOf('L')];
      const sel2 = new Set();
      let lig2 = 0;
      for (let i = 0; i < f2.chains.length; i++) {
        if (f2.chains[i] === ligChain) { sel2.add(i); if (f2.position_types[i] === 'L') lig2++; }
      }
      R.ligChain = ligChain;
      R.ligandsCut2 = lig2;
      r.residueSelection = sel2;
      const m2 = r.cutSelection();
      await settle();
      R.made2 = m2 && (m2.name || m2);
      r._showObject(NAME);
      await settle();
      R.after2 = audit(r, NAME);
      R.cutOut2 = R.made2 ? audit(r, R.made2) : null;

      // ...AND AN OBJECT WHOSE FRAMES CARRY NO BONDS OF THEIR OWN, which is
      // how the Python API loads one (obj.bonds is set at the object level)
      // and how most frames of a trajectory arrive. The object's list is then
      // the only answer there is, and an edit has to renumber it: nothing
      // else will, because the write-back from setCoords only ever puts a
      // FRAME's bonds there.
      const o3 = r.objectsData[NAME];
      for (const fr of o3.frames) delete fr.bonds;
      const f3 = o3.frames[0];
      const sel3 = new Set();
      let lig3 = 0;
      for (let i = 0; i < f3.chains.length; i++) {
        if (f3.chains[i] === 'A') { sel3.add(i); if (f3.position_types[i] === 'L') lig3++; }
      }
      R.ligandsCut3 = lig3;
      r.residueSelection = sel3;
      r.cutSelection();
      await settle();
      r._showObject(NAME);
      await settle();
      R.objectOnly = audit(r, NAME);
      R.objectOnly.rendererBonds = r.bonds ? r.bonds.length : 0;
      R.objectOnly.frameHasBonds = !!(o3.frames[0].bonds
        && o3.frames[0].bonds.length);

      // ...AND FOCUS: one click, one neighbourhood. Four things at once, and
      // the next call replaces them rather than piling side chains up behind
      // you. Measured on 4HHB, which is loaded through the web parser and so
      // HAS a side-chain table - the Python payload carries none, which is why
      // this lives here rather than in a notebook probe.
      //
      // IT MUST NOT ROTATE. Only the centre and the zoom move, so clicking
      // from residue to residue walks through a structure rather than
      // spinning it. That is the whole difference between focus and orient,
      // and it is the one thing a reader would notice immediately.
      r._showObject(NAME);
      await settle();
      const snap = () => ({
        rot: JSON.stringify(r.viewerState.rotation),
        ext: Math.round(r.viewerState.extent || 0),
        clip: !!(r.clipSlabOn && r.clipSlabOn()),
        sel: r.residueSelection ? r.residueSelection.size : 0,
        sc: Object.keys(r.objectsData).reduce((a, k) => {
          const sc = r.objectsData[k].sidechains;
          return a + (sc ? sc.size : 0);
        }, 0),
        // ...and WHICH ONES, because a count cannot tell "replaced" from
        // "added to": a second neighbourhood is legitimately bigger than the
        // first, and 4 then 6 looks the same either way.
        scAt: Object.keys(r.objectsData).map((k) => {
          const sc = r.objectsData[k].sidechains;
          return k + ':' + (sc ? [...sc].sort((x, y) => x - y).join(',') : '');
        }).join('|'),
      });
      R.focus = {has: typeof r.focusOn === 'function', table: !!r.sidechains};
      // THE CAMERA MOVES OVER A THIRD OF A SECOND, so every reading waits for
      // it to land. `_focusAnim` holds the record while one is running; a
      // fixed sleep would be a race on a slow machine.
      const landed = () => until(() => !r._focusAnim, 3000);
      if (R.focus.has) {
        R.focus.before = snap();
        const f0 = r.objectsData[NAME].frames[0];
        const ligIdx = f0.position_types.indexOf('L');
        // SIDE CHAIN TO SIDE CHAIN. residuesWithin counts the trace point as
        // an atom unless told otherwise, and consecutive CAs are 3.8 A apart -
        // so atom-to-atom always drags in i-1 and i+1, and across a sheet the
        // partner opposite, whose side chain faces the other way. Neither is
        // an interaction. Seeded mid-strand, the two answers have to DIFFER,
        // or this fixture cannot tell which one focus asked for.
        const strand = 3;
        const asAtoms = r.residuesWithin(new Set([strand]), 5);
        const asSide = r.residuesWithin(new Set([strand]), 5, {sidechainsOnly: true});
        R.focus.shell = {atoms: asAtoms.size, side: asSide.size,
                         neighbours: [asAtoms.has(strand - 1), asAtoms.has(strand + 1),
                                      asSide.has(strand - 1), asSide.has(strand + 1)]};
        const picked = r.focusOn({positions: [strand]});
        R.focus.picked = picked ? picked.size : -1;
        r.clearFocus();
        await landed();

        // 🔴 THE SELECTION IS ANNOUNCED BEFORE THE STRUCTURE CHANGES.
        // setResidueSelection dispatches on DOCUMENT, and the listeners - the
        // sequence strip, the selection panel - rebuild against whatever is
        // there when they hear it. Announced AFTER the side chains
        // materialise, they rebuild against a structure whose position count
        // has just grown: 0.2 ms becomes 47.8 on 4HHB, and a focus click went
        // from 48 ms to 70. Recorded as the position count AT THE MOMENT of
        // the event, which is the only way to see an ordering.
        let atEvent = -1;
        const spy = () => { atEvent = r.coords.length; };
        document.addEventListener('py2dmol-residue-selection-change', spy);
        const before = r.coords.length;
        const near = r.focusOn({positions: [ligIdx]});
        document.removeEventListener('py2dmol-residue-selection-change', spy);
        R.focus.order = {before, atEvent, after: r.coords.length};
        // MID-FLIGHT. The camera moves over about a third of a second, so a
        // reading taken during it must be BETWEEN where it started and where
        // it is going - a check on where it lands passes just as happily
        // against a jump, which is what this replaced.
        //
        // POLLED, NOT COUNTED IN FRAMES. Three frames in, the first rAF may
        // not have run yet and the extent is still exactly where it started -
        // which read as "it jumped" and failed about one run in ten. Wait for
        // the first MOVEMENT instead, and give up when the flight lands.
        const startExt = R.focus.before.ext;
        await until(() => !r._focusAnim
            || Math.round(r.viewerState.extent || 0) !== startExt, 2000);
        R.focus.moving = !!r._focusAnim;
        R.focus.midExtent = Math.round(r.viewerState.extent || 0);
        await landed(); await settle(4);
        R.focus.near = near ? near.size : -1;
        R.focus.onLig = snap();
        // ...somewhere else: the first focus's side chains have to GO
        const near2 = r.focusOn({positions: [3]});
        await landed(); await settle(4);
        R.focus.onRes = snap();
        R.focus.near2 = near2 ? near2.size : -1;
        r.clearFocus();
        await landed(); await settle(4);
        R.focus.after = snap();
      }

      // ...AND THE MODE. Focus is a toggle because what it changes is what a
      // CLICK does. ui.js wraps setResidueSelection rather than listening for
      // py2dmol-residue-selection-change, which is document-scoped and would
      // fire once per viewer on the page - and the wrap has to guard against
      // focusOn's own call, which puts the halo on what was clicked.
      const fbtn = document.querySelector('#focusButton');
      R.mode = {box: !!fbtn};
      if (fbtn && R.focus.has) {
        fbtn.click();
        await settle(4);
        R.mode.pressed = fbtn.getAttribute('aria-pressed');
        r.setResidueSelection(new Set([5]));      // as a click would
        await landed(); await settle(4);
        R.mode.onClick = snap();
        // CLICKING THE BACKGROUND, THE WAY A CLICK DOES IT. The mouseup
        // handler calls clearResidueSelection - NOT setResidueSelection with
        // an empty set - so driving the setter here tested a path no gesture
        // takes, and passed while the real one did nothing.
        r.clearResidueSelection();
        await landed(); await settle(4);
        R.mode.onBackground = snap();
        r.setResidueSelection(new Set([5]));
        await landed(); await settle(4);
        fbtn.click();
        await landed(); await settle(4);
        R.mode.offAgain = snap();
        R.mode.pressedAfter = fbtn.getAttribute('aria-pressed');
        // ...and with the mode OFF a click must not focus
        r.setResidueSelection(new Set([7]));
        await settle(4);
        R.mode.clickWhenOff = snap();
        r.setResidueSelection(new Set());
        await settle(2);
      }

      // ...AND A COFACTOR IS A LIGAND. Loaded as a second object so nothing
      // above it is disturbed.
      await load('_cofactor_probe.pdb');
      await settle();
      const cofName = Object.keys(r.objectsData).find(
          (k) => k.indexOf('_cofactor_probe') === 0);
      R.cof = {object: cofName || null};
      if (cofName) {
        const cf = r.objectsData[cofName].frames[0];
        const tally = {};
        for (const t of cf.position_types) tally[t] = (tally[t] || 0) + 1;
        R.cof.types = tally;
        R.cof.groups = (r.ligandGroupsOf(cofName) || new Map()).size;
        R.cof.atoms = [...(r.ligandGroupsOf(cofName) || new Map()).values()]
            .reduce((a, b) => a + b.length, 0);
      }
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS if "PAGE_JS" not in globals() else PAGE_JS)
# A RIBOSE-BEARING COFACTOR, written beside the probe page so it can be
# fetched like any other file. SAM, SAH, ATP, NAD and FAD all carry the three
# sugar atoms that say "nucleotide" to a structural test - and viewer.py's said
# exactly that, so a notebook drew a 27-atom ligand as ONE SPHERE while the
# website drew it correctly. src/io/parse.js is stricter (a KNOWN nucleic
# residue plus connectivity), and this is here so that it stays stricter:
# harmonising the two by copying the loose rule would fail this.
COFACTOR = os.path.join(ROOT, "_cofactor_probe.pdb")
_ATOMS = [("N", 'N'), ("CA", 'C'), ("C", 'C'), ("O", 'O'), ("CB", 'C'),
          ("CG", 'C'), ("SD", 'S'), ("CE", 'C'), ("C5'", 'C'), ("C4'", 'C'),
          ("O4'", 'O'), ("C3'", 'C'), ("O3'", 'O'), ("C2'", 'C'),
          ("O2'", 'O'), ("C1'", 'C'), ("N9", 'N'), ("C8", 'C')]
with open(COFACTOR, "w") as _fh:
    # ...a short protein chain first, so the file is an ordinary structure and
    # the cofactor is what it is BECAUSE of the company it keeps, not because
    # there is nothing else in the file.
    _s = 0
    for _i in range(6):
        for _nm, _el in (("N", 'N'), ("CA", 'C'), ("C", 'C'), ("O", 'O')):
            _s += 1
            _fh.write("ATOM  {:5d} {:^4s} ALA A{:4d}    {:8.3f}{:8.3f}{:8.3f}"
                      "  1.00 50.00          {:>2s}\n".format(
                          _s, _nm, _i + 1, _i * 3.8, 0.0, 0.0, _el))
    for _i, (_nm, _el) in enumerate(_ATOMS):
        _s += 1
        _fh.write("HETATM{:5d} {:^4s} LIG C{:4d}    {:8.3f}{:8.3f}{:8.3f}"
                  "  1.00 50.00          {:>2s}\n".format(
                      _s, _nm, 1, 30.0 + _i * 1.4, 5.0, 0.0, _el))
    _fh.write("END\n")

src=open(os.path.join(ROOT,"dev.html")).read()
stamp=str(int(time.time()*1000))
src=re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")', lambda m: m.group(1)+"?v="+stamp+m.group(3), src)
open(PROBE,"w").write(src.replace("</body>", JS+"</body>"))
box=[]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(self,*a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length",0)))))
        self.send_response(200); self.send_header("Content-Length","2"); self.end_headers(); self.wfile.write(b"ok")
socketserver.ThreadingTCPServer.allow_reuse_address=True
httpd=socketserver.ThreadingTCPServer(("127.0.0.1",9661),H); httpd.daemon_threads=True
threading.Thread(target=httpd.serve_forever,daemon=True).start()
p=subprocess.Popen([CHROME,"--headless=new","--user-data-dir=/tmp/py2dmol-cl","--no-first-run",
  "--window-size=1200,1000","http://127.0.0.1:9661/_cutlig.html"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end = time.time() + DEADLINE
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE)
try: os.remove(COFACTOR)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-cl",ignore_errors=True)
R=box[0] if box else {"error":"no result posted"}
if R.get("error"):
    print("state:", {k: v for k, v in R.items() if k != "error"})
    sys.exit("page error: " + R["error"])

print(f"{R['name']}: {R['before']['groups']} ligand groups over {R['before']['atoms']} atoms"
      f" ({R['before']['n']} positions)")
print(f"cut chain D ({R['selected']} residues, {R['ligandsCut']} of them ligand"
      f" atoms) into {R['made']!r}; objects {R['objects']}")
print(f"  what is left: {R['after']['groups']} groups over {R['after']['atoms']} atoms"
      f" ({R['after']['n']} positions), {R['after']['loose']} ligand atoms in no group")
print(f"  the cut copy:  {R['cutOut']['groups']} groups over {R['cutOut']['atoms']} atoms"
      f" ({R['cutOut']['n']} positions), {R['cutOut']['loose']} loose")
bad=[]
fc = R.get('focus') or {}
print(f"  focus: {fc}")
if not fc.get('has'):
    bad.append('parts/focus.js is not in this build')
elif not fc.get('table'):
    bad.append('4HHB came in with no side-chain table, so the half of focus'
               ' that draws them is unmeasured')
else:
    b, on, on2, af = (fc.get('before') or {}, fc.get('onLig') or {},
                      fc.get('onRes') or {}, fc.get('after') or {})
    if on.get('rot') != b.get('rot') or on2.get('rot') != b.get('rot'):
        bad.append('focus turned the structure - only the centre and the zoom'
                   ' may move, or clicking from residue to residue spins the'
                   ' view instead of walking through it')
    sh = fc.get('shell') or {}
    if not (sh.get('atoms', 0) > sh.get('side', 0)):
        bad.append(f"atom-to-atom found {sh.get('atoms')} and side-chain-only"
                   f" {sh.get('side')} - they have to differ mid-strand or this"
                   ' cannot tell which one focus asked for')
    elif fc.get('picked') != sh.get('side'):
        bad.append(f"focus picked {fc.get('picked')} residues where"
                   f" side-chain-to-side-chain finds {sh.get('side')} - it is"
                   ' counting the trace point, so the sequence neighbours and'
                   ' the residue across a sheet come with it')
    od = fc.get('order') or {}
    if od.get('atEvent', -1) < 0:
        bad.append('no selection-change event fired during a focus, so the'
                   ' ordering below is unmeasured')
    elif not (od.get('after', 0) > od.get('before', 0)):
        bad.append(f"the focus added no positions ({od}) - nothing"
                   ' materialised, so this cannot see the ordering')
    elif od.get('atEvent') != od.get('before'):
        bad.append(f"the selection was announced with {od.get('atEvent')}"
                   f" positions on screen, not the {od.get('before')} there"
                   ' were before the focus - so every listener rebuilt against'
                   ' a structure that had just changed under it, which is 47.8'
                   ' ms on 4HHB against 0.2')
    if not fc.get('moving'):
        bad.append('the camera was not moving three frames after a focus - it'
                   ' jumped, and walking from residue to residue with the'
                   ' picture teleporting is what the animation is for')
    elif not (on.get('ext', 0) < fc.get('midExtent', 0) < b.get('ext', 0)):
        bad.append(f"mid-flight the extent was {fc.get('midExtent')}, not"
                   f" between the {b.get('ext')} it started at and the"
                   f" {on.get('ext')} it ends at")
    if not (on.get('ext', 0) < b.get('ext', 0)):
        bad.append(f"focus did not move in: extent {b.get('ext')} ->"
                   f" {on.get('ext')}")
    if not on.get('clip'):
        bad.append('focus cut no slab')
    if not on.get('sc'):
        bad.append('focus drew no side chains, and 4HHB has a table for them')
    if not (fc.get('near', 0) > 1):
        bad.append(f"the neighbourhood came out {fc.get('near')} positions")
    first = set((on.get('scAt') or '').split('|'))
    second = set((on2.get('scAt') or '').split('|'))
    if first == second:
        bad.append('the two focuses drew the same side chains, so this fixture'
                   ' cannot tell replacing from adding to')
    elif on2.get('sc', 0) >= on.get('sc', 0) + fc.get('near', 0):
        bad.append(f"the second focus added to the first rather than replacing"
                   f" it: {on.get('sc')} side chains then {on2.get('sc')}")
    for k in ('rot', 'ext', 'clip', 'sel', 'sc'):
        if af.get(k) != b.get(k):
            bad.append(f"clearFocus left {k} at {af.get(k)}, not the"
                       f" {b.get(k)} it found")

md = R.get('mode') or {}
print(f"  focus mode: box {md.get('box')}, on a click"
      f" {(md.get('onClick') or {}).get('ext')} extent /"
      f" {(md.get('onClick') or {}).get('sc')} side chains; off again"
      f" {(md.get('offAgain') or {}).get('ext')}")
if not md.get('box'):
    bad.append('no Focus button in the control column')
elif md.get('pressed') != 'true' or md.get('pressedAfter') != 'false':
    bad.append(f"the Focus button does not latch: aria-pressed"
               f" {md.get('pressed')} on, {md.get('pressedAfter')} off - it is"
               ' a mode, and the lit skin is keyed on that attribute')
elif (md.get('onBackground') or {}).get('sel'):
    bad.append(f"clicking away left {(md.get('onBackground') or {}).get('sel')}"
               ' position(s) still highlighted - focusOn remembers what to put'
               ' back, and the wrap sets the selection BEFORE it focuses, so it'
               ' was remembering the residue that had just been clicked')
elif (md.get('onBackground') or {}).get('clip'):
    bad.append('clicking the background did not come back out - it calls'
               ' clearResidueSelection, not setResidueSelection with an empty'
               ' set, and both have to be wrapped')
elif (md.get('onBackground') or {}).get('ext') != (fc.get('before') or {}).get('ext'):
    bad.append(f"clicking the background left the camera at"
               f" {(md.get('onBackground') or {}).get('ext')} rather than the"
               f" {(fc.get('before') or {}).get('ext')} it started from")
elif not (md.get('onClick') or {}).get('clip'):
    bad.append('a click with Focus on did not focus - ui.js wraps'
               ' setResidueSelection, and the wrap is the whole of the mode')
elif (md.get('offAgain') or {}).get('ext') != (fc.get('before') or {}).get('ext'):
    bad.append(f"leaving the mode left the camera at"
               f" {(md.get('offAgain') or {}).get('ext')} rather than the"
               f" {(fc.get('before') or {}).get('ext')} it borrowed")
elif (md.get('clickWhenOff') or {}).get('clip'):
    bad.append('a click focused with the mode OFF - the wrap has stopped'
               ' asking whether it is on')

cof = R.get('cof') or {}
print(f"  a ribose-bearing cofactor: {cof}")
if not cof.get('object'):
    bad.append('the cofactor fixture did not load, so the parser is unmeasured')
elif (cof.get('types') or {}).get('L') != 18:
    bad.append(f"the cofactor parsed as {cof.get('types')} - eighteen atoms, and"
               " anything else means the ribose was read as a NUCLEOTIDE and"
               " the whole ligand collapsed onto its C4'. viewer.py did exactly"
               " that; src/io/parse.js wants a known nucleic residue plus"
               " connectivity, and has to keep wanting it")
elif cof.get('groups') != 1 or cof.get('atoms') != 18:
    bad.append(f"the cofactor came out as {cof.get('groups')} ligand group(s)"
               f" over {cof.get('atoms')} atoms rather than one over eighteen")
if not R['before']['groups']:
    bad.append("4HHB came in with no ligand groups at all - nothing here is being tested")
if R['before']['bad']:
    bad.append(f"the groups were wrong before any edit: {R['before']['bad']}")
if not R['made']:
    bad.append("the cut did not happen")
for tag in ('after', 'cutOut'):
    a = R[tag]
    if a['bad']:
        bad.append(f"{tag}: {a['bad']}")
    if a['loose']:
        bad.append(f"{tag}: {a['loose']} ligand atoms belong to no group - they"
                   " draw as loose spheres and the strip cannot collapse them")

def bonds_line(tag):
    a = R[tag]
    return (f"  {tag:8s} {a['bonds']} bonds, {a['outOfRange']} out of range,"
            f" {a['crossResidue']} between two different ligands;"
            f" per ligand {a['perGroup']}")

def check_bonds(tag):
    a = R[tag]
    if a['outOfRange']:
        bad.append(f"{tag}: {a['outOfRange']} bonds point outside the frame")
    if a['crossResidue']:
        bad.append(f"{tag}: {a['crossResidue']} bonds join two different ligands"
                   " - the numbering moved under them")

print(bonds_line('before'))
print(bonds_line('after'))
check_bonds('before')
check_bonds('after')
check_bonds('cutOut')
# EVERY LIGAND THAT SURVIVED KEEPS ITS OWN BONDS, one for one. This is the
# check that fails when the bonds are read from a stale object-level copy:
# the atoms are right, the map is right, and the sticks are gone.
for key, cnt in (R['before']['perGroup'] or {}).items():
    if key in (R['after']['perGroup'] or {}):
        if R['after']['perGroup'][key] != cnt:
            bad.append(f"{key} had {cnt} bonds before the cut and"
                       f" {R['after']['perGroup'][key]} after")
    elif key not in (R['cutOut']['perGroup'] or {}):
        bad.append(f"{key} lost every one of its {cnt} bonds")
# WHAT SHOULD BE LEFT, counted rather than assumed: chain D of 4HHB carries no
# ligand of its own (the haems are in chains of their own), so the map has to
# come through the renumbering intact - which is the harder case, not the
# easier one. Whatever did go, went.
if R['after']['atoms'] != R['before']['atoms'] - R['ligandsCut']:
    bad.append(f"{R['before']['atoms']} ligand atoms before, {R['ligandsCut']}"
               f" in the cut, {R['after']['atoms']} left")
if R['cutOut']['atoms'] != R['ligandsCut']:
    bad.append(f"the copy took {R['cutOut']['atoms']} ligand atoms of"
               f" {R['ligandsCut']}")
print(f"then cut the ligand chain {R.get('ligChain')!r}"
      f" ({R.get('ligandsCut2')} ligand atoms) into {R.get('made2')!r}")
print(f"  what is left: {R['after2']['groups']} groups over {R['after2']['atoms']}"
      f" atoms, {R['after2']['loose']} loose")
print(f"  the cut copy:  {R['cutOut2']['groups']} groups over"
      f" {R['cutOut2']['atoms']} atoms, {R['cutOut2']['loose']} loose")
for tag in ('after2', 'cutOut2'):
    a = R[tag]
    if a['bad']:
        bad.append(f"{tag}: {a['bad']}")
    if a['loose']:
        bad.append(f"{tag}: {a['loose']} ligand atoms belong to no group")
if not R.get('ligandsCut2'):
    bad.append("the second cut took no ligand atoms - it is not testing"
               " what it says it is")
if R['after2']['atoms'] != R['after']['atoms'] - R['ligandsCut2']:
    bad.append(f"after cutting the ligand chain: {R['after2']['atoms']} atoms"
               f" left of {R['after']['atoms']} with {R['ligandsCut2']} cut")
if R['cutOut2']['atoms'] != R['ligandsCut2'] or not R['cutOut2']['groups']:
    bad.append(f"the copy of the ligand chain has {R['cutOut2']['groups']}"
               f" groups over {R['cutOut2']['atoms']} atoms")

print(bonds_line('after2'))
print(bonds_line('cutOut2'))
check_bonds('after2')
check_bonds('cutOut2')
# the ligand chain that was cut takes its own bonds with it, whole
for key, cnt in (R['after']['perGroup'] or {}).items():
    here = (R['after2']['perGroup'] or {}).get(key)
    gone = (R['cutOut2']['perGroup'] or {}).get(key)
    if here is None and gone is None:
        bad.append(f"{key} lost its {cnt} bonds in the second cut")
    elif here is not None and here != cnt:
        bad.append(f"{key}: {cnt} bonds before the second cut, {here} after")
    elif gone is not None and gone != cnt:
        bad.append(f"{key}: the copy took {gone} of its {cnt} bonds")

print(f"then, with the frames carrying no bonds of their own, cut chain A"
      f" ({R.get('ligandsCut3')} ligand atoms)")
print(bonds_line('objectOnly') + f" [renderer holds {R['objectOnly']['rendererBonds']}]")
check_bonds('objectOnly')
if R['objectOnly']['perGroup'] != R['after2']['perGroup']:
    bad.append("with only the OBJECT's bond list to go on, the ligands came"
               f" back with {R['objectOnly']['perGroup']} against"
               f" {R['after2']['perGroup']} before the cut - the list was left"
               " in the old numbering")
if not R['objectOnly']['rendererBonds']:
    bad.append("the renderer ended up with no bonds at all")

for m in bad: print("FAIL:", m)
sys.exit(1 if bad else 0)
