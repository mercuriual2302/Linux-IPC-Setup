// why is javascript so hard? 
// renderer/renderer.js — UI logic for the Electron app.
// Adapted from the inline <script> in twincat_setup_gui_v4.html, plus:
//   • Test Connection button  → main.invoke('ssh:test')
//   • Fetch From CX button    → main.invoke('ssh:fetch-packages')
//   • Run Setup / Apply Config → main.invoke('ssh:run-setup' | 'ssh:run-tf1200') + streaming
//   • View toggle (terminal vs script preview)


// Curated list with descriptions/grouping. Any extras discovered from
// `apt-cache search` get appended as "discovered" with group = 'Discovered'.
const PACKAGES_SEED = [
  { name:'tf1200-ui-client',             desc:'TF1200 TwinCAT UI Client',                group:'HMI / UI',      default:false  },
  { name:'tf1810-plc-hmi-web',           desc:'TF1810 TC3 PLC HMI Web',                  group:'HMI / UI',      default:false },
  { name:'tf2000-hmi-server',            desc:'TF2000 HMI Server',                       group:'HMI / UI',      default:false  },
  { name:'tf5000-nc-ptp-xar',            desc:'TF5000 TwinCAT 3 NC PTP motion control',  group:'Motion',        default:false  },
  { name:'tf6100-opc-ua-server',         desc:'TF6100 TC3 OPC UA Server',                group:'Communication', default:false },
  { name:'tf610x-opcuaclientpubsub-xar', desc:'TF610x TC3 OPC UA Client PubSub',         group:'Communication', default:false },
  { name:'tf6250-modbus-tcp',            desc:'TwinCAT Modbus TCP Server',               group:'Communication', default:false  },
  { name:'tf6310-tcp-ip',                desc:'TwinCAT TCP/IP Server',                   group:'Communication', default:false },
  { name:'tf6340-serial-communication',  desc:'TF6340 TC3 Serial Communication',         group:'Communication', default:false },
  { name:'tf627x-profinet-rt-xar',       desc:'TwinCAT PROFINET RT driver',              group:'Communication', default:false },
  { name:'tf628x-ethernetip-xar',        desc:'TwinCAT EtherNet/IP driver',              group:'Communication', default:false },
  { name:'tf6620-s7-communication-xar',  desc:'TwinCAT 3 S7 Communication',              group:'Communication', default:false },
  { name:'tf6420-database-server',       desc:'TF6420 Database Server',                  group:'Data',          default:false },
  { name:'tf6421-xml-server',            desc:'TwinCAT XML Data Server',                 group:'Data',          default:false },
  { name:'tf8020-bacnet-xar',            desc:'TF8020 TwinCAT 3 BACnet driver',          group:'Industrial',    default:false },
  { name:'mdp-bhf',                      desc:'Modular Device Profile (System Service)', group:'System',        default:false  },
  { name:'tc31-xar-multiconfigcoupler',  desc:'TwinCAT MultiConfigCoupler driver',       group:'System',        default:false },
  { name:'tc31-xar-ethercatslave',       desc:'TwinCAT EtherCAT Slave driver',           group:'System',        default:false },
  { name:'adstool',                      desc:'CLI tool for ADS access to TwinCAT',      group:'System',        default:false },
  { name:'tcusbsrv',                     desc:'TwinCAT 3 USB Service',                   group:'System',        default:false },
  { name:'te1111-ethercat-simulation-xar',desc:'TwinCAT EtherCAT Simulation driver',     group:'System',        default:false },
  { name:'twincat-function-installer',   desc:'Install TwinCAT functions from licenses', group:'System',        default:false },
];

// Mutable list — seeds the grid, gets merged with discovery results.
let PACKAGES = [...PACKAGES_SEED];
const selectedPkgs = new Set(PACKAGES.filter(p => p.default).map(p => p.name));
const pkgVersions = {};
PACKAGES.forEach(p => pkgVersions[p.name] = { mode:'latest', version:'' });
pkgVersions['tc31-xar-um'] = { mode:'latest', version:'' };
pkgVersions['console-setup'] = { mode:'latest', version:'' };

// TF1200 JSON CONFIG STATE 
const jsonConfig = {
  allowMove:              { type:'bool',   value:true,   desc:'Allow window move' },
  allowResize:            { type:'bool',   value:true,   desc:'Allow window resize' },
  autoUpdateConfig:       { type:'bool',   value:true,   desc:'Auto reload config changes' },
  commandLineSwitches:    { type:'tags',   value:['ignore-certificate-errors'], desc:'Chromium flags' },
  enableDevTools:         { type:'bool',   value:false,  desc:'Open DevTools on start' },
  enableIncognitoMode:    { type:'bool',   value:false,  desc:'Incognito browsing mode' },
  enableKioskMode:        { type:'bool',   value:true,   desc:'Full-screen kiosk mode' },
  enableMenuBar:          { type:'bool',   value:false,  desc:'Show browser menu bar' },
  historyGoBackKeys:      { type:'text',   value:'Alt+Left',  desc:'Back navigation hotkey' },
  historyGoForwardKeys:   { type:'text',   value:'Alt+Right', desc:'Forward navigation hotkey' },
  maxVisualZoomLevelLimit:{ type:'num',    value:1,      desc:'Max zoom level (1 = 100%)' },
  openDevTools:           { type:'bool',   value:false,  desc:'Auto-open DevTools' },
  persistPosition:        { type:'bool',   value:true,   desc:'Remember window position' },
  persistSize:            { type:'bool',   value:true,   desc:'Remember window size' },
  quitApplicationKeys:    { type:'text',   value:'Esc',  desc:'Quit app hotkey' },
  reloadBrowserWindowKeys:{ type:'text',   value:'F5',   desc:'Reload page hotkey' },
  resetZoomKeys:          { type:'text',   value:'CmdOrCtrl+0', desc:'Reset zoom hotkey' },
  retryInterval:          { type:'num',    value:5000,   desc:'Retry interval (ms)' },
  retryMaxCount:          { type:'num',    value:5,      desc:'Max connection retries' },
  startUrl:               { type:'text',   value:'',     desc:'HMI URL on launch (auto-set)' },
  toggleDevToolsKeys:     { type:'text',   value:'',     desc:'Toggle DevTools hotkey' },
};

let selectedFeed = 'trixie-stable';
let activeSessionId = null;
let lastScript = '', lastFilename = 'setup.sh';
let terminalBuffer = '';


const $ = (id) => document.getElementById(id);

// HELPERS 
function chk() {
  return `<span class="pkg-check"><svg viewBox="0 0 8 8"><polyline points="1,4 3,6 7,2" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg></span>`;
}

function ipOk(s) { return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s); }

function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 3500);
}

function getConnOpts(which = 1) {
  const ip   = (which === 2 ? $('cx-ip2') : $('cx-ip')).value.trim();
  const pass = (which === 2 ? $('cx-pass2') : $('cx-pass')).value;
  return { host: ip, username: 'Administrator', password: pass, port: 22 };
}

// CREDENTIAL SYNC ACROSS TABS 
function syncCredentials() {
  const ip = $('cx-ip').value.trim();
  const pass = $('cx-pass').value;
  const ip2El = $('cx-ip2');
  const pass2El = $('cx-pass2');
  const banner = $('cred-sync-banner');
  const label = $('sync-ip-label');
  if (ip) {
    if (!ip2El.dataset.userEdited) ip2El.value = ip;
    if (!pass2El.dataset.userEdited) pass2El.value = pass;
    banner.style.display = 'flex';
    label.textContent = ip;
    const hmiEl = $('hmi-url');
    if (!hmiEl.dataset.userEdited && ipOk(ip)) {
      hmiEl.value = 'https://' + ip + ':2020';
      jsonConfig.startUrl.value = hmiEl.value;
    }
  } else {
    banner.style.display = 'none';
  }
  updateConnDots();
}

$('cx-ip').addEventListener('input', syncCredentials);
$('cx-pass').addEventListener('input', syncCredentials);
$('cx-ip2').addEventListener('input', function () {
  this.dataset.userEdited = '1';
  const ip = this.value.trim();
  const hmiEl = $('hmi-url');
  if (!hmiEl.dataset.userEdited && ipOk(ip)) {
    hmiEl.value = 'https://' + ip + ':2020';
    jsonConfig.startUrl.value = hmiEl.value;
    renderJsonEditor();
  }
  updateConnDots();
});
$('cx-pass2').addEventListener('input', function () { this.dataset.userEdited = '1'; });
$('hmi-url').addEventListener('input', function () {
  this.dataset.userEdited = '1';
  jsonConfig.startUrl.value = this.value.trim();
});

function updateConnDots() {
  const ip1 = $('cx-ip').value.trim();
  const ip2 = $('cx-ip2').value.trim();
  const ok1 = ipOk(ip1);
  const ok2 = ipOk(ip2) || ipOk(ip1);
  $('conn-dot').className  = 'status-dot' + (ok1 ? ' ok' : '');
  $('conn-status').textContent = ok1 ? 'target: ' + ip1 : 'not connected';
  $('conn-dot2').className = 'status-dot' + (ok2 ? ' ok' : '');
}

// GLOBAL CONNECTION STATUS BADGE
function setGlobalConn(state, text) {
  const badge = $('global-conn');
  const dot = $('global-dot');
  badge.classList.remove('ok', 'err');
  dot.classList.remove('ok', 'err', 'warn', 'pulse');
  if (state === 'ok') { badge.classList.add('ok'); dot.classList.add('ok'); }
  else if (state === 'err') { badge.classList.add('err'); dot.classList.add('err'); }
  else if (state === 'busy') { dot.classList.add('warn', 'pulse'); }
  $('global-conn-text').textContent = text;
}

// TEST CONNECTION 
$('btn-test').addEventListener('click', async () => {
  const opts = getConnOpts(1);
  if (!ipOk(opts.host)) { toast('Enter a valid IPv4 address first', 'warn'); return; }

  const btn = $('btn-test');
  btn.disabled = true; btn.textContent = 'CONNECTING…';
  setGlobalConn('busy', 'CONNECTING…');

  const res = await window.api.testConnection(opts);
  btn.disabled = false; btn.textContent = 'TEST CONNECTION';

  if (res.ok) {
    setGlobalConn('ok', 'CONNECTED · ' + opts.host);
    toast('SSH OK — ' + (res.output.split('\n')[0] || 'connected'), 'success');
  } else {
    setGlobalConn('err', 'FAILED');
    toast('SSH failed: ' + res.error, 'error');
  }
});

// FETCH PACKAGES FROM CX 
$('btn-fetch-pkgs').addEventListener('click', async () => {
  const opts = getConnOpts(1);
  if (!ipOk(opts.host)) { toast('Enter the CX IP first', 'warn'); return; }

  const btn = $('btn-fetch-pkgs');
  btn.disabled = true; btn.textContent = '⟳ FETCHING…';
  setGlobalConn('busy', 'apt-cache search…');

  const res = await window.api.fetchPackages(opts);
  btn.disabled = false; btn.textContent = '⟳ FETCH FROM FEED VIA CX';

  if (!res.ok) {
    setGlobalConn('err', 'FETCH FAILED');
    toast('Fetch failed: ' + res.error, 'error');
    return;
  }

  // Merge discovered packages with seed list, preserving curated descriptions.
  const existingNames = new Set(PACKAGES.map(p => p.name));
  const runtimePkgs = new Set(['tc31-xar-um', 'console-setup']);  // shown separately, don't duplicate
  let added = 0;
  for (const p of res.packages) {
    if (runtimePkgs.has(p.name) || existingNames.has(p.name)) continue;
    PACKAGES.push({
      name: p.name,
      desc: p.desc || '(discovered — no description)',
      group: 'Discovered',
      default: false,
      discovered: true
    });
    pkgVersions[p.name] = { mode: 'latest', version: '' };
    added++;
  }

  setGlobalConn('ok', `${res.packages.length} PKGS · ${opts.host}`);
  toast(`Found ${res.packages.length} TwinCAT packages (${added} new)`, 'success');
  renderPkgGrid($('pkg-search').value);
  renderVersionList();
});

// PACKAGE GRID RENDER
function renderPkgGrid(filter) {
  const grid = $('pkg-grid');
  const term = (filter || '').toLowerCase();
  const visible = PACKAGES.filter(p =>
    !term || p.name.toLowerCase().includes(term) ||
    p.desc.toLowerCase().includes(term) ||
    p.group.toLowerCase().includes(term)
  );
  // group-then-render, preserving declaration order of groups
  const groups = [];
  const seen = new Set();
  visible.forEach(p => { if (!seen.has(p.group)) { seen.add(p.group); groups.push(p.group); } });

  grid.innerHTML = '';
  groups.forEach(g => {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'grid-column:1/-1;font-family:var(--tc-mono);font-size:9px;color:var(--tc-accent);letter-spacing:.1em;text-transform:uppercase;padding:.4rem 0 .2rem;border-bottom:1px solid var(--tc-border);margin-top:.25rem';
    hdr.textContent = g;
    grid.appendChild(hdr);

    visible.filter(p => p.group === g).forEach(p => {
      const card = document.createElement('div');
      const isSel = selectedPkgs.has(p.name);
      card.className = 'pkg-card' + (isSel ? ' selected' : '') + (p.discovered ? ' discovered' : '');
      card.dataset.pkg = p.name;
      const badgeClass = p.discovered ? 'badge-new' : 'badge-opt';
      const badgeText = p.discovered ? 'NEW' : 'OPTIONAL';
      card.innerHTML = `<div class="pkg-badge ${badgeClass}">${badgeText}</div><div class="pkg-name">${chk()}${escapeHtml(p.name)}</div><div class="pkg-desc">${escapeHtml(p.desc)}</div>`;
      card.addEventListener('click', () => {
        if (selectedPkgs.has(p.name)) selectedPkgs.delete(p.name);
        else selectedPkgs.add(p.name);
        card.classList.toggle('selected');
        updateCount();
        renderVersionList();
        // re-render grid so tf2000 password field appears/disappears inline
        renderPkgGrid($('pkg-search').value);
      });
      grid.appendChild(card);

      // if this is tf2000-hmi-server and it's selected, inject password field inline
      if (p.name === 'tf2000-hmi-server' && selectedPkgs.has('tf2000-hmi-server')) {
        const passRow = document.createElement('div');
        passRow.style.cssText = 'grid-column:1/-1;margin:.35rem 0 .25rem';
        passRow.innerHTML = `
          <div style="background:var(--tc-surface2);border:1px solid var(--tc-border);border-radius:4px;padding:.75rem 1rem">
            <label style="display:block;font-size:11px;font-family:var(--tc-mono);color:var(--tc-muted);margin-bottom:.4rem;letter-spacing:.04em">TF2000 HMI SERVER PASSWORD</label>
            <input type="password" id="tf2000-pass" placeholder="Set __SystemAdministrator password" autocomplete="off"
              style="width:100%;background:var(--tc-bg);border:1px solid var(--tc-border);border-radius:4px;padding:.55rem .9rem;font-family:var(--tc-mono);font-size:13px;color:var(--tc-text);outline:none;margin-bottom:.5rem">
            <label style="display:block;font-size:11px;font-family:var(--tc-mono);color:var(--tc-muted);margin-bottom:.4rem;letter-spacing:.04em">CONFIRM PASSWORD</label>
            <input type="password" id="tf2000-pass-confirm" placeholder="Re-enter password" autocomplete="off"
              style="width:100%;background:var(--tc-bg);border:1px solid var(--tc-border);border-radius:4px;padding:.55rem .9rem;font-family:var(--tc-mono);font-size:13px;color:var(--tc-text);outline:none;margin-bottom:.35rem">
            <div id="tf2000-pass-match" style="font-size:10px;font-family:var(--tc-mono);display:none"></div>
            <div style="font-size:10px;color:var(--tc-muted);font-family:var(--tc-mono);margin-top:.35rem">Sets the <span style="color:var(--tc-warn)">__SystemAdministrator</span> password for the TF2000 HMI Server. Defaults to <span style="color:var(--tc-warn)">1</span> if left blank.</div>
          </div>`;
        // preserve any previously typed value
        if (window._tf2000PassValue) {
          passRow.querySelector('#tf2000-pass').value = window._tf2000PassValue;
        }
        if (window._tf2000PassConfirmValue) {
          passRow.querySelector('#tf2000-pass-confirm').value = window._tf2000PassConfirmValue;
        }
        passRow.querySelector('#tf2000-pass').addEventListener('input', function() {
          window._tf2000PassValue = this.value;
          checkTf2000Match();
        });
        passRow.querySelector('#tf2000-pass-confirm').addEventListener('input', function() {
          window._tf2000PassConfirmValue = this.value;
          checkTf2000Match();
        });
        grid.appendChild(passRow);
      }
    });
  });
  updateCount();
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function getTf2000Pass() {
  const el = document.getElementById('tf2000-pass');
  return (el ? el.value.trim() : '') || window._tf2000PassValue || '1';
}

function updateCount() {
  $('pkg-count').textContent = selectedPkgs.size + ' of ' + PACKAGES.length + ' optional packages selected';
}

$('pkg-search').addEventListener('input', function () { renderPkgGrid(this.value); });
$('sel-all').addEventListener('click', () => { PACKAGES.forEach(p => selectedPkgs.add(p.name)); renderPkgGrid($('pkg-search').value); renderVersionList(); });
$('sel-none').addEventListener('click', () => { selectedPkgs.clear(); renderPkgGrid($('pkg-search').value); renderVersionList(); });

// VERSION LIST
function renderVersionList() {
  const container = $('ver-list');
  const allPkgs = ['tc31-xar-um', 'console-setup', ...PACKAGES.filter(p => selectedPkgs.has(p.name)).map(p => p.name)];
  container.innerHTML = '';
  allPkgs.forEach(name => {
    if (!pkgVersions[name]) pkgVersions[name] = { mode:'latest', version:'' };
    const state = pkgVersions[name];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:.75rem;padding:.45rem 0;border-bottom:1px solid rgba(48,54,61,.4)';

    const nameCol = document.createElement('div');
    nameCol.style.cssText = 'font-family:var(--tc-mono);font-size:11px;color:var(--tc-text);flex:0 0 240px;padding-top:.25rem';
    const isRequired = name === 'tc31-xar-um' || name === 'console-setup';
    nameCol.innerHTML = `<span style="color:${isRequired ? 'var(--tc-warn)' : 'var(--tc-accent2)'}">${escapeHtml(name)}</span>`;

    const rightCol = document.createElement('div');
    rightCol.style.cssText = 'flex:1';
    rightCol.innerHTML = `<div class="ver-toggle">
      <div class="ver-opt ${state.mode==='latest' ? 'active' : ''}" data-mode="latest" data-pkg="${escapeHtml(name)}">LATEST</div>
      <div class="ver-opt ${state.mode==='pinned' ? 'active' : ''}" data-mode="pinned" data-pkg="${escapeHtml(name)}">PINNED</div>
    </div>`;
    if (state.mode === 'pinned') {
      const inp = document.createElement('input');
      inp.className = 'ver-input';
      inp.placeholder = 'e.g. 4026.19.0';
      inp.value = state.version || '';
      inp.addEventListener('input', function () { pkgVersions[name].version = this.value; });
      rightCol.appendChild(inp);
    }
    rightCol.querySelectorAll('.ver-opt').forEach(btn => {
      btn.addEventListener('click', function () {
        pkgVersions[this.dataset.pkg].mode = this.dataset.mode;
        renderVersionList();
      });
    });

    row.appendChild(nameCol);
    row.appendChild(rightCol);
    container.appendChild(row);
  });
}

// TABS
const tabs = document.querySelectorAll('.tab');
const pages = { setup:'page-setup', tf1200:'page-tf1200', cxmgmt:'page-cxmgmt', script:'page-script' };
tabs.forEach(t => t.addEventListener('click', () => {
  tabs.forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  Object.values(pages).forEach(p => $(p).classList.remove('active'));
  $(pages[t.dataset.tab]).classList.add('active');
  if (t.dataset.tab === 'tf1200') syncCredentials();
}));

//  FEED TOGGLE 
document.querySelectorAll('#feed-toggle .toggle-opt').forEach(o => o.addEventListener('click', () => {
  document.querySelectorAll('#feed-toggle .toggle-opt').forEach(x => x.classList.remove('active'));
  o.classList.add('active');
  selectedFeed = o.dataset.val;
  $('feed-hint').textContent = selectedFeed === 'trixie-stable'
    ? 'Recommended · production-ready packages'
    : 'Cutting-edge · may contain unstable packages';
}));

//  JSON EDITOR 
function renderJsonEditor() {
  const editor = $('json-editor');
  editor.innerHTML = '';
  Object.entries(jsonConfig).forEach(([key, cfg]) => {
    const row = document.createElement('div');
    row.className = 'json-row';

    const keyEl = document.createElement('div');
    keyEl.className = 'json-key';
    keyEl.textContent = '"' + key + '"';
    if (key === 'startUrl') keyEl.style.color = 'var(--tc-warn)';
    row.appendChild(keyEl);

    const valEl = document.createElement('div');
    valEl.className = 'json-val';

    if (cfg.type === 'bool') {
      const wrap = document.createElement('div');
      wrap.className = 'json-bool';
      const btnT = document.createElement('button');
      btnT.className = 'json-bool-btn' + (cfg.value === true ? ' active-true' : '');
      btnT.textContent = 'true';
      const btnF = document.createElement('button');
      btnF.className = 'json-bool-btn' + (cfg.value === false ? ' active-false' : '');
      btnF.textContent = 'false';
      btnT.addEventListener('click', () => { cfg.value = true; renderJsonEditor(); });
      btnF.addEventListener('click', () => { cfg.value = false; renderJsonEditor(); });
      wrap.appendChild(btnT); wrap.appendChild(btnF);
      valEl.appendChild(wrap);

    } else if (cfg.type === 'text') {
      const inp = document.createElement('input');
      inp.className = 'json-text-in';
      inp.value = cfg.value;
      if (key === 'startUrl') { inp.placeholder = 'auto-set from HMI Server URL above'; inp.style.color = 'var(--tc-warn)'; }
      inp.addEventListener('input', function () {
        cfg.value = this.value;
        if (key === 'startUrl') {
          $('hmi-url').dataset.userEdited = '1';
          $('hmi-url').value = this.value;
        }
      });
      valEl.appendChild(inp);

    } else if (cfg.type === 'num') {
      const inp = document.createElement('input');
      inp.className = 'json-num-in'; inp.type = 'number'; inp.value = cfg.value;
      inp.addEventListener('input', function () { cfg.value = Number(this.value); });
      valEl.appendChild(inp);

    } else if (cfg.type === 'tags') {
      const tagWrap = document.createElement('div');
      tagWrap.className = 'json-tag-wrap';
      cfg.value.forEach((tag, idx) => {
        const t = document.createElement('span');
        t.className = 'json-tag';
        t.innerHTML = `${escapeHtml(tag)}<span class="json-tag-rm" data-idx="${idx}">×</span>`;
        t.querySelector('.json-tag-rm').addEventListener('click', () => { cfg.value.splice(idx, 1); renderJsonEditor(); });
        tagWrap.appendChild(t);
      });
      const addWrap = document.createElement('div');
      addWrap.className = 'tag-input-wrap';
      const inp = document.createElement('input'); inp.className = 'tag-input'; inp.placeholder = 'add flag...';
      const addBtn = document.createElement('button'); addBtn.className = 'tag-add-btn'; addBtn.textContent = '+ ADD';
      addBtn.addEventListener('click', () => {
        const val = inp.value.trim();
        if (val && !cfg.value.includes(val)) { cfg.value.push(val); renderJsonEditor(); }
      });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
      addWrap.appendChild(inp); addWrap.appendChild(addBtn);
      tagWrap.appendChild(addWrap);
      valEl.appendChild(tagWrap);
    }

    row.appendChild(valEl);
    const descEl = document.createElement('div'); descEl.className = 'json-desc'; descEl.textContent = cfg.desc;
    row.appendChild(descEl);
    editor.appendChild(row);
  });
}

//  VIEW TOGGLE (terminal ↔ script preview) 
document.querySelectorAll('#view-toggle .view-opt').forEach(o => o.addEventListener('click', () => {
  document.querySelectorAll('#view-toggle .view-opt').forEach(x => x.classList.remove('active'));
  o.classList.add('active');
  if (o.dataset.view === 'terminal') {
    $('terminal-output').style.display = ''; $('script-output').style.display = 'none';
  } else {
    $('terminal-output').style.display = 'none'; $('script-output').style.display = '';
  }
}));

function showTab(tab) {
  tabs.forEach(x => x.classList.remove('active'));
  Object.values(pages).forEach(p => $(p).classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tab}"]`).classList.add('active');
  $(pages[tab]).classList.add('active');
}

function setView(view) {
  document.querySelectorAll('#view-toggle .view-opt').forEach(x => {
    x.classList.toggle('active', x.dataset.view === view);
  });
  $('terminal-output').style.display = view === 'terminal' ? '' : 'none';
  $('script-output').style.display   = view === 'script'   ? '' : 'none';
}

// TINY ANSI PARSER (for streamed SSH output) 
// Handles \x1b[<n>[;<n>...]m color sequences and \r\n / \r. Non-color escape
// sequences (cursor moves, scroll regions, OSC titles) are stripped so apt's
// progress-bar control codes don't show up as literal text.
const ANSI_RE = /\x1b\[((?:\d+;?)*)m/g;

// Strip every CSI sequence that isn't "m" (the color/attr one), plus OSC
// title-set sequences. Keep `\x1b[...m` intact so the color parser below
// can consume them.
//
// IMPORTANT: node-ssh + pty sometimes strips the leading \x1b (ESC) byte from
// short escape sequences, so `\x1b7` arrives as just `7` and `\x1b[24;0f`
// arrives as `[24;0f`. We handle both ESC-prefixed and ESC-stripped variants.
function stripNonColorAnsi(str) {
  // OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \
  str = str.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

  //  Full CSI sequences (with ESC) that aren't SGR colors 
  // \x1b[ <params> <final-byte-not-m>
  str = str.replace(/\x1b\[[0-9;?]*[A-HJKLMPSTfhlnsu]/g, '');

  //  Bare CSI sequences (ESC stripped by pty) 
  // dpkg/apt progress rewrites: `[24;0f` (cursor-position), `[0;23r`
  // (scroll-region), `[1A` (cursor-up), `[J` / `[K` (erase), etc.
  // Match a literal `[` followed by digits/semicolons/question-mark, then
  // a non-SGR final byte. Leave `[...]m` alone — those are color codes
  // that the color parser needs, and also leave single `[` chars in text.
  str = str.replace(/\[[0-9;?]+[A-HJKLPSTfhlnsu]/g, '');
  str = str.replace(/\[[0-9;?]*J/g, '');  // erase-display
  str = str.replace(/\[[0-9;?]*K/g, '');  // erase-line

  //  ESC-prefixed single-char escapes (rare but possible) 
  str = str.replace(/\x1b[=>78]/g, '');

  //  Bare save/restore cursor codes (ESC stripped) 
  // dpkg's progress-bar redraw wraps every update in `7...8` (save → write
  // → restore). After ESC is stripped, these appear as bare `7` and `8`
  // characters hugging the CSI codes. We can only safely strip them when
  // adjacent to a CSI-like pattern or at the start of a progress line —
  // never globally, since real output contains digits.
  str = str.replace(/7(?=\[[0-9;])/g, '');  // `7[24;0f...` → `[24;0f...`
  str = str.replace(/([A-Za-z%\]])8(?=\s|$|[A-Z])/gm, '$1'); // `...]8` → `...]`
  // Also handle 8 at line-start/end alone
  str = str.replace(/^8(?=[A-Z\[])/gm, '');

  return str;
}

// Collapse repeated progress-style lines ("Reading package lists... N%",
// "N% [Working]", download percentage bars) so the terminal doesn't scroll
// madly — the last version of such a line replaces the previous one.
function collapseProgressLines(str) {
  const lines = str.split('\n');
  const out = [];
  const isProgress = (l) =>
    /^\s*\d+%\s/.test(l) ||
    /Reading package lists\.\.\.\s*\d+%/.test(l) ||
    /Building dependency tree\.\.\.\s*\d+%/.test(l) ||
    /Reading state information\.\.\.\s*\d+%/.test(l);
  for (const line of lines) {
    if (isProgress(line) && out.length && isProgress(out[out.length - 1])) {
      out[out.length - 1] = line; // replace previous progress line
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

function ansiToHtml(str) {
  // Normalize line endings. A lone \r (without \n) is apt's "rewrite the
  // current line" trick — turn it into a newline so each update is its own
  // line, then collapseProgressLines will dedupe the spam.
  str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  str = stripNonColorAnsi(str);
  str = collapseProgressLines(str);

  let out = '';
  let classes = [];
  let lastIdx = 0;
  let m;
  ANSI_RE.lastIndex = 0;
  while ((m = ANSI_RE.exec(str)) !== null) {
    out += wrapText(str.slice(lastIdx, m.index), classes);
    const codes = m[1].split(';').filter(Boolean).map(Number);
    if (codes.length === 0 || codes.includes(0)) { classes = []; }
    codes.forEach(code => {
      switch (code) {
        case 0: classes = []; break;
        case 1: if (!classes.includes('ansi-bold')) classes.push('ansi-bold'); break;
        case 30: case 31: setFg(classes, 'red'); break;
        case 32: setFg(classes, 'green'); break;
        case 33: setFg(classes, 'yellow'); break;
        case 34: setFg(classes, 'blue'); break;
        case 35: setFg(classes, 'magenta'); break;
        case 36: setFg(classes, 'cyan'); break;
        case 37: setFg(classes, 'white'); break;
        case 39: stripFg(classes); break;
      }
    });
    lastIdx = ANSI_RE.lastIndex;
  }
  out += wrapText(str.slice(lastIdx), classes);
  return out;
}
function setFg(classes, color) {
  stripFg(classes);
  classes.push('ansi-' + color);
}
function stripFg(classes) {
  for (let i = classes.length - 1; i >= 0; i--) {
    if (/^ansi-(red|green|yellow|blue|magenta|cyan|white)$/.test(classes[i])) classes.splice(i, 1);
  }
}
function wrapText(text, classes) {
  if (!text) return '';
  const esc = escapeHtml(text);
  if (classes.length === 0) return esc;
  return `<span class="${classes.join(' ')}">${esc}</span>`;
}

// TERMINAL PANE (The real pain is seeing mbappe miss 67 chances against Bayern Munich)
function appendTerminal(data) {
  terminalBuffer += data;
  const html = ansiToHtml(terminalBuffer);
  const pane = $('terminal-output');
  pane.innerHTML = html;
  pane.scrollTop = pane.scrollHeight;
}
function clearTerminal() {
  terminalBuffer = '';
  $('terminal-output').innerHTML = '<span style="color:var(--tc-muted)">// terminal idle</span>';
}

//  SCRIPT PREVIEW PANE
function showScriptPreview(script, name) {
  lastScript = script; lastFilename = name;
  const out = $('script-output'); const prog = $('prog');
  out.innerHTML = ''; prog.style.width = '0%'; prog.classList.remove('running');
  const lines = script.split('\n'); let i = 0;
  function addLine() {
    if (i >= lines.length) { prog.style.width = '100%'; return; }
    const l = lines[i++];
    const d = document.createElement('div');
    if (l.startsWith('#')) d.className = 'l-cmd';
    else if (/log_info/.test(l)) d.className = 'l-ok';
    else if (/log_warn|WARN/.test(l)) d.className = 'l-warn';
    else if (/log_error|ERROR/.test(l)) d.className = 'l-err';
    else if (/^sudo|sshpass|_ssh|_scp|ssh|scp/.test(l.trim())) d.className = 'l-info';
    else d.className = 'l-plain';
    d.textContent = l;
    out.appendChild(d);
    out.scrollTop = out.scrollHeight;
    prog.style.width = Math.round((i / lines.length) * 100) + '%';
    setTimeout(addLine, 3);
  }
  addLine();
  showTab('script');
  setView('script');
}

// RUN SETUP LIVE 
$('btn-run-setup').addEventListener('click', async () => {
  const ip = $('cx-ip').value.trim();
  const cxPass = $('cx-pass').value;
  const bkUser = $('bk-user').value.trim();
  const bkPass = $('bk-pass').value.trim();
  if (!ipOk(ip)) { toast('Enter a valid CX IP first', 'warn'); showTab('setup'); return; }
  if (!bkUser || !bkPass) { toast('MyBeckhoff username and password required', 'warn'); showTab('setup'); return; }

  const pkgs = [...selectedPkgs];
  if (!confirm(
    `Ready to run full setup on ${ip}?\n\n` +
    `Feed: ${selectedFeed}\n` +
    `Packages: tc31-xar-um, console-setup${pkgs.length ? ', ' + pkgs.join(', ') : ''}\n\n` +
    `This will take 10–15 min and will REBOOT the CX.`
  )) return;

  // Switch to terminal view
  showTab('script');
  setView('terminal');
  clearTerminal();
  $('prog').classList.add('running');
  $('prog').style.width = '8%';
  $('session-status').textContent = 'connecting…';
  $('cancel-btn').style.display = '';
  $('btn-run-setup').disabled = true;
  $('btn-run-tf1200').disabled = true;

  const res = await window.api.runSetup({
    host: ip, username: 'Administrator', password: cxPass, port: 22,
    beckhoffUser: bkUser, beckhoffPass: bkPass,
    feed: selectedFeed, packages: pkgs, pkgVersions,
    tf2000Pass: getTf2000Pass()
  });

  $('prog').classList.remove('running');
  $('prog').style.width = res.ok ? '100%' : '100%';
  $('cancel-btn').style.display = 'none';
  $('btn-run-setup').disabled = false;
  $('btn-run-tf1200').disabled = false;
  activeSessionId = null;

  if (res.ok) {
    toast(res.rebooted ? 'Setup complete — CX rebooting' : 'Setup finished', 'success');
  } else {
    toast('Setup failed: ' + (res.error || 'unknown'), 'error');
  }
});

// RUN TFCityArsenal00 CONFIG LIVE 
$('btn-run-tf1200').addEventListener('click', async () => {
  const ip = $('cx-ip2').value.trim() || $('cx-ip').value.trim();
  const cxPass = $('cx-pass2').value || $('cx-pass').value;
  const hmiUrl = $('hmi-url').value.trim() || jsonConfig.startUrl.value;
  if (!ipOk(ip)) { toast('Enter a valid CX IP first', 'warn'); showTab('tf1200'); return; }
  if (!hmiUrl) { toast('HMI Server URL required', 'warn'); showTab('tf1200'); return; }

  if (!confirm(`Apply TF1200 config to ${ip}?\n\nstartUrl: ${hmiUrl}\n\nThis writes /home/TF1200/.config/TF1200-UI-Client/config.json and REBOOTS the CX.`)) return;

  showTab('script');
  setView('terminal');
  clearTerminal();
  $('prog').classList.add('running');
  $('prog').style.width = '8%';
  $('session-status').textContent = 'connecting…';
  $('cancel-btn').style.display = '';
  $('btn-run-tf1200').disabled = true;
  $('btn-run-setup').disabled = true;

  // ensure jsonConfig.startUrl is set
  jsonConfig.startUrl.value = hmiUrl;

  const res = await window.api.runTF1200({
    host: ip, username: 'Administrator', password: cxPass, port: 22,
    hmiUrl, jsonConfig
  });

  $('prog').classList.remove('running');
  $('prog').style.width = '100%';
  $('cancel-btn').style.display = 'none';
  $('btn-run-tf1200').disabled = false;
  $('btn-run-setup').disabled = false;
  activeSessionId = null;

  if (res.ok) toast(res.rebooted ? 'Config applied — CX rebooting' : 'Config applied', 'success');
  else toast('Config apply failed: ' + (res.error || 'unknown'), 'error');
});

//  CANCEL 
$('cancel-btn').addEventListener('click', async () => {
  if (!activeSessionId) return;
  await window.api.cancelSession(activeSessionId);
  appendTerminal('\r\n\x1b[0;31m[LOCAL]\x1b[0m Cancelled by user.\r\n');
});

//  CLEAR 
$('clear-btn').addEventListener('click', () => {
  clearTerminal();
  $('prog').style.width = '0%';
  $('session-status').textContent = '';
});

//  STREAMING EVENTS FROM MAIN 
window.api.on('ssh:output', ({ sessionId, data }) => {
  activeSessionId = sessionId;
  appendTerminal(data);
});

window.api.on('ssh:status', ({ sessionId, status, message }) => {
  activeSessionId = sessionId;
  const s = $('session-status');
  const colorByStatus = {
    connecting: 'var(--tc-warn)',
    connected:  'var(--tc-accent2)',
    running:    'var(--tc-accent2)',
    complete:   'var(--tc-accent2)',
    failed:     'var(--tc-danger)',
    cancelled:  'var(--tc-danger)'
  };
  s.style.color = colorByStatus[status] || 'var(--tc-muted)';
  s.textContent = `[${status}] ${message || ''}`;
});

//  GENERATE SCRIPT (Copy/Download workflow, uses main-process builder) 
$('btn-gen-setup').addEventListener('click', async () => {
  const res = await window.api.buildSetupScript({
    cxIp: $('cx-ip').value.trim() || '<CX_IP>',
    cxPass: $('cx-pass').value || '1',
    beckhoffUser: $('bk-user').value.trim() || '<BECKHOFF_USER>',
    beckhoffPass: $('bk-pass').value.trim() || '<BECKHOFF_PASS>',
    feed: selectedFeed,
    packages: [...selectedPkgs],
    pkgVersions,
    tf2000Pass: getTf2000Pass()
  });
  if (res.ok) showScriptPreview(res.script, 'twincat_auto_setup.sh');
});

$('btn-gen-tf1200').addEventListener('click', async () => {
  const res = await window.api.buildTF1200Script({
    cxIp: $('cx-ip2').value.trim() || $('cx-ip').value.trim() || '<CX_IP>',
    cxPass: $('cx-pass2').value || $('cx-pass').value || '1',
    hmiUrl: $('hmi-url').value.trim() || jsonConfig.startUrl.value || '<HMI_URL>',
    jsonConfig
  });
  if (res.ok) showScriptPreview(res.script, 'tf1200-config.sh');
});

$('copy-btn').addEventListener('click', () => {
  if (!lastScript) { toast('Generate a script first', 'warn'); return; }
  navigator.clipboard.writeText(lastScript).then(() => {
    const b = $('copy-btn'); const orig = b.textContent;
    b.textContent = '[ COPIED! ]';
    setTimeout(() => b.textContent = orig, 1800);
  });
});

$('dl-btn').addEventListener('click', async () => {
  if (!lastScript) { toast('Generate a script first', 'warn'); return; }
  const res = await window.api.saveScript(lastScript, lastFilename);
  if (res.ok) toast('Saved to ' + res.path, 'success');
  else if (!res.cancelled) toast('Save failed', 'error');
});

// THEME TOGGLE 
(function initTheme() {
  const saved = localStorage.getItem('tc-theme') || 'light';
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    $('theme-toggle').textContent = '🌙 DARK';
  } else {
    document.documentElement.removeAttribute('data-theme');
    $('theme-toggle').textContent = '☀ LIGHT';
  }
})();

$('theme-toggle').addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    $('theme-toggle').textContent = '☀ LIGHT';
    localStorage.setItem('tc-theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    $('theme-toggle').textContent = '🌙 DARK';
    localStorage.setItem('tc-theme', 'dark');
  }
});

//  DISCLAIMER 
$('disclaimer-check').addEventListener('change', function () {
  $('disclaimer-btn').disabled = !this.checked;
});
$('disclaimer-btn').addEventListener('click', () => {
  if ($('disclaimer-check').checked) {
    $('disclaimer-overlay').style.display = 'none';
  }
});

// It's Chewsday INIT bruv
renderPkgGrid('');
renderVersionList();
renderJsonEditor();
syncCredentials();



// CX MANAGEMENT TAB — renderer logic
//  Helpers 
function getCxMgmtConn() {
  return {
    host: $('cx-ip3').value.trim() || $('cx-ip').value.trim(),
    password: $('cx-pass3').value || $('cx-pass').value || '1',
    port: 22
  };
}

// Sync IP/pass from tab 01 when switching to tab 03
document.querySelectorAll('.tab').forEach(t => {
  if (t.dataset.tab === 'cxmgmt') {
    t.addEventListener('click', () => {
      if (!$('cx-ip3').value && $('cx-ip').value) $('cx-ip3').value = $('cx-ip').value;
      if ($('cx-pass3').value === '1' && $('cx-pass').value) $('cx-pass3').value = $('cx-pass').value;
    });
  }
});

function goToTerminal(sessionId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="script"]').classList.add('active');
  $('page-script').classList.add('active');
  if (sessionId) $('session-status').textContent = `session: ${sessionId}`;
}

//  Network Configurator
toggleGroupInit('net-iface-toggle');
toggleGroupInit('net-mode-toggle');

function toggleGroupInit(id) {
  const grp = $(id);
  if (!grp) return;
  grp.querySelectorAll('.toggle-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      grp.querySelectorAll('.toggle-opt').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      if (id === 'net-mode-toggle') {
        $('net-static-fields').style.display = opt.dataset.val === 'static' ? 'block' : 'none';
      }
    });
  });
}

$('btn-apply-network').addEventListener('click', async () => {
  const conn = getCxMgmtConn();
  if (!conn.host) { showToast('Enter CX IP address', 'warn'); return; }
  const iface = document.querySelector('#net-iface-toggle .toggle-opt.active')?.dataset.val || 'end0';
  const mode  = document.querySelector('#net-mode-toggle .toggle-opt.active')?.dataset.val || 'dhcp';
  const opts = { ...conn, iface, mode };
  if (mode === 'static') {
    opts.ip      = $('net-ip').value.trim();
    opts.prefix  = $('net-prefix').value.trim() || '24';
    opts.gateway = $('net-gateway').value.trim();
    opts.dns     = $('net-dns').value.trim() || '8.8.8.8';
    if (!opts.ip) { showToast('Enter an IP address', 'warn'); return; }
  }
  $('btn-apply-network').disabled = true;
  $('btn-apply-network').textContent = '...';
  goToTerminal(null);
  let res;
  try {
    res = await Promise.race([
      window.api.applyNetwork(opts),
      new Promise(resolve => setTimeout(() => resolve({ ok: true, timedOut: true }), 12000))
    ]);
  } catch(e) {
    res = { ok: true }; // connection drop = success
  }
  $('btn-apply-network').disabled = false;
  $('btn-apply-network').textContent = '▶ APPLY NETWORK CONFIG';
  if (res.timedOut) showToast('Config applied — connection dropped (IP changed)', 'ok');
  else if (!res.ok) showToast('Network config failed — see terminal', 'error');
  else showToast('Network config applied', 'ok');
});

//  Firewall Manager 
toggleGroupInit('fw-enable-toggle');
toggleGroupInit('fw-custom-proto');

// Toggle fw port cards
document.querySelectorAll('#fw-ports-grid .pkg-card').forEach(card => {
  card.addEventListener('click', () => {
    const chk = card.querySelector('.fw-check');
    chk.classList.toggle('selected');
    card.classList.toggle('selected', chk.classList.contains('selected'));
  });
});

$('btn-fw-add-port').addEventListener('click', () => {
  const portVal = $('fw-custom-port').value.trim();
  if (!portVal || isNaN(parseInt(portVal))) { showToast('Enter a valid port number', 'warn'); return; }
  const proto = document.querySelector('#fw-custom-proto .toggle-opt.active')?.dataset.val || 'tcp';
  const grid = $('fw-ports-grid');
  if (grid.querySelector(`[data-port="${portVal}"][data-proto="${proto}"]`)) {
    showToast(`Port ${portVal}/${proto.toUpperCase()} already in list`, 'warn'); return;
  }
  const card = document.createElement('div');
  card.className = 'pkg-card';
  card.dataset.port = portVal;
  card.dataset.proto = proto;
  card.dataset.label = `Port ${portVal}`;
  card.innerHTML = `
    <div class="pkg-badge badge-opt">${proto.toUpperCase()}</div>
    <div class="pkg-name">
      <span class="pkg-check fw-check selected">
        <svg viewBox="0 0 8 8"><polyline points="1,4 3,6 7,2" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
      </span>Port ${portVal}
    </div>
    <div class="pkg-desc">Custom port ${portVal}/${proto}</div>`;
  card.addEventListener('click', () => {
    card.querySelector('.fw-check').classList.toggle('selected');
  });
  grid.appendChild(card);
  $('fw-custom-port').value = '';
  showToast(`Port ${portVal}/${proto.toUpperCase()} added`, 'ok');
});

$('btn-apply-firewall').addEventListener('click', async () => {
  const conn = getCxMgmtConn();
  if (!conn.host) { showToast('Enter CX IP address', 'warn'); return; }
  const enable = document.querySelector('#fw-enable-toggle .toggle-opt.active')?.dataset.val === 'true';
  const ports = [];
  document.querySelectorAll('#fw-ports-grid .pkg-card').forEach(card => {
    ports.push({
      port: card.dataset.port,
      proto: card.dataset.proto,
      label: card.dataset.label,
      open: card.querySelector('.fw-check')?.classList.contains('selected') || false
    });
  });
  $('btn-apply-firewall').disabled = true;
  $('btn-apply-firewall').textContent = '...';
  goToTerminal(null);
  const res = await window.api.applyFirewall({ ...conn, enable, ports });
  $('btn-apply-firewall').disabled = false;
  $('btn-apply-firewall').textContent = '▶ APPLY FIREWALL CONFIG';
  if (!res.ok) showToast('Firewall config failed — see terminal', 'error');
});

//  TF2000 confirm field on tab 01 
function checkTf2000Match() {
  const a = $('tf2000-pass')?.value || '';
  const b = $('tf2000-pass-confirm')?.value || '';
  const msg = $('tf2000-pass-match');
  if (!msg) return true;
  if (!a && !b) { msg.style.display = 'none'; return true; }
  msg.style.display = 'block';
  if (a === b) {
    msg.textContent = '✓ Passwords match';
    msg.className = 'pass-match-ok';
    msg.style.fontFamily = 'var(--tc-mono)';
    msg.style.fontSize = '10px';
    return true;
  } else {
    msg.textContent = '✗ Passwords do not match';
    msg.className = 'pass-match-err';
    msg.style.fontFamily = 'var(--tc-mono)';
    msg.style.fontSize = '10px';
    return false;
  }
}
$('tf2000-pass')?.addEventListener('input', checkTf2000Match);
$('tf2000-pass-confirm')?.addEventListener('input', checkTf2000Match);

// Patch btn-run-setup to check tf2000 match before running
const _origSetupClick = $('btn-run-setup').onclick;
$('btn-run-setup').addEventListener('click', (e) => {
  if ($('tf2000-pass-confirm') && $('tf2000-pass')?.value && !checkTf2000Match()) {
    showToast('TF2000 passwords do not match', 'warn');
    e.stopImmediatePropagation();
  }
}, true);


//  Package Update Checker 
//  Installed Packages + Selective Updates 
let _installedPkgs = []; // [{name, version, upgradable, newVer}]

function renderInstalledTable() {
  const rows = $('installed-rows');
  const hasUpdates = _installedPkgs.some(p => p.upgradable);
  rows.innerHTML = _installedPkgs.map(p => `
    <div class="upd-row" style="display:grid;grid-template-columns:1fr auto auto 36px;gap:.5rem;padding:.35rem .6rem;border-bottom:1px solid var(--tc-border);align-items:center">
      <span class="upd-name">${p.name}</span>
      <span class="upd-old">${p.version}</span>
      <span class="${p.upgradable ? 'upd-new' : ''}" style="${p.upgradable ? '' : 'color:var(--tc-muted)'}">${p.upgradable ? '→ ' + p.newVer : '✓ up to date'}</span>
      <span>${p.upgradable ? `<input type="checkbox" class="upd-chk" data-pkg="${p.name}" data-ver="${p.newVer}" checked style="cursor:pointer">` : ''}</span>
    </div>`).join('');
  $('updates-select-all-row').style.display = hasUpdates ? 'block' : 'none';
  $('btn-upgrade-selected').style.display = hasUpdates ? '' : 'none';
  $('btn-upgrade-selected').disabled = !hasUpdates;
  // Select-all checkbox
  const chkAll = $('chk-select-all-updates');
  if (chkAll) {
    chkAll.checked = true;
    chkAll.addEventListener('change', function() {
      rows.querySelectorAll('.upd-chk').forEach(c => c.checked = this.checked);
    });
  }
}

$('btn-fetch-installed').addEventListener('click', async () => {
  const conn = getCxMgmtConn();
  if (!conn.host) { showToast('Enter CX IP address', 'warn'); return; }
  $('btn-fetch-installed').disabled = true;
  $('btn-fetch-installed').textContent = '⟳ FETCHING...';
  const res = await window.api.fetchUpdates(conn);
  $('btn-fetch-installed').disabled = false;
  $('btn-fetch-installed').textContent = '⟳ FETCH INSTALLED';
  if (!res.ok) { showToast('Failed to fetch packages — check connection', 'error'); return; }
  _installedPkgs = res.packages;
  $('installed-result').style.display = 'block';
  $('installed-count').textContent = `${res.packages.length} TwinCAT package${res.packages.length !== 1 ? 's' : ''} installed`;
  $('btn-fetch-updates').style.display = '';
  renderInstalledTable();
});

$('btn-fetch-updates').addEventListener('click', async () => {
  const conn = getCxMgmtConn();
  if (!conn.host) { showToast('Enter CX IP address', 'warn'); return; }
  $('btn-fetch-updates').disabled = true;
  $('btn-fetch-updates').textContent = '⟳ CHECKING...';
  const res = await window.api.fetchUpdates({ ...conn, checkUpdates: true });
  $('btn-fetch-updates').disabled = false;
  $('btn-fetch-updates').textContent = '⟳ CHECK FOR UPDATES';
  if (!res.ok) { showToast('Failed to check updates', 'error'); return; }
  // Merge update info into installed list
  const updateMap = {};
  res.updates.forEach(u => { updateMap[u.name] = u.newVer; });
  _installedPkgs = _installedPkgs.map(p => ({
    ...p,
    upgradable: !!updateMap[p.name],
    newVer: updateMap[p.name] || p.version
  }));
  const count = res.updates.length;
  $('installed-count').textContent = `${_installedPkgs.length} installed · ${count} update${count !== 1 ? 's' : ''} available`;
  renderInstalledTable();
  if (count === 0) showToast('All packages up to date', 'ok');
});

$('btn-upgrade-selected').addEventListener('click', async () => {
  const conn = getCxMgmtConn();
  if (!conn.host) { showToast('Enter CX IP address', 'warn'); return; }
  const selected = [...document.querySelectorAll('.upd-chk:checked')].map(c => c.dataset.pkg);
  if (!selected.length) { showToast('No packages selected', 'warn'); return; }
  $('btn-upgrade-selected').disabled = true;
  goToTerminal(null);
  const res = await window.api.runUpgrade({ ...conn, packages: selected });
  $('btn-upgrade-selected').disabled = false;
  if (!res.ok) showToast('Upgrade failed — see terminal', 'error');
});


// MyBeckhoff Credential Validator - i am stupid 
$('btn-validate-creds').addEventListener('click', async () => {
  const ip = $('cx-ip').value.trim();
  const cxPass = $('cx-pass').value;
  const bkUser = $('bk-user').value.trim();
  const bkPass = $('bk-pass').value.trim();
  const status = $('creds-status');
  if (!ip) { status.textContent = '⚠ Enter CX IP first'; status.style.color = 'var(--tc-warn)'; return; }
  if (!bkUser || !bkPass) { status.textContent = '⚠ Enter MyBeckhoff credentials first'; status.style.color = 'var(--tc-warn)'; return; }
  status.textContent = 'Validating...';
  status.style.color = 'var(--tc-muted)';
  $('btn-validate-creds').disabled = true;
  const res = await window.api.validateCreds({ host: ip, password: cxPass, port: 22, beckhoffUser: bkUser, beckhoffPass: bkPass });
  $('btn-validate-creds').disabled = false;
  if (res.ok) {
    status.textContent = '✓ Credentials valid';
    status.style.color = 'var(--tc-warn)'; // green (warn = Beckhoff green in light, yellow in dark)
    status.className = 'pass-match-ok';
  } else {
    status.textContent = '✗ ' + (res.error || 'Validation failed');
    status.style.color = 'var(--tc-danger)';
    status.className = 'pass-match-err';
  }
});
// Why are you here? 