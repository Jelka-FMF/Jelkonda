importScripts("https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js");

let pyodide = null;
self.pos = []; 

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
        
        // 1. Create the 'jelka' package directory
        pyodide.FS.mkdir('/home/pyodide/jelka');

        // 2. Define jelka/types.py
        pyodide.FS.writeFile('/home/pyodide/jelka/types.py', `
from typing import Tuple, Union
Color = Tuple[int, int, int]
Position = Tuple[float, float, float]
RGB = Tuple[int, int, int]
        `);

        // 3. Define jelka/shapes.py
        pyodide.FS.writeFile('/home/pyodide/jelka/shapes.py', `
import math

def distance(p1, p2):
    return math.sqrt((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2 + (p1[2]-p2[2])**2)

class Shape:
    def contains(self, pos): return False

class Sphere(Shape):
    def __init__(self, center, radius):
        self.center = center
        self.radius = radius
    def contains(self, pos):
        return distance(pos, self.center) <= self.radius

class Cylinder(Shape):
    def __init__(self, center, radius, height, axis='z'):
        self.center = center
        self.radius = radius
        self.height = height
        self.axis = axis
    def contains(self, pos):
        x, y, z = pos
        cx, cy, cz = self.center
        if self.axis == 'z':
            if not (cz <= z <= cz + self.height): return False
            dist_sq = (x - cx)**2 + (y - cy)**2
            return dist_sq <= self.radius**2
        return False
        `);

        // 4. Define jelka/core.py
        pyodide.FS.writeFile('/home/pyodide/jelka/core.py', `
import js
import sys
from .types import Color, Position

class Jelka:
    def __init__(self):
        if hasattr(js, 'pos'):
            self.positions = js.pos.to_py()
        else:
            self.positions = []
        self.colors = [(0, 0, 0)] * len(self.positions)

    def __len__(self): return len(self.positions)
    def __getitem__(self, i) -> Color: return self.colors[i]
    def __setitem__(self, k, v: Color): 
        if 0 <= k < len(self.colors): 
            self.colors[k] = (int(v[0]), int(v[1]), int(v[2]))

    @property
    def leds(self): return self.colors

    def show(self):
        flat = [c for rgb in self.colors for c in rgb]
        js.pyRender(flat)
        `);

        // 5. Define jelka/__init__.py
        pyodide.FS.writeFile('/home/pyodide/jelka/__init__.py', `
from .core import Jelka
from .types import Color, Position
from .shapes import Sphere, Cylinder
        `);

        // 6. Bootstrap
        await pyodide.runPythonAsync(`
import sys, time, js
class Console:
    def write(self, t): js.pyPrint(t)
    def flush(self): pass
sys.stdout = Console()
sys.stderr = Console()

def sync_sleep(sec):
    start = time.time()
    while time.time() - start < sec: pass
time.sleep = sync_sleep
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
        self.pos = msg.pos;
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
