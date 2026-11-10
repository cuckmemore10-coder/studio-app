(function () {
  "use strict";

  const PIN_LEN = 4;
  const LS = {
    pinHash: "studio_pin_hash",
    pinSalt: "studio_pin_salt",
    favorites: "studio_favorites",
    saved: "studio_saved_captions",
    unlocked: "studio_session_ok"
  };

  const state = {
    pinBuffer: "",
    settingPin: false,
    confirmPin: null,
    theme: "teasing",
    perspective: "watcher",
    intensity: 50,
    currentCaption: "",
    editor: {
      image: null, // HTMLImageElement or null
      bgMode: "image", // image | solid | gradient
      solid: "#1c1c1e",
      gradient: ["#1a1a2e", "#16213e", "#0f3460"],
      text: "",
      font: "system",
      size: 42,
      color: "#ffffff",
      outline: true,
      shadow: true,
      bar: "none", // none | top | bottom | both
      x: 0.5,
      y: 0.78,
      dragging: false
    }
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  async function sha256(str) {
    const data = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function randomSalt() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function hashPin(pin, salt) {
    return sha256(salt + ":" + pin);
  }

  function loadJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  /* ---------- IndexedDB gallery ---------- */
  const DB_NAME = "studio_gallery";
  const DB_STORE = "exports";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function addExport(blob, caption) {
    const db = await openDB();
    const dataUrl = await blobToDataURL(blob);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).add({
        dataUrl,
        caption: caption || "",
        created: Date.now()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function listExports(limit = 40) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result || []).sort((a, b) => b.created - a.created).slice(0, limit);
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteExport(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearExports() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  /* ---------- PIN lock ---------- */
  function updatePinDots(error) {
    const dots = $$(".pin-dot");
    dots.forEach((d, i) => {
      d.classList.toggle("filled", i < state.pinBuffer.length);
      d.classList.toggle("error", !!error);
    });
  }

  function showLock(mode) {
    $("#lock-screen").classList.remove("hidden");
    $("#app").classList.add("hidden");
    state.pinBuffer = "";
    state.settingPin = mode === "set" || mode === "change";
    state.confirmPin = mode === "confirm" ? state.confirmPin : null;
    const title = $("#lock-title");
    const sub = $("#lock-sub");
    if (mode === "set" || !localStorage.getItem(LS.pinHash)) {
      state.settingPin = true;
      title.textContent = "Create a PIN";
      sub.textContent = "Choose a 4-digit PIN to lock Studio on this device.";
    } else if (mode === "confirm") {
      title.textContent = "Confirm PIN";
      sub.textContent = "Enter the same PIN again.";
    } else if (mode === "change") {
      state.settingPin = true;
      title.textContent = "New PIN";
      sub.textContent = "Enter a new 4-digit PIN.";
    } else {
      title.textContent = "Enter PIN";
      sub.textContent = "Studio is locked.";
    }
    $("#lock-error").textContent = "";
    updatePinDots(false);
  }

  function unlockApp() {
    sessionStorage.setItem(LS.unlocked, "1");
    $("#lock-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    generateCaption();
    renderSaved();
    renderGallery();
  }

  async function onPinComplete(pin) {
    const errEl = $("#lock-error");
    if (state.settingPin && state.confirmPin === null) {
      state.confirmPin = pin;
      state.pinBuffer = "";
      showLock("confirm");
      state.settingPin = true;
      return;
    }
    if (state.settingPin && state.confirmPin !== null) {
      if (pin !== state.confirmPin) {
        errEl.textContent = "PINs didn’t match. Try again.";
        state.confirmPin = null;
        state.pinBuffer = "";
        updatePinDots(true);
        setTimeout(() => {
          showLock("set");
        }, 500);
        return;
      }
      const salt = randomSalt();
      const hash = await hashPin(pin, salt);
      localStorage.setItem(LS.pinSalt, salt);
      localStorage.setItem(LS.pinHash, hash);
      state.confirmPin = null;
      state.settingPin = false;
      toast("PIN saved");
      unlockApp();
      return;
    }
    const salt = localStorage.getItem(LS.pinSalt);
    const expected = localStorage.getItem(LS.pinHash);
    const hash = await hashPin(pin, salt);
    if (hash === expected) {
      unlockApp();
    } else {
      errEl.textContent = "Wrong PIN";
      state.pinBuffer = "";
      updatePinDots(true);
      setTimeout(() => updatePinDots(false), 400);
    }
  }

  function bindPinPad() {
    $$(".pin-key").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.key;
        if (k === "del") {
          state.pinBuffer = state.pinBuffer.slice(0, -1);
          updatePinDots(false);
          return;
        }
        if (k === "ok") return;
        if (state.pinBuffer.length >= PIN_LEN) return;
        state.pinBuffer += k;
        updatePinDots(false);
        if (state.pinBuffer.length === PIN_LEN) {
          onPinComplete(state.pinBuffer);
        }
      });
    });
  }

  /* ---------- Tabs ---------- */
  function switchTab(name) {
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $("#header-title").textContent =
      { generate: "Generate", editor: "Editor", saved: "Saved", settings: "Settings" }[name] || "Studio";
    if (name === "editor") {
      if (!state.editor.text && state.currentCaption) {
        state.editor.text = state.currentCaption;
        $("#editor-text").value = state.currentCaption;
      }
      drawEditor();
    }
    if (name === "saved") {
      renderSaved();
      renderGallery();
    }
  }

  /* ---------- Generator ---------- */
  function generateCaption() {
    const caption = window.CaptionEngine.generate({
      theme: state.theme,
      perspective: state.perspective,
      intensity: state.intensity
    });
    state.currentCaption = caption;
    $("#caption-output").value = caption;
  }

  function bindGenerator() {
    $$("#theme-chips .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        $$("#theme-chips .chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.theme = chip.dataset.value;
      });
    });
    $("#perspective").addEventListener("change", (e) => {
      state.perspective = e.target.value;
    });
    $("#intensity").addEventListener("input", (e) => {
      state.intensity = Number(e.target.value);
      $("#intensity-val").textContent = state.intensity;
    });
    $("#btn-generate").addEventListener("click", generateCaption);
    $("#btn-shuffle").addEventListener("click", generateCaption);
    $("#btn-copy").addEventListener("click", async () => {
      const t = $("#caption-output").value;
      try {
        await navigator.clipboard.writeText(t);
        toast("Copied");
      } catch {
        $("#caption-output").select();
        document.execCommand("copy");
        toast("Copied");
      }
    });
    $("#btn-favorite").addEventListener("click", () => {
      const t = $("#caption-output").value.trim();
      if (!t) return;
      const favs = loadJSON(LS.favorites, []);
      if (favs.some((f) => f.text === t)) {
        toast("Already favorited");
        return;
      }
      favs.unshift({ text: t, theme: state.theme, created: Date.now() });
      saveJSON(LS.favorites, favs.slice(0, 200));
      toast("Favorited");
      renderSaved();
    });
    $("#btn-save-caption").addEventListener("click", () => {
      const t = $("#caption-output").value.trim();
      if (!t) return;
      const saved = loadJSON(LS.saved, []);
      saved.unshift({ text: t, theme: state.theme, created: Date.now() });
      saveJSON(LS.saved, saved.slice(0, 200));
      toast("Saved");
      renderSaved();
    });
    $("#btn-to-editor").addEventListener("click", () => {
      state.editor.text = $("#caption-output").value;
      $("#editor-text").value = state.editor.text;
      switchTab("editor");
      $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === "editor"));
    });
    $("#caption-output").addEventListener("input", (e) => {
      state.currentCaption = e.target.value;
    });
  }

  /* ---------- Editor ---------- */
  function fontFamily(key) {
    const map = {
      system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      serif: 'Georgia, "Times New Roman", serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      rounded: '"Trebuchet MS", "Segoe UI", sans-serif',
      impact: 'Impact, Haettenschweiler, "Arial Black", sans-serif'
    };
    return map[key] || map.system;
  }

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";
    words.forEach((w) => {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    return lines;
  }

  function drawEditor() {
    const canvas = $("#editor-canvas");
    const ctx = canvas.getContext("2d");
    const ed = state.editor;
    const W = 1080;
    const H = 1350;
    canvas.width = W;
    canvas.height = H;

    // Background
    if (ed.bgMode === "image" && ed.image) {
      const img = ed.image;
      const scale = Math.max(W / img.width, H / img.height);
      const iw = img.width * scale;
      const ih = img.height * scale;
      const ix = (W - iw) / 2;
      const iy = (H - ih) / 2;
      ctx.drawImage(img, ix, iy, iw, ih);
    } else if (ed.bgMode === "solid") {
      ctx.fillStyle = ed.solid;
      ctx.fillRect(0, 0, W, H);
    } else {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, ed.gradient[0]);
      g.addColorStop(0.5, ed.gradient[1]);
      g.addColorStop(1, ed.gradient[2]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    const text = (ed.text || "").trim();
    if (!text) return;

    ctx.font = `700 ${ed.size}px ${fontFamily(ed.font)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxW = W * 0.86;
    const lines = wrapText(ctx, text, maxW);
    const lineH = ed.size * 1.25;
    const blockH = lines.length * lineH;
    let cx = ed.x * W;
    let cy = ed.y * H;

    // Bars
    if (ed.bar === "top" || ed.bar === "both") {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, W, Math.max(120, blockH + 80));
      if (ed.bar === "top") {
        cy = Math.max(120, blockH + 80) / 2;
      }
    }
    if (ed.bar === "bottom" || ed.bar === "both") {
      const bh = Math.max(120, blockH + 80);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, H - bh, W, bh);
      if (ed.bar === "bottom") {
        cy = H - bh / 2;
      }
      if (ed.bar === "both") {
        cy = H - bh / 2;
      }
    }

    const startY = cy - (blockH - lineH) / 2;
    lines.forEach((line, i) => {
      const y = startY + i * lineH;
      if (ed.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.65)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 3;
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }
      if (ed.outline) {
        ctx.lineWidth = Math.max(3, ed.size / 12);
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(line, cx, y);
      }
      ctx.fillStyle = ed.color;
      ctx.fillText(line, cx, y);
    });
    ctx.shadowColor = "transparent";
  }

  function bindEditor() {
    const canvas = $("#editor-canvas");

    $("#image-input").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        state.editor.image = img;
        state.editor.bgMode = "image";
        $$(".bg-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === "image"));
        drawEditor();
        URL.revokeObjectURL(url);
      };
      img.src = url;
    });

    $$(".bg-mode button").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".bg-mode button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.editor.bgMode = btn.dataset.mode;
        if (btn.dataset.mode === "solid") state.editor.solid = $("#solid-color").value;
        drawEditor();
      });
    });

    $("#solid-color").addEventListener("input", (e) => {
      state.editor.solid = e.target.value;
      if (state.editor.bgMode === "solid") drawEditor();
    });

    $("#editor-text").addEventListener("input", (e) => {
      state.editor.text = e.target.value;
      drawEditor();
    });
    $("#font-select").addEventListener("change", (e) => {
      state.editor.font = e.target.value;
      drawEditor();
    });
    $("#font-size").addEventListener("input", (e) => {
      state.editor.size = Number(e.target.value);
      $("#font-size-val").textContent = state.editor.size;
      drawEditor();
    });
    $("#text-color").addEventListener("input", (e) => {
      state.editor.color = e.target.value;
      drawEditor();
    });
    $("#toggle-outline").addEventListener("change", (e) => {
      state.editor.outline = e.target.checked;
      drawEditor();
    });
    $("#toggle-shadow").addEventListener("change", (e) => {
      state.editor.shadow = e.target.checked;
      drawEditor();
    });
    $$(".bar-mode button").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".bar-mode button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.editor.bar = btn.dataset.bar;
        drawEditor();
      });
    });

    // Drag caption position
    function pointerPos(ev) {
      const rect = canvas.getBoundingClientRect();
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      return {
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height
      };
    }
    function startDrag(ev) {
      state.editor.dragging = true;
      const p = pointerPos(ev);
      state.editor.x = Math.min(0.92, Math.max(0.08, p.x));
      state.editor.y = Math.min(0.92, Math.max(0.08, p.y));
      drawEditor();
      ev.preventDefault();
    }
    function moveDrag(ev) {
      if (!state.editor.dragging) return;
      const p = pointerPos(ev);
      state.editor.x = Math.min(0.92, Math.max(0.08, p.x));
      state.editor.y = Math.min(0.92, Math.max(0.08, p.y));
      drawEditor();
      ev.preventDefault();
    }
    function endDrag() {
      state.editor.dragging = false;
    }
    canvas.addEventListener("mousedown", startDrag);
    window.addEventListener("mousemove", moveDrag);
    window.addEventListener("mouseup", endDrag);
    canvas.addEventListener("touchstart", startDrag, { passive: false });
    canvas.addEventListener("touchmove", moveDrag, { passive: false });
    canvas.addEventListener("touchend", endDrag);

    $("#btn-export").addEventListener("click", exportPNG);
    $("#btn-use-caption").addEventListener("click", () => {
      if (state.currentCaption) {
        state.editor.text = state.currentCaption;
        $("#editor-text").value = state.currentCaption;
        drawEditor();
        toast("Caption loaded");
      }
    });
  }

  async function exportPNG() {
    drawEditor();
    const canvas = $("#editor-canvas");
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) {
      toast("Export failed");
      return;
    }
    try {
      await addExport(blob, state.editor.text);
    } catch (e) {
      console.warn(e);
    }
    const file = new File([blob], "studio-caption.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Studio caption" });
        toast("Shared");
        renderGallery();
        return;
      } catch (e) {
        if (e && e.name === "AbortError") {
          renderGallery();
          return;
        }
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "studio-caption.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Saved PNG");
    renderGallery();
  }

  /* ---------- Saved / favorites / gallery ---------- */
  function renderSaved() {
    const favs = loadJSON(LS.favorites, []);
    const saved = loadJSON(LS.saved, []);
    const favRoot = $("#favorites-list");
    const savedRoot = $("#saved-list");

    favRoot.innerHTML = favs.length
      ? favs
          .map(
            (f, i) => `<div class="fav-item" data-i="${i}">
          <div class="meta">Favorite · ${f.theme || ""}</div>
          <p>${escapeHtml(f.text)}</p>
          <div class="btn-row">
            <button class="btn" data-act="copy">Copy</button>
            <button class="btn" data-act="edit">To editor</button>
            <button class="btn danger" data-act="del">Remove</button>
          </div>
        </div>`
          )
          .join("")
      : `<div class="empty">No favorites yet</div>`;

    savedRoot.innerHTML = saved.length
      ? saved
          .map(
            (f, i) => `<div class="saved-item" data-i="${i}">
          <div class="meta">Saved · ${f.theme || ""}</div>
          <p>${escapeHtml(f.text)}</p>
          <div class="btn-row">
            <button class="btn" data-act="copy">Copy</button>
            <button class="btn" data-act="edit">To editor</button>
            <button class="btn danger" data-act="del">Delete</button>
          </div>
        </div>`
          )
          .join("")
      : `<div class="empty">No saved captions yet</div>`;

    favRoot.onclick = async (e) => {
      const item = e.target.closest(".fav-item");
      if (!item) return;
      const act = e.target.dataset.act;
      const i = Number(item.dataset.i);
      const list = loadJSON(LS.favorites, []);
      if (act === "copy") {
        await navigator.clipboard.writeText(list[i].text);
        toast("Copied");
      } else if (act === "edit") {
        state.editor.text = list[i].text;
        $("#editor-text").value = list[i].text;
        switchTab("editor");
        $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === "editor"));
      } else if (act === "del") {
        list.splice(i, 1);
        saveJSON(LS.favorites, list);
        renderSaved();
      }
    };

    savedRoot.onclick = async (e) => {
      const item = e.target.closest(".saved-item");
      if (!item) return;
      const act = e.target.dataset.act;
      const i = Number(item.dataset.i);
      const list = loadJSON(LS.saved, []);
      if (act === "copy") {
        await navigator.clipboard.writeText(list[i].text);
        toast("Copied");
      } else if (act === "edit") {
        state.editor.text = list[i].text;
        $("#editor-text").value = list[i].text;
        switchTab("editor");
        $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === "editor"));
      } else if (act === "del") {
        list.splice(i, 1);
        saveJSON(LS.saved, list);
        renderSaved();
      }
    };
  }

  async function renderGallery() {
    const root = $("#gallery-list");
    let rows = [];
    try {
      rows = await listExports();
    } catch {
      rows = [];
    }
    if (!rows.length) {
      root.innerHTML = `<div class="empty">No exports yet — create one in Editor</div>`;
      return;
    }
    root.innerHTML = `<div class="gallery-grid">${rows
      .map(
        (r) => `<div class="gallery-item" data-id="${r.id}">
        <img src="${r.dataUrl}" alt="export"/>
        <div class="actions">
          <button class="btn ghost" data-act="dl">Save</button>
          <button class="btn ghost" data-act="del" style="color:var(--danger)">Delete</button>
        </div>
      </div>`
      )
      .join("")}</div>`;

    root.onclick = async (e) => {
      const item = e.target.closest(".gallery-item");
      if (!item) return;
      const act = e.target.dataset.act;
      const id = Number(item.dataset.id);
      if (act === "del") {
        await deleteExport(id);
        renderGallery();
      } else if (act === "dl") {
        const a = document.createElement("a");
        a.href = item.querySelector("img").src;
        a.download = "studio-caption.png";
        a.click();
      }
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- Settings ---------- */
  function bindSettings() {
    $("#btn-change-pin").addEventListener("click", () => {
      showLock("change");
    });
    $("#btn-clear-data").addEventListener("click", () => {
      $("#confirm-clear").classList.remove("hidden");
    });
    $("#confirm-clear-cancel").addEventListener("click", () => {
      $("#confirm-clear").classList.add("hidden");
    });
    $("#confirm-clear-ok").addEventListener("click", async () => {
      localStorage.removeItem(LS.favorites);
      localStorage.removeItem(LS.saved);
      try {
        await clearExports();
      } catch {}
      $("#confirm-clear").classList.add("hidden");
      renderSaved();
      renderGallery();
      toast("Data cleared");
    });
    $("#btn-lock-now").addEventListener("click", () => {
      sessionStorage.removeItem(LS.unlocked);
      showLock("enter");
    });
    const count = window.CaptionEngine.countTemplates();
    $("#template-count").textContent = String(count);
  }

  /* ---------- Init ---------- */
  function init() {
    bindPinPad();
    bindGenerator();
    bindEditor();
    bindSettings();

    $$(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Default gradient preview
    drawEditor();

    const hasPin = !!localStorage.getItem(LS.pinHash);
    const sess = sessionStorage.getItem(LS.unlocked) === "1";
    if (!hasPin) {
      showLock("set");
    } else if (sess) {
      unlockApp();
    } else {
      showLock("enter");
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
