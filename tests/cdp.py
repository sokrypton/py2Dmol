"""A minimal CDP client: just enough WebSocket to drive headless Chrome.

🔴 IT EXISTS BECAUSE --window-size CLAMPS AT 500px. Measured: --window-size=390
and =320 both report an innerWidth of 500, --headless=old clamps identically,
and --force-device-scale-factor does not help because --window-size is already
in CSS pixels. A responsive layout that is only ever measured at 500 is not
measured at all - the whole band a phone lives in is below it.

Emulation.setDeviceMetricsOverride gives a TRUE viewport at any width, and
Page.captureScreenshot gives an image, which is the other thing the flag-only
harness cannot do: --screenshot never returns on a page with a running rAF
loop, and --virtual-time-budget does not end one either.

No dependency: the WebSocket framing below is about sixty lines, against
adding websockets/playwright to a project that has none.
"""
import base64, json, os, socket, struct, subprocess, time, urllib.request, shutil


class WS:
    def __init__(self, url):
        _, rest = url.split("://", 1)
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)))
        self.s.settimeout(60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(("GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
                        "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
                        "Sec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.id = 0

    def _recv(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d: raise IOError("closed")
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, obj):
        p = json.dumps(obj).encode()
        h = bytearray([0x81])
        n = len(p)
        if n < 126: h.append(0x80 | n)
        elif n < 65536: h.append(0x80 | 126); h += struct.pack(">H", n)
        else: h.append(0x80 | 127); h += struct.pack(">Q", n)
        m = os.urandom(4); h += m
        self.s.sendall(bytes(h) + bytes(b ^ m[i % 4] for i, b in enumerate(p)))

    def recv(self):
        payload = b""
        while True:
            b0, b1 = self._recv(2)
            fin, op = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126: n = struct.unpack(">H", self._recv(2))[0]
            elif n == 127: n = struct.unpack(">Q", self._recv(8))[0]
            payload += self._recv(n)
            if fin: break
        return json.loads(payload) if payload else {}

    def call(self, method, **params):
        self.id += 1
        mid = self.id
        self.send({"id": mid, "method": method, "params": params})
        while True:
            m = self.recv()
            if m.get("id") == mid:
                if "error" in m: raise RuntimeError("%s: %s" % (method, m["error"]))
                return m.get("result", {})


def launch(port, profile):
    shutil.rmtree(profile, ignore_errors=True)
    p = subprocess.Popen(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--headless=new", "--user-data-dir=" + profile, "--no-first-run",
        "--hide-scrollbars", "--remote-debugging-port=%d" % port, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.time() + 25
    while time.time() < end:
        try:
            js = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port))
            for t in js:
                if t.get("type") == "page": return p, WS(t["webSocketDebuggerUrl"])
        except Exception: time.sleep(0.3)
    p.kill(); raise RuntimeError("no CDP target")


def evaluate(ws, expr, await_promise=True):
    r = ws.call("Runtime.evaluate", expression=expr, awaitPromise=await_promise,
                returnByValue=True)
    if "exceptionDetails" in r:
        raise RuntimeError(str(r["exceptionDetails"].get("exception", {}).get("description")))
    return r["result"].get("value")


def wait_for(ws, expr, timeout=45, what=""):
    """Poll until an expression is truthy.

    🔴 A FIXED SLEEP IS NOT A WAIT. `time.sleep(3.5)` after a navigate passed
    every time this ran alone and failed in the suite, where the ui lane starts
    a dozen browsers at once and the page had not finished its 34 scripts:
    `window.processFiles is not a function`. A probe that only passes when the
    machine is idle is worse than no probe.
    """
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            if evaluate(ws, expr, False):
                return True
        except Exception as e:
            last = e
        time.sleep(0.25)
    raise RuntimeError("timed out waiting for %s%s"
                       % (what or expr, (" (last: %s)" % last) if last else ""))
