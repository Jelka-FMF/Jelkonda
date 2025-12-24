importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.js");

let pyodide = null;

// --- Javascript Helpers (Bridge) ---
self.pyPrint = function(text) {
    postMessage({type: "print", text: text});
}


self.pyRender = function(bytesProxy) {
    // Convert Python bytes/bytearray to JS Uint8Array
    const data = bytesProxy.toJs(); 
    bytesProxy.destroy();
    
    // Transfer the buffer (zero-copy) to main thread
    postMessage({type: "render", colors: data}, [data.buffer]);
}

async function initPyodideEnvironment() {
    try {
        pyodide = await loadPyodide();

        // 1. Fetch Configuration & Data in parallel
        const [posResponse, libsResponse] = await Promise.all([
            fetch("positions.csv"),
            fetch("libraries.json")
        ]);

        if (!posResponse.ok) console.warn("Missing positions.csv");
        if (!libsResponse.ok) throw new Error("Missing libraries.json - Run update_libs.py!");

        const csvContent = await posResponse.text();
        const libs = await libsResponse.json();

        // Write CSV to FS
        pyodide.FS.writeFile("positions.csv", csvContent);

        // 2. Load Libraries
        // Load numpy first (standard)
        await pyodide.loadPackage(["micropip", "numpy", "packaging"]);
        const micropip = pyodide.pyimport("micropip");
        
        // Install Jelka wheels from configuration
        // We look for 'jelka_validator' and 'jelka' keys in the JSON
        if (libs.jelka_validator) await micropip.install(libs.jelka_validator);
        if (libs.jelka) await micropip.install(libs.jelka);
        // 3. Configure Environment
        await pyodide.runPythonAsync(`
import sys
import time
import js
import os
import jelka
import jelka_validator.datawriter

os.environ["JELKA_POSITIONS"] = "positions.csv"
# --- 1. Time-Buffered Console ---
# Collects all prints and sends them in a single batch max 10 times per second.
class TimeBufferedConsole:
    def __init__(self):
        self.buffer = []
        self.last_flush_time = 0
        self.FLUSH_INTERVAL = 0.1  # 10Hz
        self.MAX_BUFFER_SIZE = 5000
        
    def write(self, t):
        self.buffer.append(t)
        if len(self.buffer) > self.MAX_BUFFER_SIZE:
            self.force_flush()
            
    def flush(self):
        # Time-gated flush (called automatically by print)
        # We ignore this most of the time to prevent UI freezing
        now = time.time()
        if now - self.last_flush_time >= self.FLUSH_INTERVAL:
            self.force_flush()
            
    def force_flush(self):
        # Immediate flush (called at end of script)
        if not self.buffer: return
        
        full_text = "".join(self.buffer)
        js.pyPrint(full_text)
        
        self.buffer = []
        self.last_flush_time = time.time()

# Replace sys.stdout and stderr
sys.stdout = TimeBufferedConsole()

# --- 2. Patch Micropip (Performance) ---
import micropip
original_install = micropip.install
async def fast_install(packages, **kwargs):
    # Optimization: if already loaded by worker init, skip the slow checks
    try:
        await original_install(packages, **kwargs)
    except Exception as e:
        print(f"Package load warning: {e}")
micropip.install = fast_install

# --- 3. Synchronous Sleep ---
def sync_sleep(sec):
    start = time.time()
    while time.time() - start < sec: pass 
time.sleep = sync_sleep

# --- 4. Optimized DataWriter ---
class BrowserDataWriter:
    def __init__(self, number_of_lights):
        self.last_frame_time = 0
        self.target_frame_time = 1.0 / 60.0

    def write_frame(self, frame_data):
        flat_bytes = bytearray()
        for color in frame_data:
            flat_bytes.extend(color)
            
        js.pyRender(flat_bytes)
        
        # Try to flush logs (rate limited)
        sys.stdout.flush()

        # Blocking Delay
        now = time.time()
        elapsed = now - self.last_frame_time
        if elapsed < self.target_frame_time:
            time.sleep(self.target_frame_time - elapsed)
        self.last_frame_time = time.time()

jelka_validator.datawriter.DataWriter = BrowserDataWriter

print("[System] Environment Ready (Numpy Pre-loaded).")
        `);

        postMessage({type: 'ready'});

    } catch (e) {
        postMessage({type: 'error', text: "System Init Error: " + e.toString()});
    }
}

initPyodideEnvironment();

self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.cmd === 'init') {
        postMessage({type: 'init_complete'});
    }
    else if (msg.cmd === 'run') {
        if (!pyodide) return;
        try {
            await pyodide.runPythonAsync(msg.code);
            
            // --- FIX IS HERE ---
            // Force flush stdout/stderr to ensure final prints are shown
            await pyodide.runPythonAsync(`
import sys
if hasattr(sys.stdout, 'force_flush'): sys.stdout.force_flush()
if hasattr(sys.stderr, 'force_flush'): sys.stderr.force_flush()
            `);
            
            postMessage({type: 'finished'});
        } catch (err) {
            if (!err.toString().includes("KeyboardInterrupt")) {
                postMessage({type: 'error', text: err.toString()});
            }
        }
    }
};
