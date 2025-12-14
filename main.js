// main.js

// --- Global State ---
let positions = window.initialPositions || {};
let colorStates = [];
let worker = null;
let workerReady = false;
let editor = null;
let pendingRunCode = null;
let isRunning = false;

const STORAGE_KEY = 'jelka_saved_code';

const defaultCode = `import math

from jelka import Jelka
from jelka.types import Color


def callback(jelka: Jelka):
    for light, position in jelka.positions_normalized.items():
        jelka.set_light(
            light,
            Color(
                (position[0] * 255 + math.sin((jelka.elapsed_time + 1) / 4) * 255 + 256) % 256,
                (position[1] * 255 + math.sin((jelka.elapsed_time + 2) / 4) * 255 + 256) % 256,
                (position[2] * 255 + math.sin(jelka.elapsed_time / 4) * 255 + 256) % 256,
            ).vivid(),
        )


def main():
    jelka = Jelka(60)
    jelka.run(callback)


main()
`;

// --- Monaco Editor ---
require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' }});
require(['vs/editor/editor.main'], function() {
    
    // Check Local Storage for saved code
    let initialCode = defaultCode;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved.trim().length > 0) {
        initialCode = saved;
    }

    editor = monaco.editor.create(document.getElementById('monaco-container'), {
        value: initialCode,
        language: 'python',
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false }
    });

    // Auto-save on change
    editor.onDidChangeModelContent(() => {
        localStorage.setItem(STORAGE_KEY, editor.getValue());
    });
});

// --- File Operations ---

function downloadCode() {
    if (!editor) return;
    const code = editor.getValue();
    const blob = new Blob([code], { type: 'text/x-python' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pattern.py';
    document.body.appendChild(a);
    a.click();
    
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log("File downloaded as pattern.py", 'success');
}

async function loadPython(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    try {
        const text = await file.text();
        if (editor) {
            editor.setValue(text);
            localStorage.setItem(STORAGE_KEY, text); // Save immediately
            log(`Loaded ${file.name}`, 'success');
        }
    } catch (err) {
        log("Error reading python file: " + err, 'err');
    }
    // Reset input so same file can be selected again if needed
    event.target.value = '';
}

async function loadCSV(event) {
    const file = event.target.files[0];
    if (!file) return;
    const text = await file.text();
    
    positions = {};
    let idx = 0;
    text.trim().split('\n').forEach(line => {
        const p = line.split(',').map(Number);
        if (p.length >= 3 && !isNaN(p[1])) {
            positions[idx++] = { x: p[1], y: p[2], z: p[3] };
        }
    });
    
    log(`Loaded ${idx} LEDs from CSV`, 'success');
    updateWorkerPositions();
    renderFrame();
    event.target.value = '';
}


// --- Worker Management ---
function initWorker() {
    if (worker) worker.terminate();
    
    workerReady = false;
    worker = new Worker('worker.js');

    worker.onmessage = (e) => {
        const msg = e.data;

        switch(msg.type) {
            case 'ready':
                // Worker loaded, send positions immediately
                updateWorkerPositions(); 
                break;

            case 'init_complete':
                workerReady = true;
                document.getElementById('loader').style.display = 'none';
                document.getElementById('btn-run').disabled = false;
                
                // Process queue if user clicked Run during restart
                if (pendingRunCode) {
                    executeRun(pendingRunCode);
                    pendingRunCode = null;
                }
                break;

            case 'print':
                log(msg.text);
                break;

            case 'render':
                // Update 3D view buffer
                colorStates = msg.colors;
                requestAnimationFrame(renderFrame);
                break;

            case 'error':
                log(msg.text, 'err');
                setUIState('stopped');
                break;

            case 'finished':
                log("Script finished.", 'success');
                setUIState('stopped');
                break;
        }
    };
}

function updateWorkerPositions() {
    // Convert positions object to array of [x,y,z] arrays
    const posArray = Object.values(positions).map(p => [p.x, p.y, p.z]);
    worker.postMessage({ cmd: 'init', pos: posArray });
}

function runPattern() {
    const code = editor.getValue();
    setUIState('running');
    
    if (workerReady) {
        executeRun(code);
    } else {
        log("Environment restarting...", 'sys');
        pendingRunCode = code;
        if (!worker) initWorker();
    }
}

function executeRun(code) {
    log("--- Running ---", 'sys');
    worker.postMessage({ cmd: 'run', code: code });
}

function stopPattern(reason = null) {
    if (!isRunning) return;

    if (reason) log(reason, 'sys');
    else log("--- Stopped ---", 'sys');
    
    // Terminate worker to stop infinite loops
    if (worker) worker.terminate();
    
    setUIState('stopped');
    workerReady = false;
    
    // Immediately start a fresh worker
    initWorker();
}

function setUIState(state) {
    const btnRun = document.getElementById('btn-run');
    const btnStop = document.getElementById('btn-stop');
    
    if (state === 'running') {
        isRunning = true;
        btnRun.disabled = true;
        btnStop.disabled = false;
    } else {
        isRunning = false;
        btnRun.disabled = false;
        btnStop.disabled = true;
    }
}

// --- Background/Visibility Handling ---
document.addEventListener("visibilitychange", () => {
    if (document.hidden && isRunning) {
        // When tab is hidden, browsers throttle timers and workers.
        // This causes message queues to fill up and crash when resumed.
        // We force stop the simulation to be safe.
        stopPattern("Simulation stopped to save resources (tab backgrounded).");
    }
});

function log(text, type = 'info') {
    if(!text || text === '\n') return;
    const el = document.getElementById('console-output');
    const div = document.createElement('div');
    div.className = `log-line log-${type}`;
    div.textContent = `> ${text}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
}

function clearConsole() {
    document.getElementById('console-output').innerHTML = '';
}

// --- Visualization (Orbit Camera) ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let view = {
    azimuth: 0,    // Rotation around vertical axis
    elevation: 0.2,// Rotation up/down
    zoom: 6,
    lightSize: 5
};

let isDragging = false;
let lastMouse = { x: 0, y: 0 };

function project3D(x, y, z) {
    // 1. Azimuth Rotation (around Z axis)
    const cosA = Math.cos(view.azimuth);
    const sinA = Math.sin(view.azimuth);
    
    let x1 = x * cosA - y * sinA;
    let y1 = x * sinA + y * cosA;
    let z1 = z;

    // 2. Elevation Rotation (around Screen X axis)
    const cosB = Math.cos(view.elevation);
    const sinB = Math.sin(view.elevation);

    let y2 = y1 * cosB - z1 * sinB;
    let z2 = y1 * sinB + z1 * cosB;

    return { x: x1, y: y2, z: z2 };
}

function renderFrame() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height * 0.6; 
    
    const posValues = Object.values(positions);
    if(posValues.length === 0) return;

    // Calculate projected points
    const points = posValues.map((p, i) => {
        const proj = project3D(p.x, p.y, p.z);
        const r = colorStates[i*3] || 0;
        const g = colorStates[i*3+1] || 0;
        const b = colorStates[i*3+2] || 0;
        
        return { x: proj.x, y: proj.y, z: proj.z, r, g, b };
    });

    // Sort by depth (Y) for painter's algorithm
    points.sort((a, b) => b.y - a.y);

    points.forEach(p => {
        const fov = 800;
        const scale = (fov / (fov - p.y + 400)) * view.zoom;
        const sx = cx + p.x * scale;
        const sy = cy - p.z * scale; 

        const size = Math.max(1, view.lightSize * (scale / view.zoom));

        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, Math.PI * 2);

        if (p.r > 10 || p.g > 10 || p.b > 10) {
            const color = `rgb(${p.r}, ${p.g}, ${p.b})`;
            ctx.fillStyle = color;
            ctx.shadowBlur = size * 2;
            ctx.shadowColor = color;
        } else {
            ctx.fillStyle = '#333';
            ctx.shadowBlur = 0;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
    });
}

function resetView() {
    view = { azimuth: 0, elevation: 0.2, zoom: 6, lightSize: 5 };
    renderFrame();
}

function resizeCanvas() {
    const container = document.getElementById('vis-container');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    renderFrame();
}

// Mouse Interactions
canvas.addEventListener('mousedown', e => {
    isDragging = true;
    lastMouse = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mouseup', () => isDragging = false);

canvas.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouse.x;
    const dy = e.clientY - lastMouse.y;
    view.azimuth += dx * 0.01;
    view.elevation += dy * 0.01;
    lastMouse = { x: e.clientX, y: e.clientY };
    renderFrame();
});

canvas.addEventListener('wheel', e => {
    e.preventDefault();
    view.zoom += e.deltaY * -0.005;
    view.zoom = Math.max(1, Math.min(view.zoom, 20));
    renderFrame();
});

// Resizers
const dragV = document.getElementById('drag-v');
const leftPane = document.getElementById('left-pane');
const mainContainer = document.getElementById('main-container');

dragV.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.addEventListener('mousemove', onMoveV);
    document.addEventListener('mouseup', () => document.removeEventListener('mousemove', onMoveV));
});

function onMoveV(e) {
    const w = (e.clientX / mainContainer.clientWidth) * 100;
    if (w > 10 && w < 90) {
        leftPane.style.width = w + '%';
        if(editor) editor.layout();
        resizeCanvas();
    }
}

const dragH = document.getElementById('drag-h');
const rightPane = document.getElementById('right-pane');
const visContainer = document.getElementById('vis-container');
const consoleContainer = document.getElementById('console-container');

dragH.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.addEventListener('mousemove', onMoveH);
    document.addEventListener('mouseup', () => document.removeEventListener('mousemove', onMoveH));
});

function onMoveH(e) {
    const top = rightPane.getBoundingClientRect().top;
    const h = e.clientY - top;
    if (h > 50 && h < rightPane.clientHeight - 50) {
        visContainer.style.flex = 'none';
        visContainer.style.height = h + 'px';
        consoleContainer.style.height = (rightPane.clientHeight - h) + 'px';
        resizeCanvas();
    }
}

// Handle resize
window.addEventListener('resize', () => {
    if (editor) editor.layout();
    resizeCanvas();
});

// Start
initWorker();
setTimeout(resizeCanvas, 100);
