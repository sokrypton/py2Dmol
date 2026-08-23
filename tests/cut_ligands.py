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
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  // EVERY GROUP, SCORED AGAINST THE FRAME THAT IS THERE.
  const audit = (r, name) => {
    const o = r.objectsData[name];
    const f = o.frames[0];
    const n = f.coords.length;
    const types = f.position_types || [];
    const chains = f.chains || [];
    const nums = f.residue_numbers || [];
    const names = f.position_names || [];
    const groups = o.ligandGroups || new Map();
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
  const go = async () => {
    const R = {};
    try {
      await load('4HHB.cif'); await wait(700);
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
      await wait(900);
      R.made = made;
      R.objects = Object.keys(r.objectsData);

      // back to the object that was cut FROM
      r._showObject(NAME);
      await wait(700);
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
      await wait(900);
      R.made2 = m2 && (m2.name || m2);
      r._showObject(NAME);
      await wait(700);
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
      await wait(900);
      r._showObject(NAME);
      await wait(600);
      R.objectOnly = audit(r, NAME);
      R.objectOnly.rendererBonds = r.bonds ? r.bonds.length : 0;
      R.objectOnly.frameHasBonds = !!(o3.frames[0].bonds
        && o3.frames[0].bonds.length);
    } catch (e) { R.error = String((e && e.stack) || e); }
    await fetch('/_result', {method: 'POST', body: JSON.stringify(R)});
  };
  setTimeout(go, 400);
});
</script>
"""
src=open(os.path.join(ROOT,"index.html")).read()
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
end=time.time()+180
while not box and time.time()<end: time.sleep(0.5)
p.kill(); httpd.shutdown(); os.remove(PROBE); shutil.rmtree("/tmp/py2dmol-cl",ignore_errors=True)
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
