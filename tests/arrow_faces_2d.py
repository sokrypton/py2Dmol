"""THE 2D PAINTER DRAWS AN ARROWHEAD'S FACES WHERE THE GPU DOES.

    python3 tests/arrow_faces_2d.py [--measure]

Four views of two short strands of 6MRR, each saved by a reader who could see
a face missing in the CPU render that the GPU drew. They are the specification:
each is loaded through the app's own session loader, drawn by both painters in
ONE page load, and the two pictures compared - with the pencil OFF, because its
grain is noise laid over exactly the thing being compared.

WHAT EACH ONE GUARDS, measured by taking each fix back out (px differing
between the painters; the bound is in brackets):

                       09-46-27  09-48-01  09-56-52  10-05-33
    as shipped            115       310       181       176
    forced top/bottom     147       310       181     1,215   (paint2d)
    winding cull off      115     1,297       181       176   (paint2d)
    square tip off        384       320       181       368   (geom.js)
    both paint2d fixes    147     1,297       181     1,193
    bound                (250)     (600)     (330)     (270)

  🔴 THE SHIPPED ROW MOVED, AND NOT BECAUSE ANY OF THESE FACES DID. Centring
  every colour mode on its residue (`deb3bb3`) put a colour BOUNDARY in the
  middle of every interval, where before these views had one flat colour per
  interval - and the two painters antialias that step a pixel apart along its
  whole length. Proved rather than assumed: with the split forced off and
  every other part of that change in place, all four views read 52 / 190 /
  165 / 85, which is what they read before it. Two thirds of the first jump
  was the OUTLINE taking the half's palette slot instead of the segment's;
  that is fixed in cartoon/paintgl.js (`palInk`), and the rest is the step.

  🔴 AND 09-56-52 NO LONGER SEPARATES ANYTHING - it reads 181 under every
  mutation above. That is NOT from the colour change: measured at `7b3438d`,
  before it, the same view reads 165 shipped and 165 with both paint2d fixes
  taken out, against the 502 recorded here when the table was written at
  `f480c1b`. Something between those two commits took its catch away and
  nobody noticed, because the bound is loose enough that the view went on
  passing. It is kept as a sentinel on the ordinary case - a long strand at
  Detail 4 - and it is not evidence for either painter fix any more. Every
  mutation is still caught by at least one other view: forced top/bottom and
  the square tip by 10-05-33, the winding cull by 09-48-01, the square tip
  again by 09-46-27.

  * THE FORCED TOP/BOTTOM FACES. `if (g.arrow) showTop = showBot = true`
    drew the arrow's back-facing broad face, and seen from behind and below
    it painted over the head's back edge: a teal sliver where the GPU draws a
    white card edge.
  * THE WINDING CULL. An arrowhead's side strips are culled quad by quad by
    their projected winding, because a slanted barb edge and the back edge -
    a quad between two stations at one point - do not face along n, which is
    all oN describes. Culled by oN, a whole strip and its card edge went.
  * THE SQUARE TIP (geom.js, `tipHW`). These three views are Detail 2, where
    the head now ends at the width of the loop after it and the loop carries
    on from its flat end. Taken back to a point, the loop starts at its own
    width where the head is 0.06 wide - a step between two intervals with no
    face across it, an open tube at the tip. Above the floor the point stays
    and a WALL closes the step (`tipStep`); tests/ss_arrow_shape.py guards
    that, and what a wall at the floor would cost a loop's curve.
  * 09-56-52, a six-residue strand at Detail 4, is covered by EITHER painter
    fix on its own, so only taking both out shows it. It is kept because it
    is the ordinary case - a long strand, not a two-residue one.

The number asserted is pixels differing by more than 60 in some channel
between the two painters. It is never zero - the painters shade differently
and antialias edges differently - so the bounds sit between the shipped value
and the nearest broken one. The thinnest is 10-05-33's, 176 shipped against
368 with the point back, bound 270.

THE VIEWS ARE INLINE, trimmed to the cutout object, because *.json is
gitignored: a test whose input is not tracked is a test nobody else can run.
"""
import json, os, shutil, sys, http.server, socketserver, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE = os.path.join(ROOT, "_arrowfaces2d.html")
PORT, DEBUG_PORT = 9825, 9826
MEASURE = '--measure' in sys.argv

VIEWS = {
    '09-46-27': '{"version":"2.0","config":{"viewer_id":"standalone-viewer-1","display":{"size":[600,600],"follow":false,"rotate":false,"autoplay":false,"controls":true,"box":true,"background":"white"},"rendering":{"style":"cartoon","detail":2,"gpuDirect":true,"shadow":true,"shadow_strength":0.5,"outline":"full","ortho":0.5,"cyclic":false,"gpu":false,"width":3,"preset":"richardson","thickness":0.7,"smooth":true,"arrows":true,"sheet_flat":0,"pencil":1,"highlight":3,"outline_tint":0.8,"shade":0.7},"color":{"mode":"auto","colorblind":false},"heatmap":{"enabled":true,"size":300},"scatter":{"enabled":false,"size":340},"overlay":{"enabled":false},"selection":{"enabled":true},"ui":{"biounit":true,"loadLigands":true,"filterAdditives":true},"pae":{"enabled":true,"size":300}},"objects":[{"name":"6MRR_A34-37","frames":[{"coords":[[-13.72,-6.18,3.5],[-16.34,-6.71,0.81],[-15.53,-6.62,-2.9],[-18.17,-7.08,-5.6]],"plddts":[10,11,11,11],"name":"6MRR.cif","residue_numbers":[34,35,36,37],"position_names":["LEU","GLU","VAL","ARG"]}],"hasPAE":false,"chains":["A","A","A","A"],"position_types":["P","P","P","P"],"scatter_config":{"xlabel":"X","ylabel":"Y","xlim":null,"ylim":null},"sse":{"0":"C","1":"E","2":"E","3":"C"},"viewerState":{"rotation":[[0.02667241289224979,0.8783270066511517,-0.4773156730903845],[-0.9444257300306196,-0.13435861148352968,-0.30001300634529554],[-0.32764099689542875,0.45879127379173285,0.8259309561010036]],"zoom":1,"ortho":0.5,"focalLength":82.58031716967277,"center":null,"extent":null,"currentFrame":0,"clipNear":null,"clipFar":null,"clipFade":0.1,"style":"cartoon","styleChosen":false}}],"current_object":"6MRR_A34-37","viewer_state":{"current_object_name":"6MRR_A34-37","shown_objects":null,"current_frame":0,"rotation_matrix":[[0.02667241289224979,0.8783270066511517,-0.4773156730903845],[-0.9444257300306196,-0.13435861148352968,-0.30001300634529554],[-0.32764099689542875,0.45879127379173285,0.8259309561010036]],"zoom":1,"ortho":0.5,"focal_length":82.58031716967277,"center":null,"extent":null,"color_mode":"auto","ss_palette":"pymol","line_width":3,"shadow_enabled":true,"shade":0.7,"outline_mode":"full","colorblind_mode":false,"cyclic":false,"ortho_slider_value":0.5,"animation_speed":100,"style":"cartoon","preset":"richardson","thickness":0.7,"detail":2,"smooth":true,"use_gpu":false,"arrows":true,"sheet_flat":0,"pencil":1,"highlight":3,"outline_tint":0.8},"selections_by_object":{}}',
    '09-48-01': '{"version":"2.0","config":{"viewer_id":"standalone-viewer-1","display":{"size":[600,600],"follow":false,"rotate":false,"autoplay":false,"controls":true,"box":true,"background":"white"},"rendering":{"style":"cartoon","detail":2,"gpuDirect":true,"shadow":true,"shadow_strength":0.5,"outline":"full","ortho":0.5,"cyclic":false,"gpu":false,"width":3,"preset":"richardson","thickness":0.7,"smooth":true,"arrows":true,"sheet_flat":0,"pencil":1,"highlight":3,"outline_tint":0.8,"shade":0.7},"color":{"mode":"auto","colorblind":false},"heatmap":{"enabled":true,"size":300},"scatter":{"enabled":false,"size":340,"xlabel":null,"ylabel":null,"xlim":null,"ylim":null},"overlay":{"enabled":false},"selection":{"enabled":true},"ui":{"biounit":true,"loadLigands":true,"filterAdditives":true},"pae":{"enabled":true,"size":300}},"objects":[{"name":"6MRR_A34-37","frames":[{"coords":[[-13.72,-6.18,3.5],[-16.34,-6.71,0.81],[-15.53,-6.62,-2.9],[-18.17,-7.08,-5.6]],"plddts":[10,11,11,11],"name":"6MRR.cif","residue_numbers":[34,35,36,37],"position_names":["LEU","GLU","VAL","ARG"]}],"hasPAE":false,"chains":["A","A","A","A"],"position_types":["P","P","P","P"],"scatter_config":{"xlabel":"X","ylabel":"Y","xlim":null,"ylim":null},"sse":{"0":"C","1":"E","2":"E","3":"C"},"viewerState":{"rotation":[[0.5315121411475786,0.8434282511361358,-0.078253619712718],[-0.8117061089638328,0.5335639323732086,0.23757677230996538],[0.24213227063632056,-0.0627559977680569,0.9682115720546896]],"zoom":1,"ortho":0.5,"focalLength":82.52104305493842,"center":null,"extent":null,"currentFrame":0,"clipNear":null,"clipFar":null,"clipFade":0.1,"style":"cartoon","styleChosen":false}}],"current_object":"6MRR_A34-37","viewer_state":{"current_object_name":"6MRR_A34-37","shown_objects":null,"current_frame":0,"rotation_matrix":[[0.5315121411475786,0.8434282511361358,-0.078253619712718],[-0.8117061089638328,0.5335639323732086,0.23757677230996538],[0.24213227063632056,-0.0627559977680569,0.9682115720546896]],"zoom":1,"ortho":0.5,"focal_length":82.52104305493842,"center":null,"extent":null,"color_mode":"auto","ss_palette":"pymol","line_width":3,"shadow_enabled":true,"shade":0.7,"outline_mode":"full","colorblind_mode":false,"cyclic":false,"ortho_slider_value":0.5,"animation_speed":100,"style":"cartoon","preset":"richardson","thickness":0.7,"detail":2,"smooth":true,"use_gpu":false,"arrows":true,"sheet_flat":0,"pencil":1,"highlight":3,"outline_tint":0.8},"selections_by_object":{}}',
    '09-56-52': '{"version":"2.0","config":{"viewer_id":"standalone-viewer-1","display":{"size":[600,600],"follow":false,"rotate":false,"autoplay":false,"controls":true,"box":true,"background":"white"},"rendering":{"style":"cartoon","detail":4,"gpuDirect":true,"shadow":true,"shadow_strength":0.5,"outline":"full","ortho":0.5,"cyclic":false,"gpu":false,"width":3,"preset":"richardson","thickness":0.7,"smooth":true,"arrows":true,"sheet_flat":1,"pencil":1,"highlight":3,"outline_tint":0.8,"shade":0.7},"color":{"mode":"auto","colorblind":false},"heatmap":{"enabled":true,"size":300},"scatter":{"enabled":false,"size":340},"overlay":{"enabled":false},"selection":{"enabled":true},"ui":{"biounit":true,"loadLigands":true,"filterAdditives":true},"pae":{"enabled":true,"size":300}},"objects":[{"name":"6MRR_A61-68","frames":[{"coords":[[-10.05,-10.37,8.7],[-13.31,-11.38,7.07],[-13.03,-11,3.29],[-16.16,-11.4,1.16],[-15.31,-11.41,-2.55],[-18.08,-11.97,-5.11],[-17.35,-12.1,-8.83],[-20.72,-12.23,-10.58]],"plddts":[10,10,10,10,11,14,16,26],"name":"6MRR.cif","residue_numbers":[61,62,63,64,65,66,67,68],"position_names":["TYR","THR","VAL","ASP","ILE","LYS","ILE","GLU"]}],"hasPAE":false,"chains":["A","A","A","A","A","A","A","A"],"position_types":["P","P","P","P","P","P","P","P"],"scatter_config":{"xlabel":"X","ylabel":"Y","xlim":null,"ylim":null},"sse":{"1":"E","2":"E","3":"E","4":"E","5":"E","6":"E"},"viewerState":{"rotation":[[-0.6664762048827044,0.5979843602817484,-0.44522373385025027],[0.6038093490228112,0.7832469838286112,0.14811627984800313],[0.4372913655193499,-0.170114276831186,-0.8830840245754684]],"zoom":1.577072577812222,"ortho":0.5,"focalLength":158.6480165797834,"center":null,"extent":null,"currentFrame":0,"clipNear":null,"clipFar":null,"clipFade":0.1,"style":"cartoon","styleChosen":false}}],"current_object":"6MRR_A61-68","viewer_state":{"current_object_name":"6MRR_A61-68","shown_objects":null,"current_frame":0,"rotation_matrix":[[-0.6664762048827044,0.5979843602817484,-0.44522373385025027],[0.6038093490228112,0.7832469838286112,0.14811627984800313],[0.4372913655193499,-0.170114276831186,-0.8830840245754684]],"zoom":1.577072577812222,"ortho":0.5,"focal_length":158.6480165797834,"center":null,"extent":null,"color_mode":"auto","ss_palette":"pymol","line_width":3,"shadow_enabled":true,"shade":0.7,"outline_mode":"full","colorblind_mode":false,"cyclic":false,"ortho_slider_value":0.5,"animation_speed":100,"style":"cartoon","preset":"richardson","thickness":0.7,"detail":4,"smooth":true,"use_gpu":false,"arrows":true,"sheet_flat":1,"pencil":1,"highlight":3,"outline_tint":0.8},"selections_by_object":{}}',
    '10-05-33': '{"version":"2.0","config":{"viewer_id":"standalone-viewer-1","display":{"size":[600,600],"follow":false,"rotate":false,"autoplay":false,"controls":true,"box":true,"background":"white"},"rendering":{"style":"cartoon","detail":2,"gpuDirect":true,"shadow":true,"shadow_strength":0.5,"outline":"full","ortho":0.5,"cyclic":false,"gpu":false,"width":3,"preset":"richardson","thickness":0.7,"smooth":true,"arrows":true,"sheet_flat":0,"pencil":1,"highlight":3,"outline_tint":0.8,"shade":0.7},"color":{"mode":"auto","colorblind":false},"heatmap":{"enabled":true,"size":300},"scatter":{"enabled":false,"size":340,"xlabel":null,"ylabel":null,"xlim":null,"ylim":null},"overlay":{"enabled":false},"selection":{"enabled":true},"ui":{"biounit":true,"loadLigands":true,"filterAdditives":true},"pae":{"enabled":true,"size":300}},"objects":[{"name":"6MRR_A34-37","frames":[{"coords":[[-13.72,-6.18,3.5],[-16.34,-6.71,0.81],[-15.53,-6.62,-2.9],[-18.17,-7.08,-5.6]],"plddts":[10,11,11,11],"name":"6MRR.cif","residue_numbers":[34,35,36,37],"position_names":["LEU","GLU","VAL","ARG"]}],"hasPAE":false,"chains":["A","A","A","A"],"position_types":["P","P","P","P"],"scatter_config":{"xlabel":"X","ylabel":"Y","xlim":null,"ylim":null},"sse":{"0":"C","1":"E","2":"E","3":"C"},"viewerState":{"rotation":[[0.13044681684023846,-0.8333233049604704,-0.5371739917252001],[0.08712861149276133,0.5493425759060299,-0.8310423210380141],[0.987619477853479,0.06160360140988996,0.14426629286752063]],"zoom":1,"ortho":0.5,"focalLength":82.52104305493842,"center":null,"extent":null,"currentFrame":0,"clipNear":null,"clipFar":null,"clipFade":0.1,"style":"cartoon","styleChosen":false}}],"current_object":"6MRR_A34-37","viewer_state":{"current_object_name":"6MRR_A34-37","shown_objects":null,"current_frame":0,"rotation_matrix":[[0.13044681684023846,-0.8333233049604704,-0.5371739917252001],[0.08712861149276133,0.5493425759060299,-0.8310423210380141],[0.987619477853479,0.06160360140988996,0.14426629286752063]],"zoom":1,"ortho":0.5,"focal_length":82.52104305493842,"center":null,"extent":null,"color_mode":"auto","ss_palette":"pymol","line_width":3,"shadow_enabled":true,"shade":0.7,"outline_mode":"full","colorblind_mode":false,"cyclic":false,"ortho_slider_value":0.5,"animation_speed":100,"style":"cartoon","preset":"richardson","thickness":0.7,"detail":2,"smooth":true,"use_gpu":false,"arrows":true,"sheet_flat":0,"pencil":1,"highlight":3,"outline_tint":0.8},"selections_by_object":{}}',
}
# between the shipped value and the nearest broken one - see the table above
BOUND = {'09-46-27': 250, '09-48-01': 600, '09-56-52': 330, '10-05-33': 270}

JS = """
  const frame = () => new Promise(r => requestAnimationFrame(
    () => requestAnimationFrame(r)));
  const G = window.py2dmolCartoonGPU;
  if (G && G.setDirectPresent) G.setDirectPresent(false);   // read the blit
  const views = %VIEWS%;
  const out = {};
  for (const [tag, text] of Object.entries(views)) {
    if (tag !== %TAG%) continue;
    await window.loadViewerState(JSON.parse(text));
    await new Promise(r => setTimeout(r, 1500));
    const r = window.py2dmol_viewers['standalone-viewer-1'].renderer;
    r.autoRotate = false;
    const box = document.querySelector('.py2dmol-slot--big > .py2dmol-slot-body')
      || document.getElementById('canvasContainer');
    if (box) { box.style.width = '520px'; box.style.height = '520px'; }
    await new Promise(r2 => setTimeout(r2, 800));
    const shot = async (gpu) => {
      r.useGPU = gpu;
      r.cartoonPencil = 0;
      r.invalidate && r.invalidate();
      r._invalidateSegmentCache && r._invalidateSegmentCache();
      r.render('probe'); await frame(); await frame(); await frame();
      const c = r.canvas;
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const A = await shot(false);
    const B = await shot(true);
    let diff = 0, ink = 0, paper = 0;
    for (let p = 0; p < A.length; p += 4) {
      const d = Math.max(Math.abs(A[p] - B[p]), Math.abs(A[p + 1] - B[p + 1]),
                         Math.abs(A[p + 2] - B[p + 2]));
      if (d > 60) diff++;
      // ink is OPAQUE and not paper: a canvas read before anything was drawn
      // is transparent black, which every other test here calls a drawing
      if (A[p + 3] > 200) {
        if (A[p] > 245 && A[p + 1] > 245 && A[p + 2] > 245) paper++;
        else ink++;
      }
    }
    out[tag] = {diff, ink, paper, w: r.canvas.width, h: r.canvas.height,
                loaded: r.currentObjectName === JSON.parse(text).current_object};
  }
  return out;
"""
JS = JS.replace('%VIEWS%', json.dumps(VIEWS))

open(PROBE, 'w').write(open(os.path.join(ROOT, 'dev.html')).read())


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()

proc = None
R = {}
try:
    proc, ws = cdp.launch(DEBUG_PORT, '/tmp/py2dmol-arrow-faces-2d')
    ws.call('Page.enable'); ws.call('Runtime.enable')
    ws.call('Emulation.setDeviceMetricsOverride', width=1100, height=1000,
            deviceScaleFactor=1, mobile=False)
    # 🔴 ONE PAGE LOAD PER VIEW. Loaded one after another into the same page,
    # the third view measured 1,149 px against 166 on its own - something from
    # the views before it survives the session loader's clear. What a reader
    # sees is a state opened on its own, so that is what is measured; the leak
    # is a separate question from the faces.
    for tag in VIEWS:
        ws.call('Page.navigate',
                url='http://127.0.0.1:%d/_arrowfaces2d.html' % PORT)
        # 🔴 THE LOADER EXISTS BEFORE THE VIEWER DOES. loadViewerState is
        # defined the moment its script is parsed, and called before the viewer
        # is built it loads nothing and says nothing - the first version of
        # this file compared two empty canvases, found them identical, passed.
        cdp.wait_for(ws, "typeof window.loadViewerState === 'function'"
                     " && !!(window.py2dmol_viewers || {})['standalone-viewer-1']",
                     what="the viewer to exist")
        R.update(cdp.evaluate(ws, '(async () => {\n'
                              + JS.replace('%TAG%', json.dumps(tag))
                              + '\n})()') or {})
finally:
    if proc: proc.kill()
    httpd.shutdown()
    if os.path.exists(PROBE): os.remove(PROBE)
    shutil.rmtree('/tmp/py2dmol-arrow-faces-2d', ignore_errors=True)

bad = []
if len(R) != len(VIEWS):
    bad.append("measured %d of %d views" % (len(R), len(VIEWS)))
for tag, v in R.items():
    print("  %s: %5d px differ, %6d px inked, %6d paper, canvas %dx%d"
          % (tag, v['diff'], v['ink'], v['paper'], v['w'], v['h']))
    if MEASURE:
        continue
    # 🔴 AND A BLANK CPU PICTURE IS NOT A MATCH. Two painters that both drew
    # nothing agree perfectly; the ink count is what says there was a drawing.
    if not v['loaded']:
        bad.append("%s: the saved view never loaded" % tag)
    elif (min(v['w'], v['h']) < 300 or v['ink'] < 2000
            or v['paper'] < v['w'] * v['h'] * 0.3):
        bad.append("%s: nothing worth comparing was drawn (%d px inked on a"
                   " %dx%d canvas)" % (tag, v['ink'], v['w'], v['h']))
    elif v['diff'] > BOUND[tag]:
        bad.append("%s: the 2D painter differs from the GPU in %d px (bound"
                   " %d) - a face the GPU draws is missing, or one it culls is"
                   " drawn" % (tag, v['diff'], BOUND[tag]))
if bad:
    for b in bad: print('FAIL:', b)
    sys.exit(1)
print('arrow faces 2d: the CPU draws the faces the GPU draws'
      + (' (measured only)' if MEASURE else ''))
