importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.js");

let pyodide = null;
let handlers = null;

self.onerror = function(e) {
    console.error("[LSP WORKER ERROR]", e);
};

function log(msg) {
    console.log(`[LSP Worker] ${msg}`);
}

async function initLsp() {
    try {
        log("Initializing...");
        const libsPromise = fetch("libraries.json").then(r => r.json());
        pyodide = await loadPyodide();
        const libs = await libsPromise;

        // jedi and numpy come from the Pyodide distribution; jelka wheels are local.
        // Load both groups in parallel.
        await pyodide.loadPackage("micropip");
        const micropip = pyodide.pyimport("micropip");
        await Promise.all([
            pyodide.loadPackage(["jedi", "numpy"]),
            (async () => {
                if (libs.jelka_validator) await micropip.install(libs.jelka_validator);
                if (libs.jelka) await micropip.install(libs.jelka);
            })(),
            // pyflakes (pure Python, from PyPI) adds undefined-name / unused-import
            // warnings. Optional: syntax errors still work without it.
            micropip.install("pyflakes").catch(err => log("pyflakes unavailable: " + err)),
        ]);

        await pyodide.runPythonAsync(`
import jedi

try:
    import pyflakes.api
    import pyflakes.reporter
    import pyflakes.messages as pfm
except ImportError:
    pyflakes = None

PATH = "/pattern.py"
MAX_COMPLETIONS = 500
_last_completions = []
_gen = 0

def _script(code):
    # parso caches the parse tree per path, so re-creating Script is cheap
    return jedi.Script(code, path=PATH)

def complete(code, line, column):
    global _last_completions, _gen
    _gen += 1
    comps = _script(code).complete(line, column)
    _last_completions = comps[:MAX_COMPLETIONS]
    # Only names/types here; docs are fetched lazily for the focused item
    items = [{"label": c.name, "type": c.type} for c in _last_completions]
    return {"items": items, "incomplete": len(comps) > MAX_COMPLETIONS, "gen": _gen}

def resolve(index, gen):
    # Items from an older completion list no longer match _last_completions
    if gen != _gen or not 0 <= index < len(_last_completions):
        return None
    c = _last_completions[index]
    sigs = []
    try:
        sigs = [s.to_string() for s in c.get_signatures()]
    except Exception:
        pass
    return {
        "detail": "\\n".join(sigs) or c.description,
        "documentation": c.docstring(raw=True),
    }

def hover(code, line, column):
    names = _script(code).help(line, column)
    if not names:
        return None
    n = names[0]
    header = None
    try:
        sigs = n.get_signatures()
        if sigs:
            header = sigs[0].to_string()
    except Exception:
        pass
    if header is None:
        header = n.description
    return {"header": header, "type": n.type, "doc": n.docstring(raw=True)}

def signatures(code, line, column):
    sigs = _script(code).get_signatures(line, column)
    result = []
    for s in sigs:
        result.append({
            "label": s.to_string(),
            "params": [p.to_string() for p in s.params],
            "index": s.index,
            "doc": s.docstring(raw=True),
        })
    return result

def definition(code, line, column):
    out = []
    for n in _script(code).goto(line, column, follow_imports=True):
        # Only definitions inside the edited file can be shown in the editor
        if n.module_path is not None and str(n.module_path) == PATH and n.line is not None:
            out.append({"line": n.line, "column": n.column, "name": n.name})
    return out

def references(code, line, column):
    out = []
    for n in _script(code).get_references(line, column, scope="file"):
        if n.line is not None:
            out.append({"line": n.line, "column": n.column, "len": len(n.name)})
    return out

# Severity: 8 = error, 4 = warning (Monaco MarkerSeverity)
class _Collector:
    def __init__(self):
        self.items = []
    def unexpectedError(self, filename, msg):
        pass
    def syntaxError(self, filename, msg, lineno, offset, text):
        pass  # syntax errors are reported by jedi below
    def flake(self, m):
        sev = 8 if isinstance(m, pfm.UndefinedName) else 4
        self.items.append({
            "line": m.lineno, "column": (m.col or 0) + 1, "endColumn": None,
            "message": m.message % m.message_args, "severity": sev,
        })

def diagnostics(code):
    out = []
    for e in _script(code).get_syntax_errors():
        out.append({
            "line": e.line, "column": e.column + 1,
            "endLine": e.until_line, "endColumn": e.until_column + 1,
            "message": e.get_message(), "severity": 8,
        })
    if pyflakes is not None and not out:
        c = _Collector()
        try:
            pyflakes.api.check(code, "pattern.py", c)
        except Exception:
            pass
        out.extend(c.items)
    return out

HANDLERS = {
    "completion": lambda p: complete(p["code"], p["line"], p["column"]),
    "resolve": lambda p: resolve(p["index"], p.get("gen")),
    "hover": lambda p: hover(p["code"], p["line"], p["column"]),
    "signature": lambda p: signatures(p["code"], p["line"], p["column"]),
    "definition": lambda p: definition(p["code"], p["line"], p["column"]),
    "references": lambda p: references(p["code"], p["line"], p["column"]),
    "diagnostics": lambda p: diagnostics(p["code"]),
}

def handle(kind, params):
    return HANDLERS[kind](params.to_py())

# Warmup: parse and cache the modules users import most
jedi.preload_module("jelka", "jelka.types", "math", "random", "numpy")
try:
    _script("import jelka\\nfrom jelka.types import Color\\nColor(0,0,0).").complete(3, 14)
except Exception:
    pass
        `);

        handlers = pyodide.globals.get('handle');
        postMessage({ type: 'ready' });

    } catch (err) {
        console.error("[LSP Init Error]", err);
        postMessage({ type: 'error', text: String(err) });
    }
}

initLsp();

self.onmessage = (e) => {
    const { id, type, params } = e.data;
    if (!handlers) {
        postMessage({ id, result: null });
        return;
    }
    try {
        const res = handlers(type, params);
        const result = res && typeof res.toJs === 'function'
            ? res.toJs({ dict_converter: Object.fromEntries })
            : res;
        if (res && typeof res.destroy === 'function') res.destroy();
        postMessage({ id, result: result ?? null });
    } catch (err) {
        console.warn(`[LSP Worker] ${type} failed:`, err);
        postMessage({ id, result: null });
    }
};
