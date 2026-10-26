// projects.js
// Local projects (stored in localStorage), loading shared projects from the
// URL, and sharing / submitting patterns through Jelkob.

// --- Storage helpers ---
// localStorage can be unavailable (private mode, blocked site data) or full.
function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

function storageSet(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        console.warn("[Projects] Could not write to localStorage:", e);
        return false;
    }
}

function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

// --- Backend (Jelkob) ---
// For local development, point Jelkonda at another backend with:
//   localStorage.setItem('jelkonda.apiBase', 'http://localhost:8001')
const API_BASE = (storageGet('jelkonda.apiBase') || 'https://jelkob.fmf.uni-lj.si').replace(/\/+$/, '');

class ApiError extends Error {}

async function apiRequest(method, path, body) {
    let res;
    try {
        res = await fetch(API_BASE + path, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (e) {
        throw new ApiError("Strežnik ni dosegljiv. Preverite internetno povezavo in poskusite znova.");
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }

    if (!res.ok) throw new ApiError(describeApiError(res.status, data));
    return data;
}

function describeApiError(status, data) {
    if (status === 404) return "Vzorca ni bilo mogoče najti.";
    // Django REST framework: {"detail": "..."} or {"field": ["message", ...]}
    if (data && typeof data === 'object') {
        if (typeof data.detail === 'string') return data.detail;
        const messages = Object.entries(data).map(([field, msg]) => `${field}: ${[].concat(msg).join(' ')}`);
        if (messages.length) return messages.join('\n');
    }
    return `Napaka strežnika (${status}).`;
}

const api = {
    // -> { id, url }
    upload: (name, source) => apiRequest('POST', '/editor/python/upload', { name, source }),
    // fields: { name, description, author, school, project }
    submit: (fields) => apiRequest('POST', '/editor/python/submit', fields),
    // -> { id, name, source }
    get: (id) => apiRequest('GET', `/editor/python/projects/${encodeURIComponent(id)}`),
};

// --- DOM helpers ---
function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'class') node.className = value;
        else if (key === 'value') node.value = value;
        else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) {
        if (child != null && child !== false) node.append(child);
    }
    return node;
}

const icon = (name) => el('i', { class: `codicon codicon-${name}` });

function field(label, input, hint = null) {
    return el('label', { class: 'field' }, [
        el('span', { class: 'field-label' }, label),
        input,
        hint && el('span', { class: 'field-hint' }, hint),
    ]);
}

// --- Dialog ---
// One reusable dialog. Its content is a <form>, so Enter and the browser's
// built-in validation (required, maxlength) work for every dialog.
const Dialog = (() => {
    const root = document.getElementById('dialog');
    const form = document.getElementById('dialog-form');
    const title = document.getElementById('dialog-title');
    const body = document.getElementById('dialog-body');
    const actions = document.getElementById('dialog-actions');
    let onSubmit = null;
    let busy = false;

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!busy && onSubmit) onSubmit(new FormData(form));
    });
    root.addEventListener('mousedown', (e) => {
        if (e.target === root) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) close();
    });

    function isOpen() {
        return root.style.display !== 'none';
    }

    // buttons: [{ label, icon, primary, danger, submit, onClick }]
    function show({ heading, content, buttons = [], submit = null, wide = false }) {
        busy = false;
        onSubmit = submit;
        title.textContent = heading;
        body.replaceChildren(...[].concat(content));
        actions.replaceChildren(...buttons.map(b => el('button', {
            type: b.submit ? 'submit' : 'button',
            class: 'btn' + (b.primary ? ' btn-run' : '') + (b.danger ? ' btn-stop' : ''),
            onclick: b.onClick,
        }, [b.icon && icon(b.icon), b.label])));
        form.classList.toggle('dialog-wide', wide);
        root.style.display = 'block';

        const first = body.querySelector('input:not([readonly]), textarea');
        if (first) first.focus();
    }

    function close() {
        if (busy) return;
        root.style.display = 'none';
        onSubmit = null;
        if (editor) editor.focus();
    }

    // Disable all inputs and show a progress line while a request runs
    function setBusy(text) {
        busy = !!text;
        form.querySelectorAll('input, textarea, button').forEach(n => n.disabled = busy);
        body.querySelector('.dialog-status')?.remove();
        if (text) body.append(el('p', { class: 'dialog-status' }, [icon('loading'), text]));
    }

    function showError(text) {
        body.querySelector('.dialog-error')?.remove();
        body.append(el('div', { class: 'dialog-error' }, [icon('error'), el('span', {}, text)]));
    }

    return { show, close, setBusy, showError, isOpen };
})();

// Read-only link with a copy button
function shareLink(url) {
    const input = el('input', { type: 'text', class: 'input', readonly: true, value: url, onfocus: (e) => e.target.select() });
    const label = el('span', {}, "Kopiraj");
    const copy = el('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
            try {
                await navigator.clipboard.writeText(url);
            } catch (e) {
                input.select();
                document.execCommand('copy');
            }
            label.textContent = "Kopirano";
            setTimeout(() => label.textContent = "Kopiraj", 1500);
        },
    }, [icon('copy'), label]);
    return el('div', { class: 'share-link' }, [input, copy]);
}

// --- Projects ---
// Index (names, metadata) and sources are stored under separate keys, so an
// auto-save only rewrites the source of the project being edited.
const PROJECT_INDEX_KEY = 'jelkonda.projects';
const PROJECT_SOURCE_PREFIX = 'jelkonda.source.';
const AUTHOR_KEY = 'jelkonda.author';
const DEFAULT_PROJECT_NAME = 'vzorec';
const MAX_NAME_LENGTH = 50;

// Cheap fingerprint (FNV-1a) of what was last uploaded, to reuse a share link
// when nothing changed since.
function contentHash(name, source) {
    let h = 0x811c9dc5;
    const text = name + '\u0000' + source;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

const Projects = (() => {
    // { active: id, projects: [{ id, name, created, updated, shared: { id, url, hash } | null }] }
    let index = { active: null, projects: [] };
    let saveTimer = null;
    let saveTarget = null;
    let saveFailed = false;

    function newId() {
        if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
        return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }

    const find = (id) => index.projects.find(p => p.id === id) || null;
    const active = () => find(index.active);
    const sourceOf = (id) => storageGet(PROJECT_SOURCE_PREFIX + id) ?? '';
    const persistIndex = () => storageSet(PROJECT_INDEX_KEY, JSON.stringify(index));

    function uniqueName(base, exceptId = null) {
        base = (base || DEFAULT_PROJECT_NAME).trim().slice(0, MAX_NAME_LENGTH) || DEFAULT_PROJECT_NAME;
        const taken = new Set(index.projects.filter(p => p.id !== exceptId).map(p => p.name));
        if (!taken.has(base)) return base;
        for (let i = 2; ; i++) {
            const name = `${base} (${i})`;
            if (!taken.has(name)) return name;
        }
    }

    function load() {
        try {
            const parsed = JSON.parse(storageGet(PROJECT_INDEX_KEY));
            if (parsed && Array.isArray(parsed.projects)) index = parsed;
        } catch (e) { /* no or corrupt index: start fresh */ }

        if (index.projects.length === 0) {
            // First start, or upgrading from the single-file version
            const legacy = storageGet(STORAGE_KEY);
            add(DEFAULT_PROJECT_NAME, legacy && legacy.trim() ? legacy : defaultCode);
        }
        if (!active()) index.active = index.projects[0].id;
        persistIndex();
    }

    function add(name, source) {
        const now = Date.now();
        const project = { id: newId(), name: uniqueName(name), created: now, updated: now, shared: null };
        index.projects.push(project);
        storageSet(PROJECT_SOURCE_PREFIX + project.id, source);
        persistIndex();
        return project;
    }

    // --- Editor binding ---
    function createModel(id) {
        return monaco.editor.createModel(sourceOf(id), 'python');
    }

    function switchTo(id) {
        if (!find(id)) return;
        flushSave();
        index.active = id;
        persistIndex();
        if (editor) {
            const old = editor.getModel();
            editor.setModel(createModel(id)); // Own model per switch keeps undo history separate
            if (old) old.dispose();
            scheduleDiagnostics(0);
        }
        render();
    }

    function scheduleSave() {
        saveTarget = index.active;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, 400);
    }

    function flushSave() {
        clearTimeout(saveTimer);
        saveTimer = null;
        const project = saveTarget && find(saveTarget);
        saveTarget = null;
        if (!project || !editor) return;

        const ok = storageSet(PROJECT_SOURCE_PREFIX + project.id, editor.getValue());
        project.updated = Date.now();
        persistIndex();

        if (!ok && !saveFailed) log("Shranjevanje v brskalnik ni uspelo (zmanjkalo je prostora?). Prenesite kodo z gumbom Download.", 'err');
        saveFailed = !ok;
    }

    function rename(id, name) {
        const project = find(id);
        if (!project) return;
        project.name = uniqueName(name, id);
        persistIndex();
        render();
    }

    function remove(id) {
        const i = index.projects.findIndex(p => p.id === id);
        if (i < 0) return;
        if (saveTarget === id) {
            clearTimeout(saveTimer);
            saveTarget = null;
        }
        index.projects.splice(i, 1);
        storageRemove(PROJECT_SOURCE_PREFIX + id);

        if (index.projects.length === 0) add(DEFAULT_PROJECT_NAME, defaultCode);
        if (index.active === id) {
            const next = [...index.projects].sort((a, b) => b.updated - a.updated)[0];
            index.active = null;
            switchTo(next.id);
        } else {
            persistIndex();
            render();
        }
    }

    function create(name, source) {
        const project = add(name, source);
        switchTo(project.id);
        return project;
    }

    // --- Project picker ---
    const menu = document.getElementById('project-menu');
    const button = document.getElementById('project-button');

    function render() {
        const current = active();
        document.getElementById('project-name').textContent = current.name;
        document.title = `${current.name} · Jelkonda`;

        const list = document.getElementById('project-list');
        list.replaceChildren(...[...index.projects]
            .sort((a, b) => b.updated - a.updated)
            .map(p => el('button', {
                type: 'button',
                class: 'menu-item' + (p.id === current.id ? ' active' : ''),
                onclick: () => { closeMenu(); switchTo(p.id); },
            }, [icon(p.id === current.id ? 'check' : 'blank'), el('span', { class: 'menu-label' }, p.name)])));
    }

    function openMenu() {
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
    }

    button.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu());
    document.addEventListener('mousedown', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
    });

    // --- Menu actions ---
    function nameDialog(heading, initial, confirmLabel, onConfirm) {
        Dialog.show({
            heading,
            content: field("Ime projekta",
                el('input', { name: 'name', class: 'input', required: true, maxlength: MAX_NAME_LENGTH, value: initial, autocomplete: 'off' })),
            buttons: [
                { label: "Prekliči", onClick: Dialog.close },
                { label: confirmLabel, primary: true, submit: true },
            ],
            submit: (data) => {
                Dialog.close();
                onConfirm(data.get('name'));
            },
        });
    }

    function newProject() {
        closeMenu();
        nameDialog("Nov projekt", uniqueName(DEFAULT_PROJECT_NAME), "Ustvari", (name) => create(name, defaultCode));
    }

    function renameActive() {
        closeMenu();
        const current = active();
        nameDialog("Preimenuj projekt", current.name, "Preimenuj", (name) => rename(current.id, name));
    }

    function duplicateActive() {
        closeMenu();
        flushSave();
        const current = active();
        create(`${current.name} (kopija)`, sourceOf(current.id));
    }

    function deleteActive() {
        closeMenu();
        const current = active();
        Dialog.show({
            heading: "Izbriši projekt",
            content: el('p', {}, [`Projekt »${current.name}« bo trajno izbrisan iz tega brskalnika. `,
                "Deljene povezave in oddani vzorci ostanejo na strežniku."]),
            buttons: [
                { label: "Prekliči", onClick: Dialog.close },
                { label: "Izbriši", icon: 'trash', danger: true, submit: true },
            ],
            submit: () => {
                Dialog.close();
                remove(current.id);
            },
        });
    }

    // --- Upload (shared by Share and Submit) ---
    // Reuses the last upload when neither the name nor the code changed.
    async function uploadActive(name) {
        flushSave();
        const current = active();
        const source = sourceOf(current.id);
        const hash = contentHash(name, source);
        if (current.shared && current.shared.hash === hash) return current.shared;

        const data = await api.upload(name, source);
        if (!data || data.id == null) throw new ApiError("Strežnik ni vrnil ID-ja vzorca.");

        const id = String(data.id);
        current.shared = { id, url: data.url || shareUrlFor(id), hash };
        persistIndex();
        return current.shared;
    }

    function shareUrlFor(id) {
        return `${location.origin}${location.pathname}?project=${encodeURIComponent(id)}`;
    }

    // --- Share ---
    function share() {
        flushSave();
        const current = active();
        const unchanged = current.shared && current.shared.hash === contentHash(current.name, sourceOf(current.id));
        if (unchanged) {
            showShareLink(current.shared.url);
            return;
        }

        Dialog.show({
            heading: "Deli vzorec",
            content: [
                el('p', {}, "Vzorec bo naložen na strežnik in dobili boste povezavo, s katero ga lahko delite z drugimi. S tem vzorec ne bo oddan v pregled."),
                field("Ime vzorca",
                    el('input', { name: 'name', class: 'input', required: true, maxlength: MAX_NAME_LENGTH, value: current.name, autocomplete: 'off' })),
            ],
            buttons: [
                { label: "Prekliči", onClick: Dialog.close },
                { label: "Ustvari povezavo", icon: 'link', primary: true, submit: true },
            ],
            submit: async (data) => {
                const name = data.get('name').trim();
                Dialog.setBusy("Nalagam vzorec ...");
                try {
                    if (name !== current.name) rename(current.id, name);
                    const shared = await uploadActive(name);
                    Dialog.setBusy(null);
                    showShareLink(shared.url);
                } catch (err) {
                    Dialog.setBusy(null);
                    Dialog.showError(err.message);
                }
            },
        });
    }

    function showShareLink(url) {
        Dialog.show({
            heading: "Deli vzorec",
            content: [
                el('p', {}, "S to povezavo lahko svoj vzorec delite naprej:"),
                shareLink(url),
                el('p', { class: 'field-hint' }, "Povezava kaže na trenutno različico. Če vzorec spremenite, ga delite ponovno za novo povezavo."),
            ],
            buttons: [{ label: "Zapri", primary: true, onClick: Dialog.close }],
        });
    }

    // --- Submit ---
    // Same fields and flow as Jelkly: fill in the form, upload the code, then
    // submit the returned project ID for review.
    function submit() {
        flushSave();
        const current = active();
        let author = {};
        try { author = JSON.parse(storageGet(AUTHOR_KEY)) || {}; } catch (e) { /* ignore */ }

        Dialog.show({
            heading: "Oddaj vzorec",
            wide: true,
            content: [
                el('p', {}, "Ko vzorec oddate, ga ni mogoče več spreminjati. Prepričajte se, da vsebuje vse, kar želite."),
                el('p', {}, "Vsi oddani vzorci bodo ročno pregledani. Če bo vaš vzorec sprejet, bo prikazan na novoletni jelki na Fakulteti za matematiko in fiziko Univerze v Ljubljani."),
                el('p', {}, "Vaše ime in šola bosta morda javno prikazana."),
                field("Ime vzorca",
                    el('input', { name: 'name', class: 'input', required: true, maxlength: MAX_NAME_LENGTH, value: current.name, placeholder: "Vnesite ime vzorca", autocomplete: 'off' })),
                field("Opis vzorca",
                    el('textarea', { name: 'description', class: 'input', required: true, maxlength: 200, rows: 3, placeholder: "Vnesite opis vzorca" })),
                el('div', { class: 'field-row' }, [
                    field("Vaše ime",
                        el('input', { name: 'author', class: 'input', maxlength: 50, value: author.author || '', placeholder: "Vnesite svoje ime", autocomplete: 'name' })),
                    field("Vaša šola",
                        el('input', { name: 'school', class: 'input', maxlength: 100, value: author.school || '', placeholder: "Vnesite svojo šolo", autocomplete: 'organization' })),
                ]),
                el('label', { class: 'checkbox' }, [
                    el('input', { type: 'checkbox', name: 'confirm', required: true }),
                    el('span', {}, "Potrjujem, da sem avtor vzorca in se strinjam z njegovo objavo"),
                ]),
            ],
            buttons: [
                { label: "Prekliči", onClick: Dialog.close },
                { label: "Oddaj", icon: 'send', primary: true, submit: true },
            ],
            submit: async (data) => {
                const fields = {
                    name: data.get('name').trim(),
                    description: data.get('description').trim(),
                    author: data.get('author').trim(),
                    school: data.get('school').trim(),
                };
                storageSet(AUTHOR_KEY, JSON.stringify({ author: fields.author, school: fields.school }));

                Dialog.setBusy("Počakajte, da bo vaš vzorec oddan ...");
                try {
                    if (fields.name !== current.name) rename(current.id, fields.name);
                    const shared = await uploadActive(fields.name);
                    await api.submit({ ...fields, project: shared.id });
                    Dialog.setBusy(null);
                    showSubmitted(shared.url);
                } catch (err) {
                    Dialog.setBusy(null);
                    Dialog.showError(`Prišlo je do napake pri oddajanju vzorca. ${err.message}`);
                }
            },
        });
    }

    function showSubmitted(url) {
        Dialog.show({
            heading: "Vzorec oddan",
            content: [
                el('p', { class: 'dialog-success' }, [icon('pass-filled'), "Vaš vzorec je bil uspešno oddan. Zdaj bo ročno pregledan."]),
                el('p', {}, "Če bo vaš vzorec sprejet, bo prikazan na novoletni jelki na Fakulteti za matematiko in fiziko Univerze v Ljubljani."),
                el('p', {}, "Povezava do vašega vzorca:"),
                shareLink(url),
            ],
            buttons: [{ label: "Zapri", primary: true, onClick: Dialog.close }],
        });
    }

    // --- Shared project from the URL (?project=ID or #project=ID) ---
    async function openFromUrl() {
        const query = new URLSearchParams(location.search);
        const hash = new URLSearchParams(location.hash.slice(1));
        const id = query.get('project') || hash.get('project');
        if (!id) return;

        log(`Nalagam deljeni vzorec ...`, 'sys');
        try {
            const data = await api.get(id);
            const remoteId = String(data.id ?? id);
            const source = data.source ?? '';
            const name = data.name || "deljeni vzorec";

            // Opening the same link twice should not create duplicates
            const existing = index.projects.find(p => p.shared && p.shared.id === remoteId && sourceOf(p.id) === source);
            if (existing) {
                switchTo(existing.id);
            } else {
                const project = add(name, source);
                project.shared = { id: remoteId, url: data.url || shareUrlFor(remoteId), hash: contentHash(name, source) };
                persistIndex();
                switchTo(project.id);
            }
            log(`Naložen deljeni vzorec »${active().name}«.`, 'success');

            // Drop the parameter so the address bar shows the plain editor
            query.delete('project');
            hash.delete('project');
            const search = query.toString() ? `?${query}` : '';
            const fragment = hash.toString() ? `#${hash}` : '';
            history.replaceState(null, '', location.pathname + search + fragment);
        } catch (err) {
            log(`Deljenega vzorca ni bilo mogoče naložiti: ${err.message}`, 'err');
            Dialog.show({
                heading: "Vzorca ni bilo mogoče naložiti",
                content: el('div', { class: 'dialog-error' }, [icon('error'), el('span', {}, err.message)]),
                buttons: [{ label: "Zapri", primary: true, onClick: Dialog.close }],
            });
        }
    }

    load();
    render();

    return {
        load, render, createModel, scheduleSave, flushSave, create, switchTo, openFromUrl,
        newProject, renameActive, duplicateActive, deleteActive, share, submit,
        activeId: () => index.active,
        activeName: () => active().name,
    };
})();
