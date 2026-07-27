// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const fmtBytes = (b) => {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + u[i];
};
const fmtDuration = (s) => {
  if (!s) return "0:00";
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ":" + String(r).padStart(2, "0");
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const getFolderName = (path) => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

// ---------- state ----------
let selectedFormatId = "best";
let browsePath = "";
let browseParent = "/";
let currentMounts = [];
let activePrivacyFolder = null;
let activeUnlockFolder = null;
let playerControlsTimeout = null;
let isDraggingProgress = false;
let currentPlaylist = [];
let currentPlaylistIndex = -1;
let heroVideo = null;
let heroPlaylist = [];
let heroSlides = [];
let heroSlideIndex = 0;
let heroSlideTimer = null;

// ---------- tabs ----------
function showView(view, { scrollTop = true } = {}) {
  document.querySelectorAll(".tab").forEach(tab =>
    tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".view").forEach(section =>
    section.classList.toggle("active", section.id === "view-" + view));

  if (view === "library") loadLibrary();
  if (view === "home") loadHome();
  if (scrollTop) window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => showView(tab.dataset.view));
});

$("heroDownloadAction").addEventListener("click", () => {
  showView("download");
  setTimeout(() => $("url").focus(), 350);
});

$("heroPrimaryAction").addEventListener("click", () => {
  $("catalogContent").scrollIntoView({ behavior: "smooth", block: "start" });
});

$("btnGlobalSearch").addEventListener("click", () => {
  showView("home");
  setTimeout(() => {
    $("catalogSearch").focus();
    $("catalogContent").scrollIntoView({ behavior: "smooth", block: "start" });
  }, 350);
});

function applyCatalogFilter() {
  const query = $("catalogSearch").value.trim().toLocaleLowerCase("pt-BR");
  document.querySelectorAll("#homeRows .home-row").forEach(row => {
    let visibleCards = 0;
    row.querySelectorAll(".lib-video").forEach(card => {
      const title = card.querySelector(".lv-name")?.textContent || "";
      const visible = !query || title.toLocaleLowerCase("pt-BR").includes(query);
      card.classList.toggle("hidden", !visible);
      if (visible) visibleCards++;
    });
    const locked = Boolean(row.querySelector(".lock-placeholder"));
    row.classList.toggle("hidden", Boolean(query) && !locked && visibleCards === 0);
  });
}

$("catalogSearch").addEventListener("input", applyCatalogFilter);

// ---------- Analisar ----------
$("btnInfo").addEventListener("click", analyze);
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(); });

async function analyze() {
  const url = $("url").value.trim();
  if (!url) return;
  $("btnInfo").disabled = true;
  $("btnInfo").textContent = "Analisando...";
  $("infoError").classList.add("hidden");
  $("downloadCard").classList.add("hidden");
  try {
    const info = await api("/api/info", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    renderInfo(info);
    $("downloadCard").classList.remove("hidden");
  } catch (e) {
    $("infoError").textContent = e.message;
    $("infoError").classList.remove("hidden");
  } finally {
    $("btnInfo").disabled = false;
    $("btnInfo").textContent = "Analisar link";
  }
}

function renderInfo(info) {
  $("infoTitle").textContent = info.title || "(sem título)";
  const meta = [];
  if (info.duration) meta.push("⏱ " + fmtDuration(info.duration));
  if (info.uploader) meta.push("👤 " + info.uploader);
  if (info.ext) meta.push("ext: " + info.ext);
  $("infoMeta").textContent = meta.join(" · ");
  const thumb = $("thumb");
  if (info.thumbnail) { thumb.src = info.thumbnail; thumb.classList.remove("hidden"); }
  else thumb.classList.add("hidden");

  // Carregar e preencher pastas recentes
  api("/api/library").then(folders => {
    const list = $("recentDirsList");
    list.innerHTML = "";
    if (folders && folders.length > 0) {
      folders.slice(0, 5).forEach(f => {
        const pill = document.createElement("span");
        pill.className = "recent-dir-pill";
        pill.textContent = "📁 " + getFolderName(f.path);
        pill.title = f.path;
        pill.addEventListener("click", () => {
          setOutDir(f.path);
        });
        list.appendChild(pill);
      });
    }
  }).catch(() => {});

  const sel = $("format");
  sel.innerHTML = "";
  const best = document.createElement("option");
  best.value = "b*+ba/b"; best.textContent = "🌟 Melhor (vídeo+áudio, máx qualidade)";
  sel.appendChild(best);
  const videoFmts = (info.formats || []).filter(f => f.has_video || (!f.vcodec && !f.acodec));
  videoFmts.sort((a, b) => (b.height || 0) - (a.height || 0));
  const seen = new Set();
  for (const f of videoFmts) {
    const key = (f.height || "") + "-" + f.ext + "-" + (f.has_audio ? 1 : 0);
    if (seen.has(key)) continue;
    seen.add(key);
    const opt = document.createElement("option");
    opt.value = f.video_only ? `${f.format_id}+bestaudio/best` : f.format_id;
    let label = `${f.resolution} · ${f.ext || "?"}` + (f.fps ? ` @${f.fps}fps` : "");
    if (f.video_only) label += " 🔇(s/ áudio nativo, adiciona melhor áudio)";
    opt.textContent = label + (f.filesize ? ` (${fmtBytes(f.filesize)})` : "");
    sel.appendChild(opt);
  }
  const pref = localStorage.getItem("sd_quality");
  if (pref && [...sel.options].some(o => o.value === pref)) sel.value = pref;
  selectedFormatId = sel.value;
  sel.onchange = () => { selectedFormatId = sel.value; localStorage.setItem("sd_quality", selectedFormatId); };
}

// ---------- Explorador de Pastas (Salvar Arquivos) ----------
$("btnBrowse").addEventListener("click", () => openBrowser(browsePath || ""));
$("modalClose").addEventListener("click", closeBrowser);
$("goUp").addEventListener("click", () => browse(browseParent || "/"));
$("goHome").addEventListener("click", () => browse(""));
$("goDisks").addEventListener("click", toggleDisks);
$("btnMkdir").addEventListener("click", mkdir);
$("selectFolder").addEventListener("click", () => { setOutDir(browsePath); closeBrowser(); });

async function openBrowser(path) { 
  $("dirSearch").value = "";
  $("folderModal").classList.remove("hidden"); 
  await browse(path); 
}
function closeBrowser() { $("folderModal").classList.add("hidden"); }

async function mkdir() {
  const name = prompt("Nome da nova pasta:", "videos");
  if (!name) return;
  try {
    const res = await api("/api/mkdir", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: browsePath, name }),
    });
    await browse(browsePath); 
    browsePath = res.path;
    $("currentPath").textContent = browsePath;
    await browse(res.path);
  } catch (e) { alert("Erro ao criar pasta: " + e.message); }
}

function setOutDir(path) {
  $("outDir").value = path;
  localStorage.setItem("sd_outDir", path);
  api("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ default_out_dir: path }) }).catch(() => {});
}

async function toggleDisks() {
  const box = $("disksList");
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  if (!currentMounts.length) {
    box.innerHTML = '<div class="dir-item empty-dir">(nenhum disco montado)</div>';
  } else {
    box.innerHTML = currentMounts.map(m => `<div class="dir-item" data-mnt="${escapeHtml(m)}">💽 ${escapeHtml(m)}</div>`).join("");
    box.querySelectorAll(".dir-item[data-mnt]").forEach(el =>
      el.addEventListener("click", () => browse(el.dataset.mnt)));
  }
  box.classList.toggle("hidden");
}

async function browse(path) {
  try {
    const data = await api("/api/browse?path=" + encodeURIComponent(path));
    browsePath = data.path; browseParent = data.parent; currentMounts = data.mounts || [];
    $("currentPath").textContent = data.path;
    const list = $("dirList"); list.innerHTML = "";
    if (!data.dirs.length) {
      list.innerHTML = '<div class="dir-item-card empty-dir"><span class="dir-item-icon">📂</span><span class="dir-item-name">Vazia</span></div>';
      return;
    }
    for (const d of data.dirs) {
      const div = document.createElement("div");
      div.className = "dir-item-card"; 
      div.dataset.name = d;
      div.innerHTML = `
        <span class="dir-item-icon">📁</span>
        <span class="dir-item-name">${escapeHtml(d)}</span>
      `;
      div.addEventListener("click", () => {
        $("dirSearch").value = "";
        browse(data.path + "/" + d);
      });
      list.appendChild(div);
    }
  } catch (e) {
    $("dirList").innerHTML = `<div class="dir-item empty-dir">Erro: ${e.message}</div>`;
  }
}

// Filtro rápido de pastas na modal
$("dirSearch").addEventListener("input", (e) => {
  const val = e.target.value.toLowerCase().trim();
  const cards = $("dirList").querySelectorAll(".dir-item-card");
  cards.forEach(card => {
    const name = (card.dataset.name || "").toLowerCase();
    if (name.includes(val)) {
      card.classList.remove("hidden");
    } else {
      card.classList.add("hidden");
    }
  });
});

// ---------- Adicionar à fila ----------
$("btnAdd").addEventListener("click", async () => {
  const url = $("url").value.trim();
  const outDir = $("outDir").value.trim();
  if (!url) return;
  if (!outDir) { alert("Escolha uma pasta de destino."); return; }
  try {
    const res = await api("/api/download", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, format_id: selectedFormatId, out_dir: outDir }),
    });
    addJobRow(res.job_id, url, outDir);
    $("emptyQueue").classList.add("hidden");
    $("url").value = "";
    $("downloadCard").classList.add("hidden");
  } catch (e) { alert("Erro: " + e.message); }
});

// ---------- Fila ----------
function addJobRow(jobId, url, outDir) {
  const wrap = $("queue");
  const el = document.createElement("div");
  el.className = "job"; el.dataset.id = jobId;
  el.innerHTML = `
    <div class="job-top">
      <div class="job-title">${escapeHtml(url)}</div>
      <div class="job-status queued">na fila</div>
    </div>
    <div class="progress"><div class="bar"></div></div>
    <div class="job-meta"><span class="out">📁 ${escapeHtml(outDir)}</span><span class="pct"></span></div>
    <div class="job-actions"><button class="ghost small danger-text cancel">Cancelar</button></div>`;
  wrap.appendChild(el);
  el.querySelector(".cancel").addEventListener("click", () => cancelJob(jobId, el.querySelector(".cancel")));
  connectSSE(jobId, el);
}

function connectSSE(jobId, el) {
  const statusEl = el.querySelector(".job-status");
  const bar = el.querySelector(".bar");
  const pctEl = el.querySelector(".pct");
  const es = new EventSource("/api/progress/" + jobId);
  const setStatus = (s, text) => {
    statusEl.className = "job-status " + s; statusEl.textContent = text;
    el.className = "job " + (s === "error" ? "errored" : s === "done" ? "done" : "");
  };
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d._final) {
      es.close();
      if (d.status === "done") {
        setStatus("done", "✓ concluído"); bar.style.width = "100%"; loadHome();
        const actions = el.querySelector(".job-actions");
        actions.innerHTML = '<button class="primary small view-download">▶ Ver</button>';
        if (d.filename) {
          actions.querySelector(".view-download").addEventListener("click", () => {
            playVideo(d.filename, d.filename.split(/[\\/]/).pop());
          });
        } else {
          actions.querySelector(".view-download").disabled = true;
        }
      }
      else if (d.status === "cancelled") setStatus("cancelled", "cancelado");
      else if (d.status === "error") { setStatus("error", "erro"); pctEl.textContent = d.error || ""; }
      if (d.status !== "done") el.querySelector(".job-actions").innerHTML = "";
      return;
    }
    if (d.status === "downloading") {
      setStatus("downloading", "baixando");
      if (d.percent != null) {
        bar.style.width = d.percent + "%";
        let txt = d.percent + "%";
        if (d.speed) txt += " · " + fmtBytes(d.speed) + "/s";
        if (d.eta) txt += " · " + d.eta + "s rest";
        pctEl.textContent = txt;
      } else pctEl.textContent = "iniciando...";
    } else if (d.status === "merging") { setStatus("merging", "muxando"); bar.style.width = "99%"; }
    else if (d.status === "cancelling") setStatus("cancelling", "cancelando");
    else if (d.status === "cancelled") setStatus("cancelled", "cancelado");
    else if (d.status === "error") { setStatus("error", "erro"); pctEl.textContent = d.error || ""; }
    else if (d.status === "done") { setStatus("done", "✓ concluído"); bar.style.width = "100%"; loadHome(); }
  };
}

async function cancelJob(jobId, btn) {
  btn.disabled = true;
  try { await api("/api/cancel/" + jobId, { method: "POST" }); }
  catch (e) { alert("Erro ao cancelar: " + e.message); }
}

// ---------- Biblioteca ----------
$("btnRefreshLib").addEventListener("click", loadLibrary);
$("btnClearHistory").addEventListener("click", clearHistory);

async function loadLibrary() {
  try {
    const folders = await api("/api/library");
    const lib = $("library"); lib.innerHTML = "";
    if (!folders.length) { $("emptyLibrary").classList.remove("hidden"); return; }
    $("emptyLibrary").classList.add("hidden");
    
    for (const f of folders) {
      const el = document.createElement("div");
      el.className = "lib-folder";
      el.dataset.path = f.path;
      
      const privacyBadge = f.private 
        ? '<span class="badge badge-private">🔒 Privada</span>' 
        : '<span class="badge badge-public">🔓 Pública</span>';
        
      const contentText = f.private && f.locked 
        ? '🔒 Pasta trancada' 
        : `${f.count} vídeo(s)`;
        
      const openBtnText = f.private && f.locked ? 'Desbloquear' : 'Ver Conteúdo';
      const lockUnlockBtn = f.private 
        ? (f.locked 
            ? `<button class="ghost small unlock-shortcut" style="margin-left: 5px;">🔓 Abrir</button>` 
            : `<button class="ghost small lock-shortcut" style="margin-left: 5px;">🔒 Trancar</button>`) 
        : '';

      el.innerHTML = `
        <div class="lf-icon">📁</div>
        <div class="lf-name">${escapeHtml(f.path)}</div>
        <div class="lf-count">${contentText}</div>
        <div style="margin: 8px 0 14px 0; display: flex; align-items: center; gap: 6px;">
          ${privacyBadge}
        </div>
        <div class="lf-actions">
          <button class="ghost small open">${openBtnText}</button>
          <button class="ghost small privacy">⚙️ Segurança</button>
          <button class="ghost small rm danger-text">Remover</button>
          ${lockUnlockBtn}
        </div>
        <div class="lib-videos hidden"></div>`;
        
      lib.appendChild(el);
      
      el.querySelector(".open").addEventListener("click", (e) => { 
        e.stopPropagation(); 
        if (f.private && f.locked) {
          showUnlockModal(f.path);
        } else {
          toggleFolderVideos(el, f.path); 
        }
      });
      
      el.querySelector(".privacy").addEventListener("click", (e) => {
        e.stopPropagation();
        showPrivacyModal(f);
      });
      
      el.querySelector(".rm").addEventListener("click", (e) => { 
        e.stopPropagation(); 
        removeFolder(f.path, el); 
      });

      if (f.private) {
        if (f.locked) {
          el.querySelector(".unlock-shortcut").addEventListener("click", (e) => {
            e.stopPropagation();
            showUnlockModal(f.path);
          });
        } else {
          el.querySelector(".lock-shortcut").addEventListener("click", async (e) => {
            e.stopPropagation();
            await lockFolder(f.path);
            loadLibrary();
          });
        }
      }
    }
  } catch (e) { console.error(e); }
}

async function toggleFolderVideos(el, folder) {
  const box = el.querySelector(".lib-videos");
  const btn = el.querySelector(".open");
  if (!box.classList.contains("hidden")) {
    box.classList.add("hidden"); btn.textContent = "Ver Conteúdo"; el.classList.remove("expanded");
    return;
  }
  btn.textContent = "Carregando...";
  try {
    const data = await api("/api/scan?path=" + encodeURIComponent(folder));
    box.innerHTML = "";
    if (!data.videos.length) {
      box.innerHTML = '<div class="empty-state">Nenhum vídeo nesta pasta.</div>';
    } else {
      let idx = 0;
      for (const v of data.videos) {
        const currentIdx = idx;
        const resolutionBadge = v.name.includes("1080") ? "FHD" : (v.name.includes("2160") || v.name.includes("4k") || v.name.includes("4K") ? "4K" : "HD");
        const formatLabel = v.ext.replace(".", "").toUpperCase();
        const item = document.createElement("div");
        item.className = "lib-video";
        item.innerHTML = `
          <div class="lv-thumb">
            <img loading="lazy" src="/api/thumb?path=${encodeURIComponent(v.path)}" alt="" onerror="this.style.display='none';this.parentElement.classList.add('nothumb')">
          </div>
          <div class="lv-details">
            <div class="lv-top"><span class="lv-name">${escapeHtml(v.name)}</span></div>
            <div class="lv-meta-row">
              <span class="match-percentage">NA BIBLIOTECA</span>
              <span class="badge-hq">${resolutionBadge}</span>
              <span class="badge-ext">${formatLabel}</span>
              <span class="file-size">${fmtBytes(v.size)}</span>
            </div>
            <div class="lv-actions">
              <button class="play">▶ Assistir</button>
              <a class="dl" href="/api/file?path=${encodeURIComponent(v.path)}" download="${escapeHtml(v.name)}">⬇</a>
              <button class="del">🗑</button>
            </div>
          </div>`;
        item.querySelector(".play").addEventListener("click", () => playVideo(v.path, v.name, data.videos, currentIdx));
        item.querySelector(".del").addEventListener("click", () => deleteVideo(v, item, el, folder));
        box.appendChild(item);
        idx++;
      }
    }
    box.classList.remove("hidden");
    el.classList.add("expanded");
    btn.textContent = "Fechar";
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Erro: ${escapeHtml(e.message)}</div>`;
    box.classList.remove("hidden"); btn.textContent = "Ver Conteúdo";
  }
}

async function removeFolder(folder, el) {
  if (!confirm("Remover esta pasta da biblioteca? (não apaga os arquivos)")) return;
  await api("/api/library", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: folder }) });
  el.remove();
  if (!$("library").children.length) $("emptyLibrary").classList.remove("hidden");
  loadHome();
}

async function deleteVideo(v, item, folderEl, folder) {
  if (!confirm(`Excluir o arquivo "${v.name}" do disco?\nEsta ação não pode ser desfeita.`)) return;
  try {
    await api("/api/file", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: v.path }) });
    item.remove();
    if (folderEl.querySelector(".lf-count")) {
      const box = folderEl.querySelector(".lib-videos");
      const remaining = box ? box.querySelectorAll(".lib-video").length : 0;
      folderEl.querySelector(".lf-count").textContent = remaining + " vídeo(s)";
    }
    loadLibrary();
    loadHome();
  } catch (e) { alert("Erro ao excluir: " + e.message); }
}

async function clearHistory() {
  if (!confirm("Limpar todo o histórico da biblioteca?\n(os arquivos no disco NÃO serão apagados)")) return;
  await api("/api/history", { method: "DELETE" });
  await loadLibrary();
  loadHome();
}

// ---------- Tela Início (Netflix Grid) ----------
async function loadHome() {
  try {
    const folders = await api("/api/library");
    const homeRows = $("homeRows");
    homeRows.innerHTML = "";
    heroVideo = null;
    heroPlaylist = [];
    heroSlides = [];
    heroSlideIndex = 0;
    clearTimeout(heroSlideTimer);
    resetHomeHero();
    
    if (!folders.length) {
      $("emptyHome").classList.remove("hidden");
      return;
    }
    $("emptyHome").classList.add("hidden");
    
    for (const f of folders) {
      const row = document.createElement("div");
      row.className = "home-row";
      row.dataset.path = f.path;
      
      const folderName = getFolderName(f.path);
      const privacyBadge = f.private 
        ? '<span class="badge badge-private">🔒 Privado</span>' 
        : '<span class="badge badge-public">🔓 Público</span>';
        
      const lockUnlockAction = f.private 
        ? (f.locked 
            ? `<button class="ghost small btn-unlock-row">🔑 Desbloquear</button>` 
            : `<button class="ghost small btn-lock-row">🔒 Trancar</button>`)
        : '';
        
      row.innerHTML = `
        <div class="home-row-header">
          <div class="home-row-left">
            <span class="home-row-title">${escapeHtml(folderName)}</span>
            ${privacyBadge}
          </div>
          <div class="home-row-actions">
            ${lockUnlockAction}
          </div>
        </div>
        <div class="lib-videos"></div>`;
        
      homeRows.appendChild(row);
      
      const vidsContainer = row.querySelector(".lib-videos");
      
      if (f.private && f.locked) {
        vidsContainer.innerHTML = `
          <div class="lock-placeholder">
            <div class="lock-icon">🔒</div>
            <p>Conteúdo privado protegido</p>
            <button class="primary small btn-unlock-card">Desbloquear</button>
          </div>`;
          
        const triggerUnlock = (e) => {
          e.stopPropagation();
          showUnlockModal(f.path);
        };
        vidsContainer.querySelector(".lock-placeholder").addEventListener("click", triggerUnlock);
        if (row.querySelector(".btn-unlock-row")) {
          row.querySelector(".btn-unlock-row").addEventListener("click", triggerUnlock);
        }
      } else {
        try {
          const data = await api("/api/scan?path=" + encodeURIComponent(f.path));
          if (!data.videos.length) {
            vidsContainer.innerHTML = '<div class="empty-state">Nenhum vídeo nesta pasta.</div>';
          } else {
            heroSlides.push(...data.videos.map(video => ({
              video,
              playlist: data.videos,
              folderName
            })));
            let idx = 0;
            for (const v of data.videos) {
              const currentIdx = idx;
              const resolutionBadge = v.name.includes("1080") ? "FHD" : (v.name.includes("2160") || v.name.includes("4k") || v.name.includes("4K") ? "4K" : "HD");
              const formatLabel = v.ext.replace(".", "").toUpperCase();
              const item = document.createElement("div");
              item.className = "lib-video";
              item.innerHTML = `
                <div class="lv-thumb">
                  <img loading="lazy" src="/api/thumb?path=${encodeURIComponent(v.path)}" alt="" onerror="this.style.display='none';this.parentElement.classList.add('nothumb')">
                </div>
                <div class="lv-details">
                  <div class="lv-top"><span class="lv-name">${escapeHtml(v.name)}</span></div>
                  <div class="lv-meta-row">
                    <span class="match-percentage">NA BIBLIOTECA</span>
                    <span class="badge-hq">${resolutionBadge}</span>
                    <span class="badge-ext">${formatLabel}</span>
                    <span class="file-size">${fmtBytes(v.size)}</span>
                  </div>
                  <div class="lv-actions">
                    <button class="play">▶ Assistir</button>
                    <a class="dl" href="/api/file?path=${encodeURIComponent(v.path)}" download="${escapeHtml(v.name)}">⬇</a>
                    <button class="del">🗑</button>
                  </div>
                </div>`;
              item.querySelector(".play").addEventListener("click", () => playVideo(v.path, v.name, data.videos, currentIdx));
              item.querySelector(".del").addEventListener("click", () => deleteVideo(v, item, row, f.path));
              item.addEventListener("click", (event) => {
                if (event.target.closest(".lv-actions")) return;
                setHomeHero(v, data.videos, folderName);
                window.scrollTo({ top: 0, behavior: "smooth" });
              });
              vidsContainer.appendChild(item);
              idx++;
            }
          }
        } catch (err) {
          vidsContainer.innerHTML = `<div class="empty-state">Erro ao carregar vídeos: ${escapeHtml(err.message)}</div>`;
        }
        
        if (row.querySelector(".btn-lock-row")) {
          row.querySelector(".btn-lock-row").addEventListener("click", async (e) => {
            e.stopPropagation();
            await lockFolder(f.path);
            loadHome();
          });
        }
      }
    }
    if (heroSlides.length) {
      setHomeHero(heroSlides[0].video, heroSlides[0].playlist, heroSlides[0].folderName);
      startHeroSlideshow();
    }
    applyCatalogFilter();
  } catch (e) {
    console.error(e);
    $("emptyHome").classList.remove("hidden");
  }
}

function cleanDisplayTitle(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resetHomeHero() {
  $("homeHeroTitle").innerHTML = "Sua biblioteca.<br>Do seu jeito.";
  $("homeHeroDescription").textContent = "Organize seus vídeos em coleções, continue assistindo quando quiser e mantenha tudo no seu próprio dispositivo.";
  $("heroPrimaryAction").innerHTML = '<span aria-hidden="true">▶</span> Explorar catálogo';
  const art = $("homeHeroArt");
  art.classList.remove("has-image");
  art.style.backgroundImage = "";
}

function startHeroSlideshow() {
  clearTimeout(heroSlideTimer);
  if (heroSlides.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  heroSlideTimer = setTimeout(() => {
    heroSlideIndex = (heroSlideIndex + 1) % heroSlides.length;
    const slide = heroSlides[heroSlideIndex];
    setHomeHero(slide.video, slide.playlist, slide.folderName);
    startHeroSlideshow();
  }, 6500);
}

function setHomeHero(video, playlist, folderName) {
  heroVideo = video;
  heroPlaylist = playlist;
  $("homeHeroTitle").textContent = cleanDisplayTitle(video.name) || "Em destaque";
  $("homeHeroDescription").textContent = `Em destaque na coleção ${folderName}. Pronto para assistir diretamente da sua biblioteca local.`;
  $("heroPrimaryAction").innerHTML = '<span aria-hidden="true">▦</span> Ver catálogo';
  const art = $("homeHeroArt");
  art.classList.remove("has-image");
  art.style.backgroundImage = `url("/api/thumb?path=${encodeURIComponent(video.path)}")`;
  requestAnimationFrame(() => requestAnimationFrame(() => art.classList.add("has-image")));
}

// ---------- Modais de Senha / Privacidade ----------

// 1. Desbloqueio
function showUnlockModal(path) {
  activeUnlockFolder = path;
  $("passwordModalDesc").textContent = "Pasta: " + path;
  $("unlockPassword").value = "";
  $("unlockError").style.display = "none";
  $("passwordModal").classList.remove("hidden");
  $("unlockPassword").focus();
}

$("passwordModalClose").addEventListener("click", () => {
  $("passwordModal").classList.add("hidden");
  activeUnlockFolder = null;
});

$("btnConfirmUnlock").addEventListener("click", confirmUnlock);
$("unlockPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmUnlock();
});

async function confirmUnlock() {
  const password = $("unlockPassword").value;
  if (!password) return;
  $("unlockError").style.display = "none";
  try {
    await api("/api/folder/unlock", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: activeUnlockFolder, password })
    });
    $("passwordModal").classList.add("hidden");
    activeUnlockFolder = null;
    
    if (!$("view-home").classList.contains("hidden")) loadHome();
    if (!$("view-library").classList.contains("hidden")) loadLibrary();
  } catch (e) {
    $("unlockError").textContent = e.message;
    $("unlockError").style.display = "block";
  }
}

async function lockFolder(path) {
  try {
    await api("/api/folder/lock", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
  } catch (e) { console.error(e); }
}

// 2. Configurações de Privacidade
function showPrivacyModal(folder) {
  activePrivacyFolder = folder.path;
  $("privacyModalDesc").textContent = "Caminho: " + folder.path;
  
  $("privacyCurrentPassword").value = "";
  $("privacyPassword").value = "";
  $("privacyConfirmPassword").value = "";
  $("privacyError").style.display = "none";
  
  if (folder.private) {
    $("rowCurrentPassword").style.display = "flex";
    $("privacyEnabled").checked = true;
    $("privacyPasswordFields").style.display = "block";
  } else {
    $("rowCurrentPassword").style.display = "none";
    $("privacyEnabled").checked = false;
    $("privacyPasswordFields").style.display = "none";
  }
  
  $("privacyModal").classList.remove("hidden");
}

$("privacyModalClose").addEventListener("click", () => {
  $("privacyModal").classList.add("hidden");
  activePrivacyFolder = null;
});

$("privacyEnabled").addEventListener("change", (e) => {
  if (e.target.checked) {
    $("privacyPasswordFields").style.display = "block";
  } else {
    $("privacyPasswordFields").style.display = "none";
  }
});

$("btnSavePrivacy").addEventListener("click", savePrivacySettings);

async function savePrivacySettings() {
  const private = $("privacyEnabled").checked;
  const password = $("privacyPassword").value;
  const confirmPassword = $("privacyConfirmPassword").value;
  const current_password = $("privacyCurrentPassword").value;
  
  $("privacyError").style.display = "none";
  
  if (private) {
    if (!password) {
      showPrivacyError("A senha não pode estar em branco.");
      return;
    }
    if (password !== confirmPassword) {
      showPrivacyError("As senhas não coincidem.");
      return;
    }
  }
  
  try {
    await api("/api/folder/privacy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: activePrivacyFolder,
        private,
        password,
        current_password
      })
    });
    
    $("privacyModal").classList.add("hidden");
    activePrivacyFolder = null;
    
    if (!$("view-home").classList.contains("hidden")) loadHome();
    if (!$("view-library").classList.contains("hidden")) loadLibrary();
  } catch (e) {
    showPrivacyError(e.message);
  }
}

function showPrivacyError(msg) {
  $("privacyError").textContent = msg;
  $("privacyError").style.display = "block";
}


// ---------- Player Customizado Cinema ----------
$("playerClose").addEventListener("click", closePlayer);

function playVideo(path, name, playlist = [], index = -1) {
  currentPlaylist = playlist;
  currentPlaylistIndex = index;

  $("playerTitle").textContent = name;
  $("playerPath").textContent = path;
  
  const v = $("player");
  const container = $("playerContainer");
  const overlay = $("playerOverlay");
  
  // Abre em modo cinema (tela maior) por padrão ao reproduzir
  container.classList.add("theater"); 
  $("playerModal").classList.remove("windowed-mode");
  overlay.classList.remove("inactive");
  
  v.src = "/api/play?path=" + encodeURIComponent(path);
  $("playerModal").classList.remove("hidden");
  
  v.volume = parseFloat($("vol").value);
  v.muted = false;
  updateVolumeUI(v.volume);
  updatePlayPauseUI(true);
  
  const p = v.play();
  if (p && p.catch) p.catch(() => {});
  
  resetControlTimer();
  updateNextButtonUI();
}

function updateNextButtonUI() {
  const btn = $("btnNext");
  if (!btn) return;
  if (currentPlaylistIndex >= 0 && currentPlaylistIndex < currentPlaylist.length - 1) {
    btn.disabled = false;
    btn.style.opacity = "1";
    btn.style.pointerEvents = "auto";
  } else {
    btn.disabled = true;
    btn.style.opacity = "0.3";
    btn.style.pointerEvents = "none";
  }
}

function playNextVideo() {
  if (currentPlaylistIndex >= 0 && currentPlaylistIndex < currentPlaylist.length - 1) {
    const nextIdx = currentPlaylistIndex + 1;
    const nextVideo = currentPlaylist[nextIdx];
    playVideo(nextVideo.path, nextVideo.name, currentPlaylist, nextIdx);
  }
}

// Configura evento de clique para passar de vídeo
$("btnNext").addEventListener("click", playNextVideo);

// Quando o vídeo atual termina, toca o próximo
$("player").addEventListener("ended", () => {
  if (currentPlaylistIndex >= 0 && currentPlaylistIndex < currentPlaylist.length - 1) {
    playNextVideo();
  } else {
    updatePlayPauseUI(false);
    $("playerCenterBtn").classList.add("visible");
  }
});

function closePlayer() {
  const v = $("player");
  v.pause(); v.removeAttribute("src"); v.load();
  $("playerModal").classList.add("hidden");
  clearTimeout(playerControlsTimeout);
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

function togglePlayPause() {
  const v = $("player");
  if (v.paused) {
    v.play();
    updatePlayPauseUI(true);
    // central brief feedback
    $("playerCenterBtn").classList.remove("visible");
  } else {
    v.pause();
    updatePlayPauseUI(false);
    $("playerCenterBtn").classList.add("visible");
  }
  resetControlTimer();
}

$("btnPlayPause").addEventListener("click", togglePlayPause);
$("playerCenterBtn").addEventListener("click", togglePlayPause);

function updatePlayPauseUI(isPlaying) {
  const btn = $("btnPlayPause");
  const playIcon = btn.querySelector(".play-icon");
  const pauseIcon = btn.querySelector(".pause-icon");
  
  const centerBtn = $("playerCenterBtn");
  const centerPlay = centerBtn.querySelector(".play-svg");
  const centerPause = centerBtn.querySelector(".pause-svg");
  
  if (isPlaying) {
    playIcon.classList.add("hidden");
    pauseIcon.classList.remove("hidden");
    
    centerPlay.classList.add("hidden");
    centerPause.classList.remove("hidden");
  } else {
    playIcon.classList.remove("hidden");
    pauseIcon.classList.add("hidden");
    
    centerPlay.classList.remove("hidden");
    centerPause.classList.add("hidden");
  }
}

// 10s Rewind / Forward
$("btnRewind").addEventListener("click", () => {
  const v = $("player");
  v.currentTime = Math.max(0, v.currentTime - 10);
  resetControlTimer();
});

$("btnForward").addEventListener("click", () => {
  const v = $("player");
  v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
  resetControlTimer();
});

// Fullscreen
$("btnFullscreen").addEventListener("click", toggleFullscreen);

function toggleFullscreen() {
  const container = $("playerContainer");
  const enterSvg = $("btnFullscreen").querySelector(".fs-enter");
  const exitSvg = $("btnFullscreen").querySelector(".fs-exit");
  
  if (!document.fullscreenElement) {
    container.requestFullscreen().then(() => {
      enterSvg.classList.add("hidden");
      exitSvg.classList.remove("hidden");
    }).catch(err => console.error(err));
  } else {
    document.exitFullscreen().then(() => {
      enterSvg.classList.remove("hidden");
      exitSvg.classList.add("hidden");
    }).catch(err => console.error(err));
  }
  resetControlTimer();
}

document.addEventListener("fullscreenchange", () => {
  const enterSvg = $("btnFullscreen").querySelector(".fs-enter");
  const exitSvg = $("btnFullscreen").querySelector(".fs-exit");
  if (!document.fullscreenElement) {
    enterSvg.classList.remove("hidden");
    exitSvg.classList.add("hidden");
  } else {
    enterSvg.classList.add("hidden");
    exitSvg.classList.remove("hidden");
  }
});

// Modo Cinema
$("btnTheater").addEventListener("click", () => {
  const container = $("playerContainer");
  container.classList.toggle("theater");
  $("playerModal").classList.toggle("windowed-mode", !container.classList.contains("theater"));
  resetControlTimer();
});

// Volume Slider
$("vol").addEventListener("input", (e) => {
  const volume = parseFloat(e.target.value);
  const v = $("player");
  v.volume = volume;
  v.muted = volume === 0;
  updateVolumeUI(volume);
  resetControlTimer();
});

$("btnMute").addEventListener("click", () => {
  const v = $("player");
  v.muted = !v.muted;
  updateVolumeUI(v.volume);
  resetControlTimer();
});

function updateVolumeUI(volume) {
  const v = $("player");
  const muteBtn = $("btnMute");
  const high = muteBtn.querySelector(".vol-high-icon");
  const mute = muteBtn.querySelector(".vol-mute-icon");
  
  if (volume === 0 || v.muted) {
    high.classList.add("hidden");
    mute.classList.remove("hidden");
    $("vol").value = 0;
  } else {
    high.classList.remove("hidden");
    mute.classList.add("hidden");
    $("vol").value = volume;
  }
}

// Time update & Custom progress bar
$("player").addEventListener("timeupdate", () => {
  const v = $("player");
  const cur = v.currentTime;
  const dur = v.duration || 0;
  
  $("currentTime").textContent = fmtDuration(cur);
  $("durationTime").textContent = fmtDuration(dur);
  
  if (dur > 0 && !isDraggingProgress) {
    const pct = (cur / dur) * 100;
    $("progressBar").style.width = pct + "%";
    $("progressHandle").style.left = pct + "%";
  }
});

$("player").addEventListener("loadedmetadata", () => {
  $("durationTime").textContent = fmtDuration($("player").duration);
});

// Seek Drag/Click Events
const progressContainer = $("progressContainer");

progressContainer.addEventListener("click", (e) => {
  seek(e);
});

progressContainer.addEventListener("mousedown", (e) => {
  isDraggingProgress = true;
});

document.addEventListener("mouseup", () => {
  isDraggingProgress = false;
});

document.addEventListener("mousemove", (e) => {
  if (isDraggingProgress) {
    seek(e);
  }
  
  if (!$("playerModal").classList.contains("hidden")) {
    resetControlTimer();
  }
});

function seek(e) {
  const rect = progressContainer.getBoundingClientRect();
  const v = $("player");
  const dur = v.duration || 0;
  if (dur === 0) return;
  
  const pos = (e.clientX - rect.left) / rect.width;
  const clamped = Math.max(0, Math.min(1, pos));
  v.currentTime = clamped * dur;
  
  const pct = clamped * 100;
  $("progressBar").style.width = pct + "%";
  $("progressHandle").style.left = pct + "%";
}

progressContainer.addEventListener("mousemove", (e) => {
  const rect = progressContainer.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width;
  const clamped = Math.max(0, Math.min(1, pos));
  $("progressHover").style.width = (clamped * 100) + "%";
});

// Auto-hide controls overlay
function resetControlTimer() {
  const overlay = $("playerOverlay");
  if (!overlay) return;
  
  overlay.classList.remove("inactive");
  clearTimeout(playerControlsTimeout);
  
  const v = $("player");
  if (!v.paused) {
    playerControlsTimeout = setTimeout(() => {
      overlay.classList.add("inactive");
      $("playerCenterBtn").classList.remove("visible");
    }, 2500);
  }
}

$("playerContainer").addEventListener("mousemove", resetControlTimer);

// ---------- Eventos Globais ----------
window.addEventListener("keydown", (e) => {
  const v = $("player");
  const isPlayerOpen = !$("playerModal").classList.contains("hidden");
  
  if (e.key === "Escape") { 
    closePlayer(); 
    closeBrowser(); 
    $("passwordModal").classList.add("hidden");
    $("privacyModal").classList.add("hidden");
  }
  
  if (isPlayerOpen) {
    // Espaço: Play/Pause
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      togglePlayPause();
    }
    // Setas esquerda/direita: seek 10s
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      v.currentTime = Math.max(0, v.currentTime - 10);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
    }
    // Setas cima/baixo: volume
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const vol = Math.min(1, v.volume + 0.1);
      v.volume = vol;
      v.muted = false;
      updateVolumeUI(vol);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const vol = Math.max(0, v.volume - 0.1);
      v.volume = vol;
      v.muted = vol === 0;
      updateVolumeUI(vol);
    }
    // Tecla F: Fullscreen
    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      toggleFullscreen();
    }
  }
});

// Efeito de rolagem na barra de navegação superior (estilo Netflix)
window.addEventListener("scroll", () => {
  const topbar = $("topbar");
  if (topbar) {
    if (window.scrollY > 20) {
      topbar.classList.add("scrolled");
    } else {
      topbar.classList.remove("scrolled");
    }
  }
});

// init
(async function initConfig() {
  try {
    const cfg = await api("/api/config");
    const dir = localStorage.getItem("sd_outDir") || cfg.default_out_dir || "";
    if (dir) $("outDir").value = dir;
  } catch (e) {}
})();
loadLibrary();
loadHome();
