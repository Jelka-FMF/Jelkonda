const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.0/full/";
importScripts(PYODIDE_URL + "pyodide.js");

let pyodide = null;
let interruptBuffer = null;

// Set by a 'stop' message. Python checks it on every sleep / frame, which lets
// us stop a pattern without terminating the worker and reloading Pyodide.
self.stopRequested = false;

// --- Javascript Helpers (Bridge) ---
self.pyPrint = function(text, stream) {
    postMessage({type: "print", text: text, stream: stream});
}

self.pyRender = function(bytesProxy) {
    // Convert Python bytes to JS Uint8Array (one copy)
    const data = bytesProxy.toJs();
    bytesProxy.destroy();

    // Transfer the buffer (zero-copy) to main thread
    postMessage({type: "render", colors: data}, [data.buffer]);
}

// Blocking sleep without burning CPU. Only possible when SharedArrayBuffer is
// available (page served cross-origin isolated); otherwise Python busy-waits.
const sleepCell = self.crossOriginIsolated ? new Int32Array(new SharedArrayBuffer(4)) : null;
self.atomicSleep = sleepCell ? (ms) => { Atomics.wait(sleepCell, 0, 0, ms); } : null;

async function initPyodideEnvironment() {
    try {
        // Start fetching config while Pyodide boots
        const posPromise = fetch("positions.csv").then(r => r.ok ? r.text() : null);
        const libsPromise = fetch("libraries.json").then(r => {
            if (!r.ok) throw new Error("Missing libraries.json - Run setup.py!");
            return r.json();
        });

        pyodide = await loadPyodide();
        const [csvContent, libs] = await Promise.all([posPromise, libsPromise]);

        if (csvContent === null) console.warn("Missing positions.csv");
        else pyodide.FS.writeFile("positions.csv", csvContent);

        // 1. Load Libraries. Other packages (numpy, ...) are loaded on demand
        // from the imports of the script being run.
        await pyodide.loadPackage("micropip");
        const micropip = pyodide.pyimport("micropip");
        if (libs.jelka_validator) await micropip.install(libs.jelka_validator);
        if (libs.jelka) await micropip.install(libs.jelka);

        // 2. Configure Environment
        await pyodide.runPythonAsync(`
import sys
import time
import asyncio
import itertools
import js
import os
import jelka
import jelka_validator.datawriter
from pyodide.ffi import can_run_sync, run_sync

os.environ["JELKA_POSITIONS"] = "positions.csv"

# --- 1. Time-Buffered Console ---
# Collects all prints and sends them in a single batch max 10 times per second.
class TimeBufferedConsole:
    FLUSH_INTERVAL = 0.1  # 10Hz
    MAX_BUFFER_SIZE = 5000

    def __init__(self, stream):
        self.stream = stream
        self.buffer = []
        self.last_flush_time = 0

    def write(self, t):
        self.buffer.append(t)
        # Time-based flushes only at line ends, so a print() is never split
        if len(self.buffer) > self.MAX_BUFFER_SIZE or (t.endswith("\\n") and time.time() - self.last_flush_time >= self.FLUSH_INTERVAL):
            self.force_flush()
        return len(t)

    def flush(self):
        # Time-gated flush (called by print(flush=True) and every frame)
        if time.time() - self.last_flush_time >= self.FLUSH_INTERVAL:
            self.force_flush()

    def force_flush(self):
        # Immediate flush (called at end of script)
        self.last_flush_time = time.time()
        if not self.buffer: return
        full_text = "".join(self.buffer)
        self.buffer = []
        js.pyPrint(full_text, self.stream)

    def isatty(self):
        return False

sys.stdout = TimeBufferedConsole("stdout")
sys.stderr = TimeBufferedConsole("stderr")

# --- 2. Patch Micropip ---
import micropip
original_install = micropip.install
async def safe_install(packages, **kwargs):
    try:
        await original_install(packages, **kwargs)
    except Exception as e:
        print(f"Package load warning: {e}")
micropip.install = safe_install

# --- 3. Sleep ---
# Preferred: JSPI (run_sync) suspends Python and yields to the JS event loop, so
# no CPU is burned and 'stop' messages are received while the pattern sleeps.
def check_stop():
    if js.stopRequested:
        raise KeyboardInterrupt("Stopped")

# Timers overshoot by a few ms, so yield for most of the time and busy-wait
# only the last SPIN_MARGIN seconds to keep the frame rate accurate.
SPIN_MARGIN = 0.004

def browser_sleep(sec):
    end = time.perf_counter() + sec
    coarse = sec - SPIN_MARGIN
    if coarse > 0:
        if can_run_sync():
            run_sync(asyncio.sleep(coarse))
        elif js.atomicSleep:
            js.atomicSleep(coarse * 1000)
    while time.perf_counter() < end: pass
    check_stop()
time.sleep = browser_sleep

# --- 4. Browser DataWriter ---
# Frame pacing is done by Jelka.run itself, so this only ships the frame.
class BrowserDataWriter:
    def __init__(self, number_of_lights, *args, **kwargs):
        pass

    def write_frame(self, frame_data):
        js.pyRender(bytes(itertools.chain.from_iterable(frame_data)))
        sys.stdout.flush()
        sys.stderr.flush()
        check_stop()

jelka_validator.datawriter.DataWriter = BrowserDataWriter

def flush_all():
    sys.stdout.force_flush()
    sys.stderr.force_flush()

# --- 5. Script Runner ---
# Exceptions are caught here rather than in JS: Pyodide would otherwise print
# the traceback to stderr and leave PythonError.message empty. Returns
# (status, text) with status "finished" | "stopped" | "error".
import traceback
from pyodide.code import eval_code_async

async def run_user(code):
    status, text = "finished", ""
    try:
        # Fresh namespace per run, so state does not leak between runs
        await eval_code_async(code, {"__name__": "__main__"}, filename="pattern.py")
    except KeyboardInterrupt:
        status = "stopped"
    except SystemExit as e:
        if e.code not in (None, 0):
            status, text = "error", f"SystemExit: {e.code}"
    except BaseException as e:
        # Drop Pyodide-internal frames so the traceback starts at the user's code
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "pattern.py":
            tb = tb.tb_next
        status, text = "error", "".join(traceback.format_exception(type(e), e, tb))
    flush_all()
    return [status, text]

print("[System] Environment Ready.")
flush_all()
        `);

        postMessage({type: 'ready'});

    } catch (e) {
        postMessage({type: 'error', text: "System Init Error: " + e.toString()});
    }
}

// Map of import name -> Pyodide package, built from the lock file. Used
// instead of loadPackagesFromImports, which in 0.29 resolves `import numpy`
// to the `numpy-tests` package (both claim the "numpy" import name).
let importMap = null;

async function loadImportedPackages(code) {
    if (!importMap) {
        const lock = await (await fetch(PYODIDE_URL + "pyodide-lock.json")).json();
        importMap = new Map();
        for (const [name, pkg] of Object.entries(lock.packages)) {
            if (name.endsWith("-tests")) continue;
            for (const imp of pkg.imports || []) {
                if (!importMap.has(imp)) importMap.set(imp, name);
            }
        }
    }

    let imports = [];
    const findImports = pyodide.pyimport("pyodide.code").find_imports;
    try {
        const proxy = findImports(code);
        imports = proxy.toJs();
        proxy.destroy();
    } catch (e) {
        // Syntax error: let the run itself report it
    } finally {
        findImports.destroy();
    }

    const needed = [...new Set(imports.map(i => importMap.get(i.split(".")[0])))]
        .filter(name => name && !(name in pyodide.loadedPackages));
    if (needed.length === 0) return;

    await pyodide.loadPackage(needed, {
        messageCallback: (m) => postMessage({type: 'print', text: m, stream: 'sys'}),
        errorCallback: (m) => postMessage({type: 'print', text: m, stream: 'stderr'}),
    });
}

const initPromise = initPyodideEnvironment();

self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.cmd === 'stop') {
        self.stopRequested = true;
    }
    else if (msg.cmd === 'init') {
        await initPromise;
        if (msg.csv && pyodide) pyodide.FS.writeFile("positions.csv", msg.csv);
        // Cross-origin isolated pages can interrupt even tight loops instantly
        if (msg.interruptBuffer && pyodide) {
            interruptBuffer = msg.interruptBuffer;
            pyodide.setInterruptBuffer(interruptBuffer);
        }
        postMessage({type: 'init_complete'});
    }
    else if (msg.cmd === 'run') {
        if (!pyodide) return;
        self.stopRequested = false;
        if (interruptBuffer) interruptBuffer[0] = 0;
        const runUser = pyodide.globals.get('run_user');
        try {
            await loadImportedPackages(msg.code);
            const res = await runUser(msg.code);
            const [status, text] = res.toJs();
            res.destroy();
            if (status === 'error') postMessage({type: 'error', text: text});
            else postMessage({type: status});
        } catch (err) {
            postMessage({type: 'error', text: String(err)});
        } finally {
            runUser.destroy();
        }
    }
};
