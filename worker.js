importScripts("https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js");

let pyodide = null;

// --- Javascript Helpers (Bridge) ---
self.pyPrint = function(text) {
    postMessage({type: "print", text: text});
}

self.pyRender = function(colorsProxy) {
    const colors = colorsProxy.toJs();
    colorsProxy.destroy();
    postMessage({type: "render", colors: colors});
}

async function initPyodideEnvironment() {
    try {
        pyodide = await loadPyodide();
        
        // 1. Fetch positions.csv from the server
        // We do this before loading the library so the file exists when the library looks for it.
        try {
            const response = await fetch("positions.csv");
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const csvContent = await response.text();
            
            // Write to the root of the virtual filesystem (equivalent to ~/)
            pyodide.FS.writeFile("positions.csv", csvContent);
        } catch (err) {
            postMessage({type: "print", text: "⚠️ Warning: Could not load positions.csv from server: " + err.message});
        }

        // 2. Load Micropip and Install Wheels
        await pyodide.loadPackage("micropip");
        const micropip = pyodide.pyimport("micropip");
        
        // Ensure these files exist in the same directory as worker.js
        await micropip.install("jelka_validator-1.0.2-py3-none-any.whl");
        await micropip.install("jelka-0.0.6-py3-none-any.whl");

        // 3. Configure Environment & Patch Output Only
        // We DO NOT patch load_positions anymore. The library will read the file we wrote above.
        await pyodide.runPythonAsync(`
import sys
import time
import js

# Import the installed libraries
import jelka
import jelka_validator.datawriter

# --- 1. Redirect Stdout ---
class Console:
    def write(self, t): js.pyPrint(t)
    def flush(self): pass
sys.stdout = Console()
sys.stderr = Console()

# --- 2. Synchronous Sleep ---
def sync_sleep(sec):
    start = time.time()
    while time.time() - start < sec: pass
time.sleep = sync_sleep

# --- 3. Patch DataWriter (Output) ---
# We MUST patch this to redirect the light data to the browser canvas 
# instead of trying to write to a real hardware controller.
class BrowserDataWriter:
    def __init__(self, number_of_lights):
        pass
        
    def write_frame(self, frame_data):
        # frame_data is a list of objects (likely Color namedtuples or similar)
        # Flatten for JS transfer: [r, g, b, r, g, b...]
        flat = []
        for color in frame_data:
            # Assuming color is iterable (tuple/list)
            flat.extend(color)
        js.pyRender(flat)

# Replace the class in the module
jelka_validator.datawriter.DataWriter = BrowserDataWriter

print("[System] Environment Ready. Loaded positions.csv to virtual filesystem.")
        `);
        
        postMessage({type: 'ready'});

    } catch (e) {
        postMessage({type: 'error', text: "System Init Error: " + e.toString()});
    }
}

// Start loading
initPyodideEnvironment();

// --- Message Handling ---
self.onmessage = async (e) => {
    const msg = e.data;
    
    if (msg.cmd === 'init') {
        // We don't need to do anything with the positions passed from JS anymore,
        // because Python now reads the CSV file directly.
        // We just signal completion.
        postMessage({type: 'init_complete'});
    }
    else if (msg.cmd === 'run') {
        if (!pyodide) return;
        try {
            await pyodide.runPythonAsync(msg.code);
            postMessage({type: 'finished'});
        } catch (err) {
            if (!err.toString().includes("KeyboardInterrupt")) {
                postMessage({type: 'error', text: err.toString()});
            }
        }
    }
};
