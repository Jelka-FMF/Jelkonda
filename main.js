// main.js

// --- Global State ---
let positions = window.initialPositions || {};
let colorStates = new Uint8Array(0);
let worker = null;
let workerReady = false;
let editor = null;
let pendingRunCode = null;
let isRunning = false;
let stopTimer = null;

const STORAGE_KEY = 'jelka_saved_code';
// How long a running pattern gets to acknowledge a soft stop before the
// worker is terminated (and Pyodide reloaded).
const STOP_GRACE_MS = 750;

// Shared with the worker when the page is cross-origin isolated: writing 2
// raises KeyboardInterrupt in Python immediately, even inside tight loops.
const interruptBuffer = self.crossOriginIsolated ? new Uint8Array(new SharedArrayBuffer(1)) : null;

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
// Requests are sent one at a time. While one is in flight, a newer request of
// the same type replaces the queued older one, so fast typing never builds up
// a backlog of stale completions inside the (synchronous) worker.
let lspWorker = null;
let lspReady = false;
let msgId = 0;
let lspInflight = null;
let lspQueue = [];
const LSP_TIMEOUT_MS = 10000;

const STATUS_STYLES = {
    init: { color: '#666', text: 'loading' },     // Grey
    ready: { color: '#4CAF50', text: 'ready' },   // Green
    busy: { color: '#FFC107', text: 'busy' },     // Yellow
    error: { color: '#F44336', text: 'error' },   // Red
};

function setStatusDot(id, label, state) {
    const dot = document.getElementById(id);
    if (!dot) return;
    dot.style.background = STATUS_STYLES[state].color;
    dot.title = `${label}: ${STATUS_STYLES[state].text}`;
}

function updateLspStatus(state) {
    setStatusDot('lsp-status', 'Code completion', state);
}

function updatePyStatus(state) {
    setStatusDot('py-status', 'Python', state);
}

function settleLsp(req, result) {
    if (req.done) return;
    req.done = true;
    clearTimeout(req.timer);
    req.resolve(result);
}

function lspRequest(type, params, token) {
    if (!lspReady) return Promise.resolve(null);
    return new Promise(resolve => {
        lspQueue = lspQueue.filter(q => {
            if (q.type !== type) return true;
            settleLsp(q, null);
            return false;
        });
        lspQueue.push({ type, params, token, resolve, done: false });
        pumpLsp();
    });
}

function pumpLsp() {
    if (lspInflight || !lspReady) return;
    while (lspQueue.length) {
        const req = lspQueue.shift();
        if (req.token && req.token.isCancellationRequested) {
            settleLsp(req, null);
            continue;
        }
        req.id = ++msgId;
        req.timer = setTimeout(() => {
            console.error(`[LSP] ${req.type} request ${req.id} timed out! Worker might be stuck.`);
            updateLspStatus('error');
            settleLsp(req, null); // Unblock editor; keep waiting for the worker to catch up
        }, LSP_TIMEOUT_MS);
        lspInflight = req;
        updateLspStatus('busy');
        lspWorker.postMessage({ id: req.id, type: req.type, params: req.params });
        return;
    }
    updateLspStatus('ready');
}

function initLsp() {
    if (lspWorker) lspWorker.terminate();
    lspReady = false;
    lspInflight = null;

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
            if (editor) scheduleDiagnostics(0);
            return;
        }

        if (data.type === 'error') {
            console.error("[LSP] Init failed:", data.text);
            updateLspStatus('error');
            return;
        }

        if (lspInflight && data.id === lspInflight.id) {
            const req = lspInflight;
            lspInflight = null;
            settleLsp(req, data.result);
            pumpLsp();
        }
    };
}

// Global function to restart manually if stuck
window.restartLsp = function() {
    console.warn("[LSP] Manual Restart Triggered");
    if (lspInflight) settleLsp(lspInflight, null);
    lspQueue.forEach(req => settleLsp(req, null));
    lspQueue = [];
    initLsp();
}

// Initialize on load
initLsp();

// --- Diagnostics ---
let diagTimer = null;

function scheduleDiagnostics(delay = 600) {
    clearTimeout(diagTimer);
    diagTimer = setTimeout(async () => {
        if (!editor) return;
        const model = editor.getModel();
        const version = model.getVersionId();
        const items = await lspRequest('diagnostics', { code: model.getValue() });
        if (!items || model.getVersionId() !== version) return;
        monaco.editor.setModelMarkers(model, 'lsp', items.map(d => {
            // Without an explicit end, underline the word at the start position
            const word = d.endColumn ? null : model.getWordAtPosition({ lineNumber: d.line, column: d.column });
            return {
                severity: d.severity,
                message: d.message,
                startLineNumber: d.line,
                startColumn: d.column,
                endLineNumber: d.endLine || d.line,
                endColumn: d.endColumn || (word ? word.endColumn : model.getLineMaxColumn(d.line)),
            };
        }));
    }, delay);
}

// Highlight the line of a Python traceback in the editor
function markRuntimeError(text) {
    if (!editor) return;
    const matches = [...text.matchAll(/File "pattern\.py", line (\d+)/g)];
    if (matches.length === 0) return;
    const model = editor.getModel();
    const line = Math.min(parseInt(matches[matches.length - 1][1], 10), model.getLineCount());
    const lines = text.trim().split('\n');
    monaco.editor.setModelMarkers(model, 'runtime', [{
        severity: monaco.MarkerSeverity.Error,
        message: lines[lines.length - 1],
        startLineNumber: line,
        startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line),
    }]);
    editor.revealLineInCenterIfOutsideViewport(line);
}

// --- Monaco Editor ---
require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' }});
// --- Monaco Editor & Language Features ---
require(['vs/editor/editor.main'], function() {
    const Kind = monaco.languages.CompletionItemKind;
    const KIND_MAP = {
        module: Kind.Module, class: Kind.Class, instance: Kind.Variable,
        function: Kind.Function, param: Kind.Variable, path: Kind.File,
        keyword: Kind.Keyword, property: Kind.Property, statement: Kind.Variable,
    };

    const pos = (model, position) => ({
        code: model.getValue(),
        line: position.lineNumber,
        column: position.column - 1,
    });

    const md = (doc) => doc ? { value: '```text\n' + doc + '\n```' } : undefined;

    monaco.languages.registerCompletionItemProvider('python', {
        triggerCharacters: ['.', ' '],
        provideCompletionItems: async function(model, position, context, token) {
            // A space only means something after `import` / `from x import`
            if (context.triggerCharacter === ' ') {
                const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
                if (!/^\s*(import|from)\s+(\S+\s+import\s+)?$/.test(before)) return { suggestions: [] };
            }

            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn
            };

            const res = await lspRequest('completion', pos(model, position), token);
            if (!res) return { suggestions: [], incomplete: true };

            return {
                incomplete: res.incomplete,
                suggestions: res.items.map((item, i) => ({
                    label: item.label,
                    kind: KIND_MAP[item.type] ?? Kind.Text,
                    insertText: item.label,
                    // Keep jedi's ordering (it puts private/dunder names last)
                    sortText: String(i).padStart(5, '0'),
                    range: range,
                    _index: i,
                    _gen: res.gen,
                })),
            };
        },
        // Docs are expensive in jedi, so only fetch them for the focused item
        resolveCompletionItem: async function(item, token) {
            const res = await lspRequest('resolve', { index: item._index, gen: item._gen }, token);
            if (res) {
                item.detail = res.detail;
                item.documentation = md(res.documentation);
            }
            return item;
        }
    });

    monaco.languages.registerHoverProvider('python', {
        provideHover: async function(model, position, token) {
            const res = await lspRequest('hover', pos(model, position), token);
            if (!res) return null;
            const contents = [{ value: '```python\n' + res.header + '\n```' }];
            if (res.doc) contents.push(md(res.doc));
            return { contents };
        }
    });

    monaco.languages.registerSignatureHelpProvider('python', {
        signatureHelpTriggerCharacters: ['(', ','],
        signatureHelpRetriggerCharacters: [')'],
        provideSignatureHelp: async function(model, position, token) {
            const sigs = await lspRequest('signature', pos(model, position), token);
            if (!sigs || sigs.length === 0) return null;
            return {
                value: {
                    signatures: sigs.map(s => ({
                        label: s.label,
                        documentation: md(s.doc),
                        parameters: s.params.map(p => ({ label: p })),
                    })),
                    activeSignature: 0,
                    activeParameter: sigs[0].index ?? 0,
                },
                dispose() {}
            };
        }
    });

    monaco.languages.registerDefinitionProvider('python', {
        provideDefinition: async function(model, position, token) {
            const defs = await lspRequest('definition', pos(model, position), token);
            if (!defs) return null;
            return defs.map(d => ({
                uri: model.uri,
                range: new monaco.Range(d.line, d.column + 1, d.line, d.column + 1 + d.name.length),
            }));
        }
    });

    monaco.languages.registerDocumentHighlightProvider('python', {
        provideDocumentHighlights: async function(model, position, token) {
            const refs = await lspRequest('references', pos(model, position), token);
            if (!refs) return null;
            return refs.map(r => ({
                range: new monaco.Range(r.line, r.column + 1, r.line, r.column + 1 + r.len),
            }));
        }
    });

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

    // Ctrl/Cmd+Enter runs the pattern
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        if (isRunning) stopPattern(); else runPattern();
    });

    // Auto-save on change (debounced), and refresh diagnostics
    let saveTimer = null;
    const save = () => localStorage.setItem(STORAGE_KEY, editor.getValue());
    editor.onDidChangeModelContent(() => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 400);
        monaco.editor.setModelMarkers(editor.getModel(), 'runtime', []);
        scheduleDiagnostics();
    });
    window.addEventListener('beforeunload', save);

    if (lspReady) scheduleDiagnostics(0);
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

    const newPositions = {};
    let count = 0;
    text.trim().split('\n').forEach(line => {
        const p = line.split(',').map(Number);
        if (p.length >= 4 && p.every(v => !isNaN(v))) {
            newPositions[p[0]] = { x: p[1], y: p[2], z: p[3] };
            count++;
        }
    });

    event.target.value = '';
    if (count === 0) {
        log("No valid LED positions found (expected lines of: index,x,y,z)", 'err');
        return;
    }

    setPositions(newPositions);
    log(`Loaded ${count} LEDs from CSV`, 'success');
    updateWorkerPositions();
}

// --- Worker Management ---
function initWorker() {
    if (worker) worker.terminate();

    workerReady = false;
    updatePyStatus('init');
    worker = new Worker('worker.js');

    worker.onerror = (err) => {
        console.error("[Python Worker Crash]", err);
        updatePyStatus('error');
    };

    worker.onmessage = (e) => {
        const msg = e.data;

        switch(msg.type) {
            case 'ready':
                updateWorkerPositions();
                break;

            case 'init_complete':
                workerReady = true;
                updatePyStatus(isRunning ? 'busy' : 'ready');
                document.getElementById('loader').style.display = 'none';
                document.getElementById('btn-run').disabled = false;
                if (pendingRunCode) {
                    executeRun(pendingRunCode);
                    pendingRunCode = null;
                }
                break;

            case 'print':
                log(msg.text, msg.stream === 'stderr' ? 'warn' : msg.stream === 'sys' ? 'sys' : 'info');
                break;

            case 'render':
                // Just store the data and schedule a redraw; many frames
                // arriving within one display frame collapse into one draw.
                colorStates = msg.colors;
                scheduleRender();
                break;

            case 'error':
                if (!workerReady) {
                    document.getElementById('loader-text').textContent = msg.text;
                    updatePyStatus('error');
                }
                log(msg.text, 'err');
                markRuntimeError(msg.text);
                patternEnded();
                break;

            case 'finished':
                log("Script finished.", 'success');
                patternEnded();
                break;

            case 'stopped':
                log("--- Stopped ---", 'sys');
                patternEnded();
                break;
        }
    };
}

function updateWorkerPositions() {
    if (!worker) return;
    const csv = Object.entries(positions)
        .map(([i, p]) => `${i},${p.x},${p.y},${p.z}`)
        .join('\n');
    worker.postMessage({ cmd: 'init', csv: csv, interruptBuffer: interruptBuffer });
}

function runPattern() {
    if (!editor || isRunning) return;
    const code = editor.getValue();
    monaco.editor.setModelMarkers(editor.getModel(), 'runtime', []);
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
    updatePyStatus('busy');
    worker.postMessage({ cmd: 'run', code: code });
}

// The pattern ended on its own (finished, error, or acknowledged stop):
// the worker is still alive and can be reused for the next run.
function patternEnded() {
    clearTimeout(stopTimer);
    stopTimer = null;
    setUIState('stopped');
    if (workerReady) updatePyStatus('ready');
}

// Manual escape hatch: throw away the Python environment and start a fresh one
window.restartPython = function() {
    console.warn("[Python] Manual Restart Triggered");
    clearTimeout(stopTimer);
    stopTimer = null;
    pendingRunCode = null;
    if (isRunning) setUIState('stopped');
    log("--- Restarting Python environment ---", 'sys');
    initWorker();
}

function stopPattern(reason = null) {
    if (!isRunning || stopTimer) return;
    if (reason) log(reason, 'sys');
    pendingRunCode = null;

    if (!workerReady) {
        // Still booting, nothing to interrupt
        log("--- Stopped ---", 'sys');
        setUIState('stopped');
        return;
    }

    // Ask Python to stop at its next sleep/frame; fall back to killing the worker
    if (interruptBuffer) interruptBuffer[0] = 2;
    worker.postMessage({ cmd: 'stop' });
    stopTimer = setTimeout(() => {
        stopTimer = null;
        log("--- Stopped (environment restarting) ---", 'sys');
        setUIState('stopped');
        initWorker();
    }, STOP_GRACE_MS);
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
        // This causes message queues to fill up when resumed, so stop.
        stopPattern("Simulation stopped to save resources (tab backgrounded).");
    }
});

const consoleContainer = document.getElementById('console-output');
const MAX_LOG_LINES = 300; // Limit history to prevent browser slowdown

// Buffer for UI updates
let logBuffer = document.createDocumentFragment();
let isLogPending = false;

function flushLogs() {
    isLogPending = false;
    if (!consoleContainer) return;

    // Append new logs
    consoleContainer.appendChild(logBuffer);
    logBuffer = document.createDocumentFragment();

    // Prune old logs to keep DOM light
    let excess = consoleContainer.childNodes.length - MAX_LOG_LINES;
    while (excess-- > 0) {
        consoleContainer.removeChild(consoleContainer.firstChild);
    }

    // Auto scroll
    consoleContainer.scrollTop = consoleContainer.scrollHeight;
}

function log(text, type = 'info') {
    if (!text) return;

    // Handle newlines coming from Python prints correctly
    let lines = text.split('\n').filter(line => line.length > 0);

    // Never build more DOM nodes than can be shown
    if (lines.length > MAX_LOG_LINES) lines = lines.slice(-MAX_LOG_LINES);

    for (const line of lines) {
        const div = document.createElement('div');
        div.className = `log-line log-${type}`;
        div.textContent = line.startsWith('>') ? line : `> ${line}`;
        logBuffer.appendChild(div);
    }
    while (logBuffer.childNodes.length > MAX_LOG_LINES) {
        logBuffer.removeChild(logBuffer.firstChild);
    }

    // Schedule a UI update only if one isn't already pending
    if (!isLogPending) {
        isLogPending = true;
        requestAnimationFrame(flushLogs);
    }
}

function clearConsole() {
    logBuffer = document.createDocumentFragment();
    consoleContainer.textContent = '';
}

// --- Visualization (Orbit Camera) ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false });

let view = {
    azimuth: 0,    // Rotation around vertical axis
    elevation: 0.2,// Rotation up/down
    zoom: 6,
    lightSize: 5
};

let isDragging = false;
let lastMouse = { x: 0, y: 0 };

const TWO_PI = Math.PI * 2;
const FOV = 800;

// LED geometry in flat typed arrays. Projection and depth order only depend
// on the camera, so they are cached and recomputed only when it changes;
// a new color frame just repaints.
let led = { count: 0, ids: new Int32Array(0), x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0) };
let screen = { sx: new Float32Array(0), sy: new Float32Array(0), size: new Float32Array(0), order: new Uint32Array(0) };
let projectionDirty = true;
let renderPending = false;

function setPositions(obj) {
    positions = obj;
    const entries = Object.entries(obj);
    const n = entries.length;
    led = { count: n, ids: new Int32Array(n), x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) };
    entries.forEach(([id, p], i) => {
        led.ids[i] = +id;
        led.x[i] = p.x;
        led.y[i] = p.y;
        led.z[i] = p.z;
    });
    screen = { sx: new Float32Array(n), sy: new Float32Array(n), size: new Float32Array(n), order: new Uint32Array(n) };
    invalidateView();
}

function invalidateView() {
    projectionDirty = true;
    scheduleRender();
}

function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
        renderPending = false;
        renderFrame();
    });
}

function updateProjection() {
    const cosA = Math.cos(view.azimuth), sinA = Math.sin(view.azimuth);
    const cosB = Math.cos(view.elevation), sinB = Math.sin(view.elevation);
    const cx = canvas.width / 2;
    const cy = canvas.height * 0.6;
    const depth = new Float32Array(led.count);

    for (let i = 0; i < led.count; i++) {
        // Azimuth rotation (around Z), then elevation (around screen X)
        const x1 = led.x[i] * cosA - led.y[i] * sinA;
        const y1 = led.x[i] * sinA + led.y[i] * cosA;
        const y2 = y1 * cosB - led.z[i] * sinB;
        const z2 = y1 * sinB + led.z[i] * cosB;

        const persp = FOV / (FOV - y2 + 400);
        const scale = persp * view.zoom;
        screen.sx[i] = (cx + x1 * scale) | 0;
        screen.sy[i] = (cy - z2 * scale) | 0;
        screen.size[i] = Math.max(1, view.lightSize * persp);
        depth[i] = y2;
        screen.order[i] = i;
    }

    // Far to near
    screen.order.sort((a, b) => depth[b] - depth[a]);
    projectionDirty = false;
}

function renderFrame() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (led.count === 0) return;

    if (projectionDirty) updateProjection();

    const { sx, sy, size, order } = screen;
    const colors = colorStates;
    let lastStyle = '';

    for (let k = 0; k < led.count; k++) {
        const i = order[k];
        const c = led.ids[i] * 3;
        const r = colors[c] | 0, g = colors[c + 1] | 0, b = colors[c + 2] | 0;

        const style = (r > 10 || g > 10 || b > 10) ? `rgb(${r},${g},${b})` : '#333';
        if (style !== lastStyle) {
            ctx.fillStyle = style;
            lastStyle = style;
        }
        ctx.beginPath();
        ctx.arc(sx[i], sy[i], size[i], 0, TWO_PI);
        ctx.fill();
    }
}

function resetView() {
    view = { azimuth: 0, elevation: 0.2, zoom: 6, lightSize: 5 };
    invalidateView();
}

function resizeCanvas() {
    const container = document.getElementById('vis-container');
    if (canvas.width === container.clientWidth && canvas.height === container.clientHeight) return;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    projectionDirty = true;
    renderFrame(); // Synchronous: resizing clears the canvas
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
    invalidateView();
});

canvas.addEventListener('wheel', e => {
    e.preventDefault();
    view.zoom += e.deltaY * -0.005;
    view.zoom = Math.max(1, Math.min(view.zoom, 20));
    invalidateView();
}, { passive: false });

// Resizers
const dragV = document.getElementById('drag-v');
const leftPane = document.getElementById('left-pane');
const mainContainer = document.getElementById('main-container');

function startDrag(onMove) {
    let frame = null;
    let lastEvent = null;
    const move = (e) => {
        lastEvent = e;
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = null; onMove(lastEvent); });
    };
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
}

dragV.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startDrag(onMoveV);
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
    startDrag(onMoveH);
});

function onMoveH(e) {
    const top = rightPane.getBoundingClientRect().top;
    const h = e.clientY - top;
    if (h > 50 && h < rightPane.clientHeight - 50) {
        visContainer.style.flex = 'none';
        visContainer.style.height = h + 'px';
        consoleContainer.parentElement.style.height = (rightPane.clientHeight - h) + 'px';
        resizeCanvas();
    }
}

// Handle resize
window.addEventListener('resize', () => {
    if (editor) editor.layout();
    resizeCanvas();
});

// Start
setPositions(positions);
initWorker();
setTimeout(resizeCanvas, 100);
