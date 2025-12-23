importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.js");

let pyodide = null;

self.onerror = function(e) {
    console.error("[LSP WORKER ERROR]", e);
};

function log(msg) {
    console.log(`[LSP Worker] ${msg}`);
}
async function initLsp() {
    try {
        log("Initializing...");
        pyodide = await loadPyodide();

        // Fetch config
        const libsResponse = await fetch("libraries.json");
        const libs = await libsResponse.json();

        // Install Dependencies
        await pyodide.loadPackage(["micropip", "numpy"]);
        const micropip = pyodide.pyimport("micropip");
        
        await micropip.install("jedi");
        
        // Install Dynamic versions
        if (libs.jelka_validator) await micropip.install(libs.jelka_validator);
        if (libs.jelka) await micropip.install(libs.jelka);
        await pyodide.runPythonAsync(`
import jedi
import json
import sys
import jelka
import numpy

# Optimization Settings
jedi.settings.case_insensitive_completion = False
jedi.settings.fast_parser = True

def get_completions(source_code, line, column):
    try:
        filename = "/pattern.py"
        with open(filename, "w") as f:
            f.write(source_code)

        script = jedi.Script(source_code, path=filename)
        completions = script.complete(line, column)
        
        results = []
        count = 0
        
        for c in completions:
            # Map Types
            kind = 0 
            if c.type == 'module': kind = 8
            elif c.type == 'class': kind = 6
            elif c.type == 'instance': kind = 5
            elif c.type == 'function': kind = 1
            elif c.type == 'keyword': kind = 13
            
            # --- DOCSTRING EXTRACTION ---
            # 1. Detail: The signature (e.g. "instance Color")
            # 2. Documentation: The full text (e.g. "Represents a color...")
            
            # fast=True is CRITICAL. Without it, Jedi parses external files 
            # and Pyodide will freeze/timeout on low-end devices.
            doc_text = c.docstring(fast=True)
            signature = c.description
            
            results.append({
                "label": c.name,
                "kind": kind,
                "detail": signature,      # Appears next to the name in the list
                "documentation": doc_text, # Appears in the "Read More" side widget
                "insertText": c.name
            })
            
            # SAFETY LIMIT
            # Fetching docstrings is expensive. Limit to top 30 matches.
            count += 1
            if count >= 30: 
                break
            
        return json.dumps(results)
        
    except Exception as e:
        return json.dumps({"error": str(e)})

# Warmup
try:
    script = jedi.Script("import jelka; jelka.", path="/warmup.py")
    script.complete(1, 20)
except:
    pass
        `);

        postMessage({ type: 'ready' });

    } catch (err) {
        console.error("[LSP Init Error]", err);
    }
}

initLsp();

self.onmessage = async (e) => {
    const { id, code, line, column, type } = e.data;
    if (!pyodide) return;

    if (type === 'completion') {
        try {
            const getCompletions = pyodide.globals.get('get_completions');
            const jsonResult = getCompletions(code, line, column);
            const parsed = JSON.parse(jsonResult);
            
            postMessage({ id, results: parsed.error ? [] : parsed });
            getCompletions.destroy();
        } catch (err) {
            postMessage({ id, results: [] });
        }
    }
};
