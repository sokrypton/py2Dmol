"""A paired MSA reaches the panel, is drawn with its chains apart, and points
back at the right chain of the structure.

    python3 tests/msa_paired_ui.py            # 1TIM (a homodimer)
    python3 tests/msa_paired_ui.py 1TIM.cif

tests/msa_paired.js has the arithmetic - the split, the block-aware scores, the
column map - against fixtures in node. What it cannot reach is the half that
only exists in a page: the app's matcher deciding a query is a concatenation,
the object storing it beside any per-chain alignments, the panel DRAWING the
boundary, and a structure selection travelling back as columns. That is this.

🔴 THE ALIGNMENT IS BUILT FROM THE STRUCTURE'S OWN CHAIN SEQUENCES, in the
page. A fixture .a3m checked in beside the .cif would be a second statement of
what 1TIM's chains are, and the day the parser reads one residue differently
the probe fails for a reason that has nothing to do with pairing.

A HOMODIMER IS THE HARD CASE FOR THE SPLIT, deliberately: both chains are the
same string, so a search that does not carry a cursor anchors them both at
column zero and the second block comes out empty.

The rule is measured as PIXELS OF THE RULE'S OWN COLOUR, with the column it
should be in computed from the block and the char width - not by reading back
the number that was drawn from. The control is the rest of the canvas: a
vertical line means those pixels are in ONE column, and a fill or a stray tint
would put them everywhere.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_js import HELPERS, check_js  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROBE = os.path.join(ROOT, "_msapaired.html")
FILE = sys.argv[1] if len(sys.argv) > 1 else "1TIM.cif"

JS = """
<script>
window.addEventListener('load', () => {
  //HELPERS
  const R = {};
  let posted = false;
  const post = () => { if (posted) return; posted = true;
    fetch('/result', {method: 'POST', body: JSON.stringify(R)}); };
  setTimeout(post, 55000);
  const file = (name, text) => ({name, readAsync: () => Promise.resolve(text)});
  const go = async () => {
    try {
      const P = new URLSearchParams(location.search);
      // The deposited chains, not the assembly's: the biounit expansion renames
      // what it copies, and every chain id here has to be the one the
      // alignment's blocks were anchored against.
      const bu = document.getElementById('loadBiounit');
      if (bu && bu.checked) { bu.checked = false; bu.dispatchEvent(new Event('change')); }
      // ...and the app only reads alignment files when asked to: `Load MSA` is
      // off by default, and with it off the a3m is skipped without a word.
      const wantMsa = document.getElementById('loadMSACheckbox');
      if (wantMsa && !wantMsa.checked) {
        wantMsa.checked = true; wantMsa.dispatchEvent(new Event('change'));
      }
      R.msaEnabled = !!(wantMsa && wantMsa.checked);

      const name = P.get('f');
      const txt = await (await fetch('/' + name)).text();
      await window.py2dmolLoadFiles([file(name, txt)], false);
      await until(loaded, 30000);
      const v = window.py2dmol_viewers[Object.keys(window.py2dmol_viewers)[0]];
      const r = v.renderer;
      const objectName = r.currentObjectName;
      const obj = r.objectsData[objectName];
      const frame = obj.frames[0];

      // AN ALIGNMENT MADE OF THIS STRUCTURE'S OWN CHAINS.
      const chainSeqs = window.MSA.extractSequences(frame);
      const chains = Object.keys(chainSeqs);
      R.chains = chains;
      if (chains.length < 2) throw new Error('need at least two chains, got ' + chains.length);
      const A = chainSeqs[chains[0]], B = chainSeqs[chains[1]];
      const gapsA = '-'.repeat(A.length), gapsB = '-'.repeat(B.length);
      const drift = (s, every) => s.split('').map((c, i) => (i % every === 0 ? 'A' : c)).join('');
      const rows = [
        '>query', A + B,
        '>paired_close', drift(A, 9) + drift(B, 9),
        '>paired_far', drift(A, 4) + drift(B, 4),
        '>onlyA_1', A + gapsB,
        '>onlyA_2', drift(A, 11) + gapsB,
        '>onlyB_1', gapsA + B,
        '>onlyB_2', gapsA + drift(B, 11),
        ''
      ];
      await window.py2dmolLoadFiles([file('paired.a3m', rows.join('\\n'))], false);
      await until(() => obj.msa && Object.keys(obj.msa.msasBySequence || {}).length, 15000);
      await settle(6);
      // A miss here is the whole feature missing, so say which half it was
      // rather than throwing on the next line.
      if (!obj.msa) { R.storedNothing = true; post(); return; }

      // --- did the app recognise the concatenation ---------------------------
      const entries = Object.entries(obj.msa.msasBySequence);
      const pairedEntry = entries.find(([, e]) => e.paired);
      R.entryCount = entries.length;
      R.recognised = !!pairedEntry;
      const stored = pairedEntry && pairedEntry[1].msaData;
      R.storedBlocks = stored && stored.chainBlocks
        ? stored.chainBlocks.map((b) => ({chain: b.chain, start: b.start, end: b.end}))
        : null;
      R.entryChains = pairedEntry ? pairedEntry[1].chains : null;

      // The section itself, not just its canvas: `#msa-buttons` is
      // `display: none` in the markup and only updateMSAContainerVisibility
      // turns it on, so an alignment can be parsed, stored, drawn and invisible.
      R.sectionShown =
        getComputedStyle(document.getElementById('msa-buttons')).display !== 'none';

      // --- is it what the panel is showing ----------------------------------
      const shown = window.MSA.getMSAData();
      R.shownBlocks = shown && shown.chainBlocks ? shown.chainBlocks.length : 0;
      R.shownRows = shown ? shown.sequences.length : 0;
      R.shownNames = shown ? shown.sequences.map((s) => s.name) : [];
      // EVERY ROW OF A PAIRED VIEW SPANS THE CHAINS. That is what the view is
      // for, and an unpaired row in it is half a row.
      const blockA = shown.chainBlocks[0];
      R.rowsSpanningBoth = shown.sequences.filter((row) =>
        /[^-]/.test(row.sequence.slice(blockA.start, blockA.end))
        && /[^-]/.test(row.sequence.slice(blockA.end))).length;

      // ...and the depth that is NOT paired is still reachable, at its own
      // chain's width, which is the condition on dropping it from this view.
      const perChain = Object.values(obj.msa.msasBySequence).filter((e) => !e.paired);
      R.perChainViews = perChain.map((e) => e.chains.join('') + '/' + e.msaData.queryLength
        + '/' + (e.msaData.sequencesOriginal || e.msaData.sequences).length);
      R.unpairedReachable = perChain.some((e) =>
        (e.msaData.sequencesOriginal || e.msaData.sequences).some((row) => /onlyA/.test(row.name)));

      // Each block's first column carries its own chain's residue number, which
      // is what the tick row draws - one alignment, two numberings.
      const blockB = shown.chainBlocks[1];
      R.residueAtBlockStart = shown.residueNumbers ? shown.residueNumbers[blockB.start] : null;
      R.residueAtZero = shown.residueNumbers ? shown.residueNumbers[0] : null;

      // --- DOES THE CHAIN LETTER SIT ON A RESIDUE NUMBER --------------------
      // They share one 15px tick row. The FIRST block's letter is the one that
      // is always on screen - it sits at column 0, which is where tick "1" is
      // drawn - so this is measurable without scrolling to a boundary.
      const msaBox = [...document.querySelectorAll('.msa-canvas')].find((b) => b.offsetParent);
      const msaCanvas = msaBox ? msaBox.querySelector('canvas') : null;
      if (msaCanvas) {
        const mctx = msaCanvas.getContext('2d');
        // EXACTLY the tick row: 15 logical px at the display's own scale.
        // Forty caught the top of the query sequence row, whose Dayhoff cells
        // include blues, and the letter came back as a 1,400px "span".
        const band = Math.min(msaCanvas.height, Math.round(15 * (200 / 96)));
        const px = mctx.getImageData(0, 0, msaCanvas.width, band).data;
        const near = (i, c, tol) => Math.abs(px[i] - c[0]) < tol
          && Math.abs(px[i + 1] - c[1]) < tol && Math.abs(px[i + 2] - c[2]) < tol;
        const label = [26, 77, 143];    // CHAIN_LABEL_COLOR
        const tickInk = [51, 51, 51];   // #333, the residue numbers
        let lo = Infinity, hi = -Infinity, ticks = 0;
        const tickXs = [];
        for (let y = 0; y < band; y++) {
          for (let x = 0; x < msaCanvas.width; x++) {
            const i = (y * msaCanvas.width + x) * 4;
            if (near(i, label, 45) && px[i + 2] > px[i] + 50) { // blue-dominant
              if (x < lo) lo = x;
              if (x > hi) hi = x;
            } else if (near(i, tickInk, 45)) { ticks++; tickXs.push(x); }
          }
        }
        R.labelSpan = lo <= hi ? [lo, hi] : null;
        R.tickInk = ticks;
        if (lo <= hi) {
          const pad = 5 * (200 / 96);
          R.inkInLabelBox = tickXs.filter((x) => x > lo - pad && x < hi + pad).length;
        }
      }

      // --- is the boundary DRAWN --------------------------------------------
      // IN THE COVERAGE VIEW, because that is the one that always shows the
      // WHOLE alignment: it is an image scaled into the plot width, where the
      // MSA view is 10 px a column and scrolled, so on a 247+247 homodimer the
      // boundary sits a thousand pixels off the right edge at rest. It is also
      // the view the block structure is legible in - a slab of paired rows
      // over a two-tread staircase - so it is the one worth measuring.
      window.MSA.setMSAMode('coverage');
      await settle(8);
      // ONE CONTAINER PER MODE, and the others stay in the document hidden -
      // so this has to take the SHOWN one. Reading the first found the MSA
      // view's canvas, where the boundary of a 247+247 homodimer is a thousand
      // pixels off the right edge, and the measurement said "no rule".
      const boxes = [...document.querySelectorAll('.msa-canvas')];
      const box = boxes.find((b) => b.offsetParent) || boxes[0];
      const canvas = box ? box.querySelector('canvas') : null;
      R.hasCanvas = !!canvas;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        // The rule's own colour. The line is one CSS pixel on a canvas scaled
        // for the display, so it lands blended rather than exact - hence a
        // tolerance, and hence the assertions below being about SHAPE (one
        // column, a long run) rather than about a count.
        const want = [61, 111, 181];
        const columns = {};
        let total = 0;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            if (Math.abs(px[i] - want[0]) < 26 && Math.abs(px[i + 1] - want[1]) < 26
                && Math.abs(px[i + 2] - want[2]) < 26) {
              columns[x] = (columns[x] || 0) + 1;
              total++;
            }
          }
        }
        const ranked = Object.entries(columns).sort((a, b) => b[1] - a[1]);
        const busiest = ranked[0];
        R.ruleRunners = ranked.slice(0, 4).map(([x, n]) => x + ':' + n);
        // A LINE, NOT A WASH: nearly all of the rule's colour should be in the
        // one or two columns it was stroked in. The rest is the antialiasing
        // of that same stroke.
        R.ruleConcentration = total
          ? (ranked.slice(0, 2).reduce((n, e) => n + e[1], 0) / total) : 0;
        R.rulePixels = total;
        R.ruleColumns = Object.keys(columns).length;
        R.ruleX = busiest ? Number(busiest[0]) : null;
        R.ruleRun = busiest ? busiest[1] : 0;
        R.canvasWidth = canvas.width;
        R.canvasHeight = canvas.height;
        R.blockBStart = blockB.start;
        R.queryLength = shown.queryLength;
        // THE TWO CHAINS ARE THE SAME LENGTH, so the boundary is the exact
        // middle of the plotted columns - which is an expectation about WHERE
        // that needs none of the panel's private geometry.
        R.ruleAtMiddle = busiest
          ? Math.abs(Number(busiest[0]) / canvas.width - 0.5) < 0.08 : null;
      }

      // --- AND THE ALPHAFOLD 3 SERVER'S OWN LAYOUT --------------------------
      // Four files rather than one: a paired and an unpaired alignment per
      // chain, which is what a download from the server carries. On a second
      // copy of the structure, so it cannot collide with the alignment already
      // on the first.
      const second = await (await fetch('/' + name)).text();
      await window.py2dmolLoadFiles([file('af3_copy.cif', second)], false);
      await until(() => r.currentObjectName && r.currentObjectName !== objectName, 15000);
      const af3Object = r.currentObjectName;
      const af3Rows = (query, tag) => [
        '>query', query,
        // Two UniProt entry names of ONE species, which is what pairs.
        '>sp|P00001|' + tag + '1_HELPY x', drift(query, 8),
        '>sp|P00002|' + tag + '2_HELPY x', drift(query, 6),
        ''].join('\\n');
      const af3Unpaired = (query, tag) => [
        '>query', query,
        '>UniRef90_' + tag + ' n=2', drift(query, 5),
        ''].join('\\n');
      await window.py2dmolLoadFiles([
        file('job_paired_msa_chains_a.a3m', af3Rows(A, 'AA')),
        file('job_unpaired_msa_chains_a.a3m', af3Unpaired(A, 'UA'))], false);
      await until(() => {
        const o = r.objectsData[af3Object];
        return o && o.msa && Object.keys(o.msa.msasBySequence || {}).length;
      }, 15000);
      await settle(6);
      const af3Msa = r.objectsData[af3Object].msa;
      R.af3Entries = Object.values(af3Msa.msasBySequence).map(
        (e) => (e.paired ? 'paired' : 'single') + '/' + e.chains.join('') + '/' + e.msaData.queryLength);
      const af3Shown = window.MSA.getMSAData();
      R.af3ShownWidth = af3Shown ? af3Shown.queryLength : null;
      R.af3ShownBlocks = af3Shown && af3Shown.chainBlocks ? af3Shown.chainBlocks.length : 0;
      R.af3PairedRows = af3Shown
        ? af3Shown.sequences.filter((row) => row.isPaired).length : 0;

      // ...back to the first object for the selection leg.
      r._switchToObject(objectName);
      await settle(6);

      // --- THE ALIGNMENT IS VIEW-ONLY: a selection must not dim it ---------
      //
      // It used to. Picking one residue greyed out every column but that one,
      // which takes away the depth, the coverage and the staircase at the
      // moment the reader is looking at them - and no click anywhere could say
      // no, because any selection redimmed it.
      //
      // Measured as the stored state AND as pixels: `selectedPositions` is what
      // buildSelectionMask reads, and `null` there is the value that means no
      // dimming (an empty Map means dim EVERYTHING, which is the opposite). The
      // pixel count is the control - a stored null with the canvas still dim
      // would pass on the field alone.
      const inkOf = (c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) n++;
        }
        return n;
      };
      const shownCanvas = [...document.querySelectorAll('.msa-canvas canvas')]
        .find((c) => c.offsetParent !== null);
      R.inkBefore = shownCanvas ? inkOf(shownCanvas) : null;

      const wanted = chains[1];
      const targets = [];
      for (let i = 0; i < frame.chains.length && targets.length < 5; i++) {
        if (frame.chains[i] === wanted && frame.position_types[i] === 'P'
            && frame.residue_numbers[i] > 20) targets.push(i);
      }
      r.setResidueSelection(new Set(targets));
      await settle(6);
      R.picked = r.residueSelection ? r.residueSelection.size : 0;
      R.storedSelection = obj.msa.selectedPositions;
      R.inkAfter = shownCanvas ? inkOf(shownCanvas) : null;
    } catch (e) { R.error = String(e && e.stack || e); }
    post();
  };
  go();
});
</script>
"""
JS = JS.replace("//HELPERS", HELPERS)
check_js(JS)
src = open(os.path.join(ROOT, "dev.html")).read()
stamp = str(int(time.time() * 1000))
src = re.sub(r'(<script src="(?!https?:)[^"]+?)(\?v=\d+)?(")',
             lambda m: m.group(1) + "?v=" + stamp + m.group(3), src)
open(PROBE, "w").write(src.replace("</body>", JS + "</body>"))
box = []


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        box.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200); self.send_header("Content-Length", "2")
        self.end_headers(); self.wfile.write(b"ok")


# A PORT OF ITS OWN. The UI lane runs these six at a time, so a number already
# taken by another probe is an "Address already in use" for whichever starts
# second - which the runner reports as FAILED, indistinguishable from a real
# one. 9787 was tests/style_per_object.py's.
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 9799), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
p = subprocess.Popen([CHROME, "--headless=new", "--user-data-dir=/tmp/py2dmol-msapaired",
                      "--no-first-run", "--window-size=1200,900",
                      "http://127.0.0.1:9799/_msapaired.html?f=" + FILE],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
end = time.time() + 60
while not box and time.time() < end:
    time.sleep(0.5)
p.kill(); httpd.shutdown()
try: os.remove(PROBE)
except OSError: pass
shutil.rmtree("/tmp/py2dmol-msapaired", ignore_errors=True)
R = box[0] if box else {"error": "no result posted"}
if R.get("error"):
    sys.exit("page error: " + R["error"])

bad = []
print(f"  section visible: {R.get('sectionShown')}")
print(f"  chains {R.get('chains')} | {R.get('entryCount')} alignment(s) stored,"
      f" paired recognised: {R.get('recognised')}")
print(f"  blocks {R.get('storedBlocks')} over chains {R.get('entryChains')}")
print(f"  shown: {R.get('shownRows')} rows {R.get('shownNames')},"
      f" {R.get('rowsSpanningBoth')} spanning both chains")
print(f"  per-chain views kept: {R.get('perChainViews')}")
print(f"  residue number at column 0 = {R.get('residueAtZero')},"
      f" at the boundary = {R.get('residueAtBlockStart')}")
print(f"  rule: {R.get('rulePixels')} px, {100 * (R.get('ruleConcentration') or 0):.0f}%"
      f" of it in columns {R.get('ruleRunners')}; tallest run {R.get('ruleRun')} px"
      f" at x={R.get('ruleX')} of {R.get('canvasWidth')}"
      f" (boundary is column {R.get('blockBStart')} of {R.get('queryLength')})")
print(f"  AF3 layout: {R.get('af3Entries')} | shown {R.get('af3ShownWidth')} wide,"
      f" {R.get('af3ShownBlocks')} blocks, {R.get('af3PairedRows')} paired rows")
print(f"  view-only: picked {R.get('picked')} residues, stored"
      f" {R.get('storedSelection')!r}, ink {R.get('inkBefore')} ->"
      f" {R.get('inkAfter')}")

if R.get("storedNothing"):
    bad.append("nothing was stored on the object at all - the alignment was"
               " parsed and dropped. Every check below is about a paired"
               " alignment the app never accepted")
if not R.get("sectionShown"):
    bad.append("the MSA section is still hidden after an alignment was loaded"
               " through py2dmolLoadFiles. Its canvas is built and drawn and"
               " nobody can see it - showMSACanvasContainers shows the .msa-canvas"
               " boxes, and #msa-buttons around them is display:none until"
               " updateMSAContainerVisibility says otherwise")
if not R.get("recognised"):
    bad.append("the app did not recognise the concatenated query as a paired"
               " alignment - it matches no single chain, so without"
               " splitQueryIntoChainBlocks it is dropped without a word")
blocks = R.get("storedBlocks") or []
if len(blocks) != 2:
    bad.append(f"expected two blocks, got {len(blocks)}")
elif blocks[0]["end"] != blocks[1]["start"] or blocks[0]["start"] != 0:
    bad.append(f"the blocks do not tile the query: {blocks}")
elif blocks[1]["start"] == 0:
    bad.append("the second chain anchored at column zero - a homodimer's two"
               " identical chains, searched without a cursor")
if R.get("shownBlocks") != 2:
    bad.append("the panel is showing an alignment that has forgotten it is"
               " paired - the blocks are dropped by a rebuild between the"
               " object and the view (computeFilteredMSA)")
names = R.get("shownNames") or []
strays = [n for n in names if n.startswith("only")]
if strays:
    bad.append(f"{strays} are in the paired view. A row with one chain gapped"
               " is half a row: in the coverage plot it is a staircase under"
               " the thing you came to look at, and in the conservation it is"
               " depth that says nothing about the interface")
if R.get("rowsSpanningBoth") != R.get("shownRows"):
    bad.append(f"only {R.get('rowsSpanningBoth')} of {R.get('shownRows')} rows"
               " span both chains")
if not R.get("perChainViews"):
    bad.append("no per-chain alignment was registered beside the paired one, so"
               " the rows dropped from the paired view are nowhere at all -"
               " which is the condition on dropping them (splitByChainBlocks)")
if not R.get("unpairedReachable"):
    bad.append("the unpaired rows are not in any per-chain view either")
if not R.get("hasCanvas"):
    bad.append("no canvas inside a .msa-canvas container, so nothing about the drawing was measured")
else:
    if not R.get("rulePixels"):
        bad.append("no pixels of the boundary rule's colour anywhere on the"
                   " canvas - the chains are drawn as one run of columns with"
                   " nothing to say where one ends")
    if (R.get("ruleConcentration") or 0) < 0.8:
        bad.append(f"only {100 * (R.get('ruleConcentration') or 0):.0f}% of the"
                   " rule's colour is in its two busiest columns - a boundary is"
                   " a vertical line, so this is a tint spread over the plot"
                   " rather than a rule")
    if (R.get("ruleRun") or 0) < 200:
        bad.append(f"the tallest run of rule pixels is {R.get('ruleRun')} px on a"
                   f" {R.get('canvasHeight')} px canvas, which is a tick and not"
                   " a boundary down the rows")
    if R.get("ruleAtMiddle") is False:
        bad.append(f"the rule is at x={R.get('ruleX')} of {R.get('canvasWidth')},"
                   " and the two chains of a homodimer are the same length - so"
                   " the boundary belongs at the middle of the plot. A rule"
                   " somewhere else is a column-to-pixel conversion gone wrong,"
                   " which is the fault panels/heatmap.js had twice")
if R.get("residueAtBlockStart") is None:
    bad.append("the first column of the second block maps to no residue, so"
               " the tick row cannot number the second chain")
print(f"  tick row: chain letter at x{R.get('labelSpan')}, {R.get('tickInk')} px of"
      f" number ink in the row, {R.get('inkInLabelBox')} of it inside the letter's"
      " clear space")
if not R.get("labelSpan"):
    bad.append("no chain letter found in the tick row, so nothing was measured"
               " about it sitting on a number")
elif not R.get("tickInk"):
    bad.append("no residue numbers in the tick row at all - 'the letter does not"
               " overlap one' would pass for the wrong reason")
elif R.get("inkInLabelBox"):
    bad.append(f"{R.get('inkInLabelBox')} pixels of residue number are inside the"
               " chain letter's clear space. They share one 15px row, so the"
               " letter has to reserve its box and the ticks have to honour it")

af3 = R.get("af3Entries") or []
if not any(e.startswith("paired/") for e in af3):
    bad.append(f"the AlphaFold 3 server's four-file layout produced no paired"
               f" alignment - entries were {af3}. Its paired files are per"
               " chain and not row-aligned, so unless they are combined the"
               " pairing they carry is simply lost")
if R.get("af3ShownBlocks") != 2:
    bad.append("the panel did not open on the paired alignment built from the"
               " AF3 files. A view that has to be found in a dropdown is a view"
               " nobody sees - see defaultQuery")
if not R.get("af3PairedRows"):
    bad.append("the AF3 alignment has no paired rows. Two chains of one species"
               " with UniProt entry names in both files must pair; if the"
               " species is read from OX= (absent here) nothing does")

# 🔴 THE ALIGNMENT IS VIEW-ONLY. This leg used to require the opposite - that
# a selection came back as the second block's columns - because the MSA dimmed
# to it. That mapping still exists and is still checked, in tests/msa_paired.js
# (`computeColumnMap`); what is gone is the dimming, and this is what pins it.
#
# The CONTROL is that the selection happened at all: a probe that selected
# nothing would see no dimming either and report a pass.
if not R.get("picked"):
    bad.append("nothing was selected, so 'the MSA did not dim' says nothing")
if R.get("storedSelection") is not None:
    bad.append(f"the MSA stored a selection ({R.get('storedSelection')!r}) -"
               " buildSelectionMask reads that field, and anything but null"
               " dims columns. An empty Map is the worst of them: it means dim"
               " EVERYTHING")
# 🔴 AND THE PIXEL PAIR PRINTED ABOVE IS CONTEXT, NOT A CHECK. It was written
# as the control - "a stored null with the canvas still dim would pass on the
# field alone" - and it CANNOT FAIL: this probe measures the COVERAGE view,
# deliberately, because it is the one view that always shows the whole alignment
# (the MSA view is 10px a column and scrolled, so on 247+247 the boundary sits a
# thousand pixels off the right edge). The coverage view does not read the
# selection mask, so it did not dim before this change either. Forcing the
# empty-Map "dim everything" state moves it by zero pixels, which is what an
# assertion that asserts nothing looks like from the inside.
#
# The stored field IS the check: buildSelectionMask reads it and nothing else
# decides the dimming.

if bad:
    for b in bad:
        print("FAIL " + b)
    sys.exit(1)
print("  ok")
