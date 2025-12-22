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

// --- Documentation Toggle ---
function toggleDocs() {
    const modal = document.getElementById('doc-modal');
    if (modal.style.display === 'none') {
        modal.style.display = 'block';
    } else {
        modal.style.display = 'none';
    }
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('doc-modal');
    if (event.target == modal) {
        modal.style.display = "none";
    }
}

// --- LSP Manager ---
let lspWorker = null;
let lspReady = false;
let msgId = 0;
const pendingRequests = new Map();
const LSP_TIMEOUT_MS = 10000; // 4 seconds max wait time

const statusDot = document.getElementById('lsp-status');

function updateLspStatus(state) {
    if (!statusDot) return;
    switch(state) {
        case 'init': statusDot.style.background = '#666'; break; // Grey
        case 'ready': statusDot.style.background = '#4CAF50'; break; // Green
        case 'busy': statusDot.style.background = '#FFC107'; break; // Yellow
        case 'error': statusDot.style.background = '#F44336'; break; // Red
    }
}

function initLsp() {
    if (lspWorker) lspWorker.terminate();

    updateLspStatus('init');
    console.log("[LSP] Starting Worker...");
    
    lspWorker = new Worker('lspWorker.js');

    // 1. Handle Global Worker Errors (Crashes)
    lspWorker.onerror = (err) => {
        console.error("[LSP Worker Crash]", err);
        updateLspStatus('error');
        lspReady = false;
    };

    // 2. Handle Messages
    lspWorker.onmessage = (e) => {
        const data = e.data;

        if (data.type === 'ready') {
            lspReady = true;
            updateLspStatus('ready');
            console.log("[LSP] Ready.");
            return;
        }

        if (data.id !== undefined && pendingRequests.has(data.id)) {
            const req = pendingRequests.get(data.id);
            clearTimeout(req.timer); // Stop the timeout clock
            req.callback(data.results || []);
            pendingRequests.delete(data.id);
            
            // Only go back to green if queue is empty
            if (pendingRequests.size === 0) updateLspStatus('ready');
        }
    };
}

// Global function to restart manually if stuck
window.restartLsp = function() {
    console.warn("[LSP] Manual Restart Triggered");
    pendingRequests.forEach(req => clearTimeout(req.timer));
    pendingRequests.clear();
    initLsp();
}

// Initialize on load
initLsp();

// --- Monaco Editor ---
require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' }});
// --- Monaco Editor & Autocomplete ---
require(['vs/editor/editor.main'], function() {
    monaco.languages.registerCompletionItemProvider('python', {
        triggerCharacters: ['.', ' '],
        provideCompletionItems: function(model, position) {
            // Fail fast if worker is dead
            if (!lspReady) return { suggestions: [] };

            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn
            };

            updateLspStatus('busy');

            return new Promise((resolve) => {
                const reqId = msgId++;
                
                // 1. TIMEOUT HANDLER (The Debug Fix)
                // If worker doesn't reply in 4s, we assume it's stuck.
                const timer = setTimeout(() => {
                    if (pendingRequests.has(reqId)) {
                        console.error(`[LSP] Request ${reqId} timed out! Worker might be stuck.`);
                        updateLspStatus('error');
                        pendingRequests.delete(reqId);
                        resolve({ suggestions: [] }); // Unblock Editor
                    }
                }, LSP_TIMEOUT_MS);

                // 2. SUCCESS HANDLER
                const callback = (rawItems) => {
                    const suggestions = rawItems.map(item => ({
                        label: item.label,
                        kind: item.kind,
                        
                        // Shows the signature (e.g. "def run(callback)") next to the item
                        detail: item.detail, 
                        
                        // Shows the full docstring in the side panel
                        documentation: {
                            value: item.documentation || "No documentation" 
                        },
                        
                        insertText: item.insertText,
                        sortText: '0_' + item.label,
                        range: range
                    }));
                    resolve({ suggestions: suggestions });
                }; 

                // Store request
                pendingRequests.set(reqId, { callback, timer });

                // Send
                lspWorker.postMessage({
                    id: reqId,
                    type: 'completion',
                    code: model.getValue(),
                    line: position.lineNumber,
                    column: position.column - 1
                });
            });
        }
    });
    // 2. Create Editor (Existing Code)
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
        minimap: { enabled: false },
        suggestOnTriggerCharacters: true
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

let animationId = null;

// --- Worker Management ---
function initWorker() {
    if (worker) worker.terminate();
    
    workerReady = false;
    worker = new Worker('worker.js');

worker.onmessage = (e) => {
    const msg = e.data;

    switch(msg.type) {
        case 'ready':
            updateWorkerPositions();
            break;

        case 'init_complete':
            workerReady = true;
            document.getElementById('loader').style.display = 'none';
            document.getElementById('btn-run').disabled = false;
            if (pendingRunCode) {
                executeRun(pendingRunCode);
                pendingRunCode = null;
            }
            break;

        case 'print':
            log(msg.text);
            break;

        case 'render':
            // JUST update the data. Do NOT trigger a render here.
            // This prevents the "Message Flooding" crash.
            colorStates = msg.colors;
            break;

        case 'error':
            log(msg.text, 'err');
            stopPattern(msg.text); // Helper to stop safely
            break;

        case 'finished':
            log("Script finished.", 'success');
            stopPattern();
            break;
    }
};    
}

// 2. Independent Render Loop (Max 60 FPS)
function startRenderLoop() {
    if (!animationId) {
        animationId = requestAnimationFrame(renderLoop);
    }
}

function stopRenderLoop() {
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
}

function renderLoop() {
    renderFrame(); // Draw whatever is in 'colorStates' right now
    animationId = requestAnimationFrame(renderLoop);
}

function updateWorkerPositions() {
    // Convert positions object to array of [x,y,z] arrays
    const posArray = Object.values(positions).map(p => [p.x, p.y, p.z]);
    worker.postMessage({ cmd: 'init', pos: posArray });
}

function runPattern() {
    const code = editor.getValue();
    setUIState('running');
    startRenderLoop(); // <--- Start rendering

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

    if (worker) worker.terminate();
    stopRenderLoop(); // <--- Stop rendering to save battery

    setUIState('stopped');
    workerReady = false;
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

const consoleContainer = document.getElementById('console-output');
const MAX_LOG_LINES = 300; // Limit history to prevent browser slowdown

// Buffer for UI updates
let logBuffer = document.createDocumentFragment();
let isLogPending = false;

function flushLogs() {
    if (!consoleContainer) return;
    
    // Append new logs
    consoleContainer.appendChild(logBuffer);
    
    // Create a new fragment for next batch
    logBuffer = document.createDocumentFragment();
    isLogPending = false;

    // Prune old logs to keep DOM light
    while (consoleContainer.childNodes.length > MAX_LOG_LINES) {
        consoleContainer.removeChild(consoleContainer.firstChild);
    }
    
    // Auto scroll
    consoleContainer.scrollTop = consoleContainer.scrollHeight;
}

function log(text, type = 'info') {
    if (!text) return;

    // Handle newlines coming from Python prints correctly
    // Python often sends "Line\n", we want to split that.
    const lines = text.split('\n');

    lines.forEach(line => {
        if (line.length === 0) return;
        
        const div = document.createElement('div');
        div.className = `log-line log-${type}`;
        div.textContent = line.startsWith('>') ? line : `> ${line}`;
        logBuffer.appendChild(div);
    });

    // Schedule a UI update only if one isn't already pending
    if (!isLogPending) {
        isLogPending = true;
        requestAnimationFrame(flushLogs);
    }
}function clearConsole() {
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

const TWO_PI = Math.PI * 2; // Pre-calculate constant

function renderFrame() {
    // Use clearRect instead of fillRect for potentially faster clear, 
    // but fillRect #111 is fine for style.
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height * 0.6;

    const posValues = Object.values(positions);
    if(posValues.length === 0) return;

    // Calculate projected points
    const points = posValues.map((p, i) => {
        const proj = project3D(p.x, p.y, p.z);
        // Using bitwise OR (| 0) to force integer read is slightly faster
        const r = colorStates[i*3] | 0;
        const g = colorStates[i*3+1] | 0;
        const b = colorStates[i*3+2] | 0;

        return { x: proj.x, y: proj.y, z: proj.z, r, g, b };
    });

    // Sort by depth (Y)
    points.sort((a, b) => b.y - a.y);

    points.forEach(p => {
        const fov = 800;
        const scale = (fov / (fov - p.y + 400)) * view.zoom;
        
        // Bitwise floor (| 0) aligns to pixels, which is faster for Canvas 
        const sx = (cx + p.x * scale) | 0;
        const sy = (cy - p.z * scale) | 0;
        
        // Ensure size is at least 1
        const size = Math.max(1, view.lightSize * (scale / view.zoom));

        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, TWO_PI);

        // --- PERFORMANCE FIX: REMOVED SHADOW BLUR ---
        // Shadows are extremely expensive. We use a flat color.
        // If you need "glow", draw the circle slightly larger with low opacity 
        // instead of using ctx.shadowBlur.
        
        if (p.r > 10 || p.g > 10 || p.b > 10) {
            ctx.fillStyle = `rgb(${p.r}, ${p.g}, ${p.b})`;
        } else {
            ctx.fillStyle = '#333';
        }
        
        ctx.fill();
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
