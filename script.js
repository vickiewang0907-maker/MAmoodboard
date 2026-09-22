
(function(){
  "use strict";

  var STORAGE_KEY = "inspo-board-v2";
  var WELCOME_SEEN_KEY = "inspo-welcome-seen";
  // Shared with both the "?" help panel and the first-run welcome dialog.
  var HOWTO_ITEMS = [
    'Add images, paste, or double-click empty space for a note',
    'Drag a circle to move it, its corner to resize, or its edge dot onto another circle to connect them',
    'Select an image, then "Crop" to trim it; select a note, then "Aa" to fill the circle with text',
    'Shift-click, shift-drag, or double-click and drag empty space, to select several circles at once',
    'Delete removes a selection, Ctrl+C/V copies, Ctrl+Z undoes, click a string to remove it',
    'Click "Mood Board" for boards and the accent dot for color',
    'Saved to this browser only - it won\'t follow you elsewhere'
  ];
  var IMG_W = 190, IMG_MIN_H = 120, IMG_MAX_H = 260;

  var state = null;
  var pan = {x:0,y:0}, zoom = 1;
  var selectedNodeId = null;
  var selectedIds = [];
  var cropNodeId = null;
  var cropRect = null;
  var currentBoardId = null;
  var boardPanelEl = null;
  var nodeEls = {};
  var edgeEls = {};

  var appEl = document.querySelector('.app');
  var viewport = document.getElementById('viewport');
  var world = document.getElementById('world');
  var svg = document.getElementById('edgesSvg');
  var edgeGroup = document.getElementById('edgeGroup');
  var nodesLayer = document.getElementById('nodesLayer');
  var toastEl = document.getElementById('toast');
  var zoomResetBtn = document.getElementById('zoomReset');
  // The percentage lives in its own span so updating it can't ever wipe out
  // the hand-drawn SVG frame buildButtonFrame() injects as the button's
  // other child (a plain zoomResetBtn.textContent write would nuke both).
  var zoomResetLabel = zoomResetBtn && zoomResetBtn.querySelector('.zoom-pct');

  // ---------------- persistence ----------------
  function defaultState(){
    return {
      nodes:[
        {id:'n1', type:'text', x:60, y:70, text:'STYLE WITH THE INTENT TO...\n\nDrop images here, or press "Add Images"'},
        {id:'n2', type:'text', x:310, y:160, text:'Hover a circle, then drag the little dot that appears onto another circle to draw a line'},
        {id:'n3', type:'text', x:130, y:330, text:'Press "Crop" under a photo to trim it down to just the part you want'}
      ],
      edges:[
        {id:'e1', a:'n1', b:'n2'},
        {id:'e2', a:'n2', b:'n3'}
      ]
    };
  }

  // ---------------- multi-board (tabs) ----------------
  var BOARDS_INDEX_KEY = 'inspo-boards-index-v1';
  function boardDataKey(id){ return 'inspo-board-data-' + id; }
  function loadBoardsIndex(){
    try{
      var raw = localStorage.getItem(BOARDS_INDEX_KEY);
      if(raw){
        var parsed = JSON.parse(raw);
        if(parsed && Array.isArray(parsed.boards) && parsed.boards.length) return parsed;
      }
    }catch(e){}
    return null;
  }
  function saveBoardsIndex(idx){
    try{ localStorage.setItem(BOARDS_INDEX_KEY, JSON.stringify(idx)); }catch(e){}
  }
  function ensureBoardsIndex(){
    var idx = loadBoardsIndex();
    if(idx) return idx;
    // First run on this device, or migrating from the older single-board
    // storage — fold whatever was there into a "Board 1".
    var id = uid();
    var legacyRaw = null;
    try{ legacyRaw = localStorage.getItem(STORAGE_KEY); }catch(e){}
    idx = { boards:[{id:id, name:'Board 1'}], currentId:id };
    try{
      localStorage.setItem(boardDataKey(id), legacyRaw || JSON.stringify(defaultState()));
    }catch(e){}
    saveBoardsIndex(idx);
    return idx;
  }
  // A board's theme has four independent knobs: crayon (the hand-drawn
  // line color — also drives the accent highlight, so there's no separate
  // "base" control), paper (canvas background), card (the fill inside
  // circles and buttons), and ink (text color). Older saved boards only
  // have a single `accent` field (pre-theme) or an `accent`+`crayon`+
  // `paper` triple (an earlier theme shape) — both are read as just a
  // custom line color, for backward compatibility.
  function currentTheme(){
    if(state.theme) return state.theme;
    if(state.accent) return { crayon: state.accent };
    return {};
  }
  // Text that sits directly on a crayon-filled surface (the Yes button, a
  // hovered toolbar button, the toast) is hardcoded white in the CSS, which
  // only reads well against a dark-ish line color. Once the line color is
  // user-customizable it can be pale, so pick black-or-white text here,
  // by relative luminance, and hand it to the CSS as --on-crayon.
  function relLuminance(hex){
    hex = (hex || '').replace('#','');
    if(hex.length === 3) hex = hex.split('').map(function(c){ return c+c; }).join('');
    if(hex.length !== 6) return 0.2; // unknown -> assume dark, keep white text
    var r = parseInt(hex.slice(0,2),16) / 255;
    var g = parseInt(hex.slice(2,4),16) / 255;
    var b = parseInt(hex.slice(4,6),16) / 255;
    function lin(c){ return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
    return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
  }
  function pickOnCrayon(hex){ return relLuminance(hex) > 0.5 ? '#141311' : '#ffffff'; }
  function applyTheme(){
    var th = currentTheme();
    var crayon = th.crayon || th.accent;
    if(crayon){
      document.documentElement.style.setProperty('--crayon', crayon);
      document.documentElement.style.setProperty('--accent', crayon);
    } else {
      document.documentElement.style.removeProperty('--crayon');
      document.documentElement.style.removeProperty('--accent');
    }
    if(th.paper) document.documentElement.style.setProperty('--bg', th.paper);
    else document.documentElement.style.removeProperty('--bg');
    if(th.card) document.documentElement.style.setProperty('--card', th.card);
    else document.documentElement.style.removeProperty('--card');
    if(th.ink) document.documentElement.style.setProperty('--ink', th.ink);
    else document.documentElement.style.removeProperty('--ink');
    var resolvedCrayon = toHex(getComputedStyle(document.documentElement).getPropertyValue('--crayon')) || crayon || '#e2572b';
    document.documentElement.style.setProperty('--on-crayon', pickOnCrayon(resolvedCrayon));
    var resolvedBg = toHex(getComputedStyle(document.documentElement).getPropertyValue('--bg')) || th.paper || '#ffffff';
    var bgIsLight = relLuminance(resolvedBg) > 0.5;
    document.documentElement.style.setProperty('--paper-invert-bg', bgIsLight ? '#141311' : '#ffffff');
    document.documentElement.style.setProperty('--paper-invert-text', bgIsLight ? '#ffffff' : '#141311');
  }
  function resetViewForBoardSwitch(){
    selectedIds = []; selectedNodeId = null; cropNodeId = null; cropRect = null;
    applyTheme();
    pan = {x:0,y:0}; zoom = 1;
    applyTransform();
    render();
    refreshAccentDot();
  }
  function switchToBoard(id){
    if(id === currentBoardId) return;
    flushSave();
    var idx = loadBoardsIndex() || ensureBoardsIndex();
    idx.currentId = id;
    saveBoardsIndex(idx);
    currentBoardId = id;
    state = loadState();
    resetViewForBoardSwitch();
  }
  function createNewBoard(){
    flushSave();
    var idx = loadBoardsIndex() || ensureBoardsIndex();
    var id = uid();
    idx.boards.push({id:id, name:'Board ' + (idx.boards.length + 1)});
    idx.currentId = id;
    saveBoardsIndex(idx);
    try{ localStorage.setItem(boardDataKey(id), JSON.stringify(defaultState())); }catch(e){}
    currentBoardId = id;
    state = loadState();
    resetViewForBoardSwitch();
    return id;
  }
  function deleteBoard(id){
    var idx = loadBoardsIndex() || ensureBoardsIndex();
    if(idx.boards.length <= 1) return;
    idx.boards = idx.boards.filter(function(b){ return b.id !== id; });
    try{ localStorage.removeItem(boardDataKey(id)); }catch(e){}
    if(idx.currentId === id || currentBoardId === id){
      idx.currentId = idx.boards[0].id;
      saveBoardsIndex(idx);
      currentBoardId = idx.currentId;
      state = loadState();
      resetViewForBoardSwitch();
    } else {
      saveBoardsIndex(idx);
    }
  }

  function loadState(){
    try{
      var raw = localStorage.getItem(boardDataKey(currentBoardId));
      if(raw){
        var parsed = JSON.parse(raw);
        if(parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) return parsed;
      }
    }catch(e){}
    return defaultState();
  }

  var saveTimer = null;
  function saveState(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){
      try{ localStorage.setItem(boardDataKey(currentBoardId), JSON.stringify(state)); }
      catch(e){ showToast('Storage is full — try removing a few images'); }
    }, 250);
  }
  function flushSave(){
    clearTimeout(saveTimer);
    try{ localStorage.setItem(boardDataKey(currentBoardId), JSON.stringify(state)); }catch(e){}
  }

  function showToast(msg){
    toastEl.textContent = msg;
    buildButtonFrame(toastEl);
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function(){ toastEl.classList.remove('show'); }, 2600);
  }

  function uid(){ return 'id' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

  // ---------------- modal dialogs (replace window.confirm/prompt, which
  // don't reliably surface inside a sandboxed artifact iframe) ----------------
  function closeModal(overlay){
    if(overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener('keydown', overlay._escHandler, true);
  }
  function openModal(bodyChildren, focusEl, extraBoxClass){
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var box = document.createElement('div');
    box.className = 'modal-box' + (extraBoxClass ? ' ' + extraBoxClass : '');
    bodyChildren.forEach(function(c){ box.appendChild(c); });
    overlay.appendChild(box);
    overlay.addEventListener('pointerdown', function(e){ if(e.target === overlay) closeModal(overlay); });
    box.addEventListener('pointerdown', function(e){ e.stopPropagation(); });
    document.body.appendChild(overlay);
    if(focusEl){ setTimeout(function(){ focusEl.focus(); if(focusEl.select) focusEl.select(); }, 30); }
    return overlay;
  }
  function showConfirmDialog(message, onYes){
    var msg = document.createElement('p');
    msg.className = 'modal-msg';
    msg.textContent = message;
    var row = document.createElement('div');
    row.className = 'modal-row';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn'; cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
    var okBtn = document.createElement('button');
    okBtn.className = 'btn primary'; okBtn.type = 'button'; okBtn.textContent = 'Yes';
    row.appendChild(cancelBtn); row.appendChild(okBtn);
    var overlay = openModal([msg, row], okBtn, 'modal-confirm');
    overlay._escHandler = function(e){ if(e.key === 'Escape') closeModal(overlay); };
    document.addEventListener('keydown', overlay._escHandler, true);
    cancelBtn.addEventListener('click', function(){ closeModal(overlay); });
    okBtn.addEventListener('click', function(){ closeModal(overlay); onYes(); });
    buildButtonFrame(cancelBtn); buildButtonFrame(okBtn);
  }
  function showPromptDialog(message, defaultValue, onSubmit){
    var msg = document.createElement('p');
    msg.className = 'modal-msg';
    msg.textContent = message;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'modal-input';
    input.value = defaultValue || '';
    input.maxLength = 40;
    var row = document.createElement('div');
    row.className = 'modal-row';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn'; cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
    var okBtn = document.createElement('button');
    okBtn.className = 'btn primary'; okBtn.type = 'button'; okBtn.textContent = 'Save';
    row.appendChild(cancelBtn); row.appendChild(okBtn);
    var overlay = openModal([msg, input, row], input);
    function submit(){
      var v = input.value.trim();
      closeModal(overlay);
      if(v) onSubmit(v);
    }
    overlay._escHandler = function(e){ if(e.key === 'Escape') closeModal(overlay); };
    document.addEventListener('keydown', overlay._escHandler, true);
    input.addEventListener('keydown', function(e){
      e.stopPropagation();
      if(e.key === 'Enter'){ e.preventDefault(); submit(); }
      else if(e.key === 'Escape'){ e.preventDefault(); closeModal(overlay); }
    });
    cancelBtn.addEventListener('click', function(){ closeModal(overlay); });
    okBtn.addEventListener('click', submit);
    buildButtonFrame(cancelBtn); buildButtonFrame(okBtn);
  }
  function markWelcomeSeen(){
    try{ localStorage.setItem(WELCOME_SEEN_KEY, '1'); }catch(e){}
  }
  function showWelcomeDialog(){
    var msg = document.createElement('p');
    msg.className = 'modal-msg';
    msg.textContent = "Welcome! I made this app for me to think easier, hope it also helps u well:)";
    var ul = document.createElement('ul');
    ul.className = 'welcome-list';
    ul.innerHTML = HOWTO_ITEMS.map(function(t){ return '<li>'+t+'</li>'; }).join('');
    var row = document.createElement('div');
    row.className = 'modal-row';
    var okBtn = document.createElement('button');
    okBtn.className = 'btn primary'; okBtn.type = 'button'; okBtn.textContent = 'OK';
    row.appendChild(okBtn);
    var overlay = openModal([msg, ul, row], okBtn, 'modal-box-wide');
    function dismiss(){ closeModal(overlay); markWelcomeSeen(); }
    overlay._escHandler = function(e){ if(e.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', overlay._escHandler, true);
    // A click on the dimmed background also closes it (openModal's own
    // listener); treat that the same as OK so it doesn't come back.
    overlay.addEventListener('pointerdown', function(e){ if(e.target === overlay) markWelcomeSeen(); });
    okBtn.addEventListener('click', dismiss);
    buildButtonFrame(okBtn);
  }
  function showWelcomeIfNeeded(){
    var seen;
    try{ seen = localStorage.getItem(WELCOME_SEEN_KEY); }catch(e){}
    if(seen) return;
    showWelcomeDialog();
  }

  // ---------------- undo ----------------
  var undoStack = [];
  function snapshotState(){
    try{ return JSON.stringify({nodes:state.nodes, edges:state.edges}); }
    catch(e){ return null; }
  }
  function pushUndo(){
    var s = snapshotState();
    if(s == null) return;
    undoStack.push(s);
    if(undoStack.length > 40) undoStack.shift();
  }
  function pushUndoSnapshot(snap){
    if(snap == null) return;
    undoStack.push(snap);
    if(undoStack.length > 40) undoStack.shift();
  }
  function undo(){
    if(!undoStack.length){ showToast('Nothing to undo'); return; }
    var snap = undoStack.pop();
    try{
      var parsed = JSON.parse(snap);
      state.nodes = parsed.nodes || [];
      state.edges = parsed.edges || [];
    }catch(e){ return; }
    selectedIds = []; selectedNodeId = null;
    saveState(); render();
  }

  // ---------------- clipboard (internal, node copy/paste) ----------------
  var clipboardNodes = null;
  var pasteOffset = 0;

  // ---------------- multi-select ----------------
  function isSelected(id){ return selectedIds.indexOf(id) !== -1; }
  function setSelection(ids){
    selectedIds = ids.slice();
    selectedNodeId = selectedIds.length ? selectedIds[selectedIds.length-1] : null;
  }
  function toggleSelect(id){
    var idx = selectedIds.indexOf(id);
    if(idx === -1) selectedIds.push(id); else selectedIds.splice(idx,1);
    selectedNodeId = selectedIds.length ? selectedIds[selectedIds.length-1] : null;
  }
  function refreshSelectedClasses(){
    document.querySelectorAll('.node').forEach(function(x){ x.classList.toggle('selected', isSelected(x.dataset.id)); });
  }
  function deleteSelected(){
    if(!selectedIds.length) return;
    pushUndo();
    var idsSet = {};
    selectedIds.forEach(function(id){ idsSet[id] = true; });
    state.nodes = state.nodes.filter(function(n){ return !idsSet[n.id]; });
    state.edges = state.edges.filter(function(e){ return !idsSet[e.a] && !idsSet[e.b]; });
    if(cropNodeId && idsSet[cropNodeId]){ cropNodeId = null; cropRect = null; }
    selectedIds = []; selectedNodeId = null;
    saveState(); render();
  }

  // ---------------- transform helpers ----------------
  function applyTransform(){
    world.style.transform = 'translate('+pan.x+'px,'+pan.y+'px) scale('+zoom+')';
    if(zoomResetLabel) zoomResetLabel.textContent = Math.round(zoom*100);
  }
  function clampZoom(z){ return Math.min(2.5, Math.max(0.3, z)); }
  function screenToWorld(clientX, clientY){
    var r = viewport.getBoundingClientRect();
    return { x:(clientX - r.left - pan.x)/zoom, y:(clientY - r.top - pan.y)/zoom };
  }
  function worldToScreen(x,y){
    var r = viewport.getBoundingClientRect();
    return { x: r.left + pan.x + x*zoom, y: r.top + pan.y + y*zoom };
  }

  // ---------------- hand-drawn circle ----------------
  function ensureWobble(n){
    if(!n.wobble || n.wobble.length < 12){
      n.wobble = [];
      for(var i=0;i<12;i++) n.wobble.push(Math.random()*2-1);
    }
    return n.wobble;
  }
  function blobPath(cx,cy,rx,ry,wobble){
    var n = wobble.length;
    var pts = [];
    for(var i=0;i<n;i++){
      var ang = (i/n)*Math.PI*2;
      var wob = 1 + wobble[i]*0.1;
      pts.push([cx+Math.cos(ang)*rx*wob, cy+Math.sin(ang)*ry*wob]);
    }
    function mid(p0,p1){ return [(p0[0]+p1[0])/2,(p0[1]+p1[1])/2]; }
    var start = mid(pts[n-1], pts[0]);
    var d = 'M '+start[0]+' '+start[1]+' ';
    for(var i=0;i<n;i++){
      var cur = pts[i], nxt = pts[(i+1)%n];
      var m = mid(cur,nxt);
      d += 'Q '+cur[0]+' '+cur[1]+' '+m[0]+' '+m[1]+' ';
    }
    d += 'Z';
    return d;
  }
  // Interpolates the same per-sample wobble factor blobPath() uses, so a
  // point can be placed exactly on a node's own hand-drawn boundary at any
  // angle — not just at the plain, un-wobbled ellipse.
  function wobbleFactorAt(wobble, angle){
    var n = wobble.length;
    var norm = angle % (Math.PI*2);
    if(norm < 0) norm += Math.PI*2;
    var f = norm/(Math.PI*2)*n;
    var i0 = Math.floor(f) % n;
    var i1 = (i0+1) % n;
    var frac = f - Math.floor(f);
    var w0 = 1 + wobble[i0]*0.1;
    var w1 = 1 + wobble[i1]*0.1;
    return w0 + (w1-w0)*frac;
  }
  function pointOnWobblyEllipse(geom, wobble, angle){
    var wob = wobbleFactorAt(wobble, angle);
    return { x: geom.cx + Math.cos(angle)*geom.rx*wob, y: geom.cy + Math.sin(angle)*geom.ry*wob };
  }
  var CIRCLE_PAD = 24;
  var IMAGE_CIRCLE_EXTRA = 56;
  function circleGeom(contentW, contentH, isImage){
    var extra = isImage ? IMAGE_CIRCLE_EXTRA : CIRCLE_PAD*0.55;
    return {
      pad: isImage ? IMAGE_CIRCLE_EXTRA : CIRCLE_PAD,
      cx: contentW/2, cy: contentH/2,
      rx: contentW/2 + extra,
      ry: contentH/2 + extra
    };
  }
  function computeContentSize(n){
    if(n.type === 'image'){
      return { w: n.w||IMG_W, h: n.h||160 };
    }
    var text = n.text || '';
    var rawLines = text.split('\n');
    var maxLineLen = 0;
    rawLines.forEach(function(line){ if(line.length > maxLineLen) maxLineLen = line.length; });
    var minW = 140, maxW = 320;
    var w = Math.min(maxW, Math.max(minW, 70 + maxLineLen*11));
    var charsPerLine = Math.max(8, Math.floor((w-50)/11));
    var lineCount = Math.max(1, rawLines.reduce(function(sum,line){
      return sum + Math.max(1, Math.ceil(line.length/charsPerLine));
    }, 0));
    var h = Math.max(120, 56 + lineCount*30);
    return { w:w, h:h };
  }
  // Binary-searches the largest font size that still lets `text` fit inside
  // a box of `w` x `h` (matching .editable's own padding/line-height), for
  // the "fill the circle" text-size toggle.
  function fitFontSize(text, w, h){
    var probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.style.boxSizing = 'border-box';
    probe.style.width = w + 'px';
    probe.style.padding = '18px 20px';
    probe.style.fontFamily = 'var(--ui-font)';
    probe.style.lineHeight = '1.35';
    probe.style.whiteSpace = 'pre-wrap';
    probe.style.wordBreak = 'break-word';
    probe.textContent = text || ' ';
    document.body.appendChild(probe);
    var lo = 14, hi = 220, best = 21;
    while(lo <= hi){
      var mid = (lo + hi) >> 1;
      probe.style.fontSize = mid + 'px';
      if(probe.scrollHeight <= h && probe.scrollWidth <= w){ best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    document.body.removeChild(probe);
    return best;
  }
  function buildCircleFrame(n, contentW, contentH){
    var wobble = ensureWobble(n);
    var g = circleGeom(contentW, contentH, n.type === 'image');
    var w = contentW + g.pad*2, h = contentH + g.pad*2;
    var svgEl = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svgEl.setAttribute('class','circle-frame');
    svgEl.setAttribute('width', w);
    svgEl.setAttribute('height', h);
    svgEl.setAttribute('viewBox', '0 0 '+w+' '+h);
    svgEl.style.left = (-g.pad) + 'px';
    svgEl.style.top = (-g.pad) + 'px';
    var d = blobPath(w/2, h/2, g.rx, g.ry, wobble);

    var path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('class','circle-visible');
    path.setAttribute('d', d);
    svgEl.appendChild(path);

    return svgEl;
  }

  // ---------------- render ----------------
  function render(){
    nodesLayer.innerHTML = '';
    nodeEls = {};
    state.nodes.forEach(function(n){
      var el = buildNodeEl(n);
      nodesLayer.appendChild(el);
      nodeEls[n.id] = el;
    });
    renderEdges();
    refreshButtonFrames();
  }

  // ---------------- hand-drawn button frames ----------------
  var btnSeeds = new WeakMap();
  function seedFor(el){
    var s = btnSeeds.get(el);
    if(!s){ s = []; for(var i=0;i<10;i++) s.push(Math.random()*2-1); btnSeeds.set(el, s); }
    return s;
  }
  function buildButtonFrame(el){
    var old = el.querySelector('svg.crayon-frame');
    if(old) old.remove();
    var w = el.offsetWidth, h = el.offsetHeight;
    if(!w || !h) return;
    var pad = 5;
    var svgW = w + pad*2, svgH = h + pad*2;
    var seed = seedFor(el);
    var svgEl = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svgEl.setAttribute('class','crayon-frame');
    svgEl.setAttribute('width', svgW);
    svgEl.setAttribute('height', svgH);
    svgEl.setAttribute('viewBox', '0 0 '+svgW+' '+svgH);
    svgEl.style.left = (-pad) + 'px';
    svgEl.style.top = (-pad) + 'px';
    var path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d', blobPath(svgW/2, svgH/2, w/2 + pad*0.4, h/2 + pad*0.4, seed));
    svgEl.appendChild(path);
    el.appendChild(svgEl);
  }
  function refreshButtonFrames(){
    document.querySelectorAll('.btn, .zoomctl button').forEach(buildButtonFrame);
  }

  function buildNodeEl(n){
    var el = document.createElement('div');
    el.className = 'node ' + (n.type === 'image' ? 'node-img' : 'node-text');
    if(isSelected(n.id)) el.className += ' selected';
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.transformOrigin = '0 0';
    el.style.transform = 'scale(' + (n.scale||1) + ')';
    el.dataset.id = n.id;

    var frame = document.createElement('div');
    frame.className = 'frame';
    el.appendChild(frame);

    var size = computeContentSize(n);
    var contentW = size.w, contentH = size.h;
    var geom = circleGeom(contentW, contentH, n.type === 'image');
    var wobble = ensureWobble(n);

    // Angles (screen convention: 0=right, +90°=down) for the buttons that
    // ring the circle, so each sits exactly on the node's OWN hand-drawn
    // wobbly line rather than an invisible ideal ellipse.
    var ANGLE_TOP_RIGHT = -Math.PI/4;
    var ANGLE_TOP_LEFT = -3*Math.PI/4;
    var ANGLE_BOTTOM_RIGHT = Math.PI/4;
    var ANGLE_TOP = -Math.PI/2;
    // Angles where a fixed button (delete/resize, and Aa on notes) sits, so
    // the pointer-following connector handle below can be steered clear of
    // them — it used to slide right underneath whichever one was closest.
    var keepoutAngles = [ANGLE_TOP_RIGHT, ANGLE_BOTTOM_RIGHT];
    if(n.type !== 'image') keepoutAngles.push(ANGLE_TOP_LEFT);

    var delEl = document.createElement('button');
    delEl.className = 'del';
    delEl.type = 'button';
    delEl.innerHTML = '×';
    delEl.title = 'Delete';
    var delPt = pointOnWobblyEllipse(geom, wobble, ANGLE_TOP_RIGHT);
    delEl.style.left = delPt.x + 'px';
    delEl.style.top = delPt.y + 'px';
    el.appendChild(delEl);

    var resizeEl = document.createElement('span');
    resizeEl.className = 'resize-handle';
    resizeEl.title = 'Drag to resize';
    resizeEl.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 13 L13 3 M7 13 H13 V7"/></svg>';
    var resizePt = pointOnWobblyEllipse(geom, wobble, ANGLE_BOTTOM_RIGHT);
    resizeEl.style.left = (resizePt.x + Math.cos(ANGLE_BOTTOM_RIGHT)*12) + 'px';
    resizeEl.style.top = (resizePt.y + Math.sin(ANGLE_BOTTOM_RIGHT)*12) + 'px';
    el.appendChild(resizeEl);
    if(cropNodeId === n.id){ resizeEl.style.display = 'none'; }

    var connectorEl = document.createElement('span');
    connectorEl.className = 'connector-handle';
    connectorEl.title = 'Drag to draw a line';
    var connectorPt = pointOnWobblyEllipse(geom, wobble, ANGLE_TOP);
    connectorEl.style.left = connectorPt.x + 'px';
    connectorEl.style.top = connectorPt.y + 'px';
    el.appendChild(connectorEl);

    el.addEventListener('pointermove', function(e){
      if(dragCtx || resizeCtx || connectCtx) return;
      // Once the cursor is close enough to the handle's CURRENT position,
      // stop chasing it — otherwise it keeps dodging the last pixel of
      // approach and never sits still long enough to actually grab. It
      // resumes tracking as soon as the cursor moves away again.
      var curRect = connectorEl.getBoundingClientRect();
      var curCx = curRect.left + curRect.width/2, curCy = curRect.top + curRect.height/2;
      if(Math.hypot(e.clientX - curCx, e.clientY - curCy) < 30) return;
      var wp = screenToWorld(e.clientX, e.clientY);
      var s = n.scale || 1;
      var localX = (wp.x - n.x) / s;
      var localY = (wp.y - n.y) / s;
      var dx = localX - geom.cx, dy = localY - geom.cy;
      if(!dx && !dy) return;
      var angle = Math.atan2(dy, dx);
      // Nudge the angle away from any fixed button it's about to land on,
      // so the handle is always reachable somewhere near the cursor instead
      // of hiding underneath Aa/delete/resize.
      var CONNECTOR_KEEPOUT = 0.36; // ~20 degrees either side of a button
      keepoutAngles.forEach(function(ba){
        var d = angle - ba;
        while(d > Math.PI) d -= 2*Math.PI;
        while(d < -Math.PI) d += 2*Math.PI;
        if(Math.abs(d) < CONNECTOR_KEEPOUT) angle = ba + (d < 0 ? -CONNECTOR_KEEPOUT : CONNECTOR_KEEPOUT);
      });
      var pt = pointOnWobblyEllipse(geom, wobble, angle);
      connectorEl.style.left = pt.x + 'px';
      connectorEl.style.top = pt.y + 'px';
    });
    connectorEl.addEventListener('pointerdown', function(e){ e.stopPropagation(); startConnect(e, n.id); });
    if(cropNodeId === n.id){ connectorEl.style.display = 'none'; }

    if(n.type === 'image'){
      var wrap = document.createElement('div');
      wrap.className = 'imgwrap';
      wrap.style.width = contentW + 'px';
      var img = document.createElement('img');
      img.style.height = contentH + 'px';
      img.src = n.src;
      img.draggable = false;
      wrap.appendChild(img);
      frame.appendChild(wrap);

      // Double-click the photo itself to start (or stop) cropping — there
      // used to be a separate "Crop" button under the photo for this.
      el.addEventListener('dblclick', function(e){
        e.stopPropagation();
        if(cropNodeId === n.id){
          cropNodeId = null; cropRect = null;
        } else {
          cropNodeId = n.id;
          var mx = contentW*0.08, my = contentH*0.08;
          cropRect = { x:mx, y:my, w:contentW - mx*2, h:contentH - my*2 };
        }
        render();
      });

      if(cropNodeId === n.id){
        wrap.appendChild(buildCropOverlay(contentW, contentH));
        frame.appendChild(buildCropControls(n));
      }
    } else {
      var editable = document.createElement('div');
      editable.className = 'editable';
      editable.style.width = contentW + 'px';
      editable.style.minHeight = contentH + 'px';
      editable.contentEditable = 'false';
      var placeholderText = 'Type something';
      editable.setAttribute('data-placeholder', placeholderText);
      editable.textContent = n.text || '';
      editable.spellcheck = false;
      if(n.bigText){
        // Measure against the placeholder itself when there's no text yet,
        // so the empty-state hint doesn't get scaled past the circle.
        editable.style.fontSize = fitFontSize(n.text || placeholderText, contentW, contentH) + 'px';
      }
      editable.addEventListener('blur', function(){
        n.text = editable.innerText.replace(/\n$/, '');
        editable.contentEditable = 'false';
        el.classList.remove('editing');
        saveState();
        render();
      });
      var fitBtn = document.createElement('button');
      fitBtn.className = 'fit-btn' + (n.bigText ? ' active' : '');
      fitBtn.type = 'button';
      fitBtn.title = n.bigText ? 'Use normal text size' : 'Fill the circle';
      fitBtn.textContent = 'Aa';
      var fitPt = pointOnWobblyEllipse(geom, wobble, ANGLE_TOP_LEFT);
      fitBtn.style.left = fitPt.x + 'px';
      fitBtn.style.top = fitPt.y + 'px';
      fitBtn.addEventListener('pointerdown', function(e){ e.stopPropagation(); });
      fitBtn.addEventListener('click', function(e){
        e.stopPropagation();
        n.bigText = !n.bigText;
        saveState(); render();
      });
      el.appendChild(fitBtn);
      // Pointer capture from drag-tracking (below) retargets the native
      // dblclick to the outer node element rather than the editable div
      // itself, so this listens here instead of on `editable`.
      el.addEventListener('dblclick', function(e){
        e.stopPropagation();
        editable.contentEditable = 'true';
        el.classList.add('editing');
        editable.focus();
        var range = null;
        if(!editable.textContent){
          // Empty note: ignore the click position and just drop the caret
          // into the (empty) content, so CSS centering places it in the
          // middle of the circle instead of wherever the click landed.
          range = document.createRange();
          range.selectNodeContents(editable);
        } else if(document.caretRangeFromPoint){
          range = document.caretRangeFromPoint(e.clientX, e.clientY);
        } else if(document.caretPositionFromPoint){
          var pos = document.caretPositionFromPoint(e.clientX, e.clientY);
          if(pos && pos.offsetNode){ range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
        }
        if(range){
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
      editable.addEventListener('keydown', function(e){
        e.stopPropagation();
        if(e.key === 'Escape'){
          editable.blur();
        }
        // Enter is left to the browser's own default handling (it starts a
        // new line); innerText correctly reads that back out as "\n" on blur.
      });
      frame.appendChild(editable);
    }

    var circleSvg = buildCircleFrame(n, contentW, contentH);
    frame.insertBefore(circleSvg, frame.firstChild);

    var hitZone = document.createElement('div');
    hitZone.className = 'node-hit';
    hitZone.style.left = (-geom.pad) + 'px';
    hitZone.style.top = (-geom.pad) + 'px';
    hitZone.style.width = (contentW + geom.pad*2) + 'px';
    hitZone.style.height = (contentH + geom.pad*2) + 'px';
    frame.insertBefore(hitZone, frame.firstChild);

    delEl.addEventListener('pointerdown', function(e){ e.stopPropagation(); });
    delEl.addEventListener('click', function(e){ e.stopPropagation(); deleteNode(n.id); });
    resizeEl.addEventListener('pointerdown', function(e){ startResize(e, n.id, el); });
    el.addEventListener('pointerdown', function(e){ startNodeDrag(e, n.id, el); });

    return el;
  }

  // ---------------- crop tool ----------------
  function buildCropOverlay(contentW, contentH){
    var overlay = document.createElement('div');
    overlay.className = 'cropoverlay';
    overlay.addEventListener('pointerdown', function(e){ e.stopPropagation(); });

    var rectEl = document.createElement('div');
    rectEl.className = 'crop-rect';
    overlay.appendChild(rectEl);

    var handles = {};
    ['nw','ne','sw','se'].forEach(function(pos){
      var h = document.createElement('div');
      h.className = 'crop-handle ' + pos;
      rectEl.appendChild(h);
      handles[pos] = h;
    });

    function clamp(){
      cropRect.w = Math.max(24, Math.min(cropRect.w, contentW));
      cropRect.h = Math.max(24, Math.min(cropRect.h, contentH));
      cropRect.x = Math.max(0, Math.min(cropRect.x, contentW - cropRect.w));
      cropRect.y = Math.max(0, Math.min(cropRect.y, contentH - cropRect.h));
    }
    function paint(){
      rectEl.style.left = cropRect.x + 'px';
      rectEl.style.top = cropRect.y + 'px';
      rectEl.style.width = cropRect.w + 'px';
      rectEl.style.height = cropRect.h + 'px';
    }
    clamp(); paint();

    rectEl.addEventListener('pointerdown', function(e){
      if(e.target !== rectEl) return;
      e.stopPropagation(); e.preventDefault();
      var startX = e.clientX, startY = e.clientY;
      var orig = { x:cropRect.x, y:cropRect.y };
      rectEl.setPointerCapture(e.pointerId);
      function onMove(ev){
        var dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
        cropRect.x = orig.x + dx; cropRect.y = orig.y + dy;
        clamp(); paint();
      }
      function onUp(){
        rectEl.removeEventListener('pointermove', onMove);
        rectEl.removeEventListener('pointerup', onUp);
      }
      rectEl.addEventListener('pointermove', onMove);
      rectEl.addEventListener('pointerup', onUp);
    });

    Object.keys(handles).forEach(function(pos){
      handles[pos].addEventListener('pointerdown', function(e){
        e.stopPropagation(); e.preventDefault();
        var startX = e.clientX, startY = e.clientY;
        var orig = { x:cropRect.x, y:cropRect.y, w:cropRect.w, h:cropRect.h };
        handles[pos].setPointerCapture(e.pointerId);
        function onMove(ev){
          var dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
          var nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;
          if(pos.indexOf('w') !== -1){ nx = orig.x + dx; nw = orig.w - dx; }
          if(pos.indexOf('e') !== -1){ nw = orig.w + dx; }
          if(pos.indexOf('n') !== -1){ ny = orig.y + dy; nh = orig.h - dy; }
          if(pos.indexOf('s') !== -1){ nh = orig.h + dy; }
          if(nw < 24){ if(pos.indexOf('w') !== -1) nx = orig.x + orig.w - 24; nw = 24; }
          if(nh < 24){ if(pos.indexOf('n') !== -1) ny = orig.y + orig.h - 24; nh = 24; }
          cropRect.x = nx; cropRect.y = ny; cropRect.w = nw; cropRect.h = nh;
          clamp(); paint();
        }
        function onUp(){
          handles[pos].removeEventListener('pointermove', onMove);
          handles[pos].removeEventListener('pointerup', onUp);
        }
        handles[pos].addEventListener('pointermove', onMove);
        handles[pos].addEventListener('pointerup', onUp);
      });
    });

    return overlay;
  }

  function buildCropControls(n){
    var row = document.createElement('div');
    row.className = 'croprow';
    row.addEventListener('pointerdown', function(e){ e.stopPropagation(); });

    var applyBtn = document.createElement('button');
    applyBtn.className = 'btn';
    applyBtn.type = 'button';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', function(e){
      e.stopPropagation();
      pushUndo();
      applyBtn.textContent = 'Working';
      var rect = { x:cropRect.x, y:cropRect.y, w:cropRect.w, h:cropRect.h };
      setTimeout(function(){
        applyCrop(n, rect, function(){
          cropNodeId = null; cropRect = null;
          saveState(); render();
        });
      }, 20);
    });

    var resetBtn = document.createElement('button');
    resetBtn.className = 'btn';
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', function(e){
      e.stopPropagation();
      if(n.origW !== undefined){
        pushUndo();
        n.src = n.origSrc;
        n.w = n.origW; n.h = n.origH; n.x = n.origX; n.y = n.origY;
        delete n.origW; delete n.origH; delete n.origX; delete n.origY;
        saveState();
      }
      cropNodeId = null; cropRect = null;
      render();
    });

    var closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', function(e){
      e.stopPropagation();
      cropNodeId = null; cropRect = null;
      render();
    });

    row.appendChild(applyBtn);
    row.appendChild(resetBtn);
    row.appendChild(closeBtn);
    return row;
  }

  function applyCrop(n, rect, done){
    var img = new Image();
    img.onload = function(){
      var natW = img.naturalWidth, natH = img.naturalHeight;
      var dispW = n.w || IMG_W, dispH = n.h || 160;
      var scaleX = natW / dispW, scaleY = natH / dispH;
      var sx = rect.x * scaleX, sy = rect.y * scaleY;
      var sw = rect.w * scaleX, sh = rect.h * scaleY;
      var cvs = document.createElement('canvas');
      cvs.width = Math.max(1, Math.round(sw));
      cvs.height = Math.max(1, Math.round(sh));
      var ctx = cvs.getContext('2d');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cvs.width, cvs.height);
      var dataUrl = cvs.toDataURL('image/png');

      if(n.origW === undefined){ n.origW = n.w; n.origH = n.h; n.origX = n.x; n.origY = n.y; }
      n.src = dataUrl;
      n.x = (n.x||0) + rect.x;
      n.y = (n.y||0) + rect.y;
      n.w = rect.w; n.h = rect.h;
      done();
    };
    img.onerror = function(){ showToast('Could not crop that image'); done(); };
    img.src = n.src;
  }

  function nodeCenterWorld(id){
    var n = findNode(id);
    if(!n) return {x:0,y:0,rx:1,ry:1};
    var size = computeContentSize(n);
    var geom = circleGeom(size.w, size.h, n.type === 'image');
    var s = n.scale || 1;
    return { x: n.x + geom.cx*s, y: n.y + geom.cy*s, rx: geom.rx*s, ry: geom.ry*s };
  }

  function ellipseBoundaryPoint(center, toward){
    var dx = toward.x - center.x, dy = toward.y - center.y;
    if(!dx && !dy) return { x:center.x, y:center.y - center.ry };
    var t = 1 / Math.sqrt((dx/center.rx)*(dx/center.rx) + (dy/center.ry)*(dy/center.ry));
    return { x: center.x + dx*t, y: center.y + dy*t };
  }

  function edgePairPoints(aId, bId){
    var ca = nodeCenterWorld(aId);
    var cb = nodeCenterWorld(bId);
    return { a: ellipseBoundaryPoint(ca, cb), b: ellipseBoundaryPoint(cb, ca) };
  }

  function pathD(a,b){
    var dx = b.x-a.x, dy = b.y-a.y;
    var dist = Math.sqrt(dx*dx+dy*dy);
    var sag = Math.min(60, Math.max(10, dist*0.16));
    var mx = (a.x+b.x)/2;
    var my = (a.y+b.y)/2 + sag;
    return 'M '+a.x+' '+a.y+' Q '+mx+' '+my+' '+b.x+' '+b.y;
  }

  function renderEdges(){
    edgeGroup.innerHTML = '';
    edgeEls = {};
    state.edges.forEach(function(edge){
      var pts = edgePairPoints(edge.a, edge.b);
      var a = pts.a, b = pts.b;
      var g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('class','edge');
      var hit = document.createElementNS('http://www.w3.org/2000/svg','path');
      hit.setAttribute('class','hit');
      hit.setAttribute('d', pathD(a,b));
      hit.addEventListener('click', function(ev){ ev.stopPropagation(); deleteEdge(edge.id); });
      var fuzz = document.createElementNS('http://www.w3.org/2000/svg','path');
      fuzz.setAttribute('class','fuzz');
      fuzz.setAttribute('d', pathD(a,b));
      var visible = document.createElementNS('http://www.w3.org/2000/svg','path');
      visible.setAttribute('class','visible');
      visible.setAttribute('d', pathD(a,b));
      g.appendChild(hit); g.appendChild(fuzz); g.appendChild(visible);
      edgeGroup.appendChild(g);
      edgeEls[edge.id] = {hit:hit, visible:visible, fuzz:fuzz};
    });
  }

  function updateEdgesTouching(nodeId){
    state.edges.forEach(function(edge){
      if(edge.a !== nodeId && edge.b !== nodeId) return;
      var refs = edgeEls[edge.id];
      if(!refs) return;
      var pts = edgePairPoints(edge.a, edge.b);
      var d = pathD(pts.a, pts.b);
      refs.hit.setAttribute('d', d);
      refs.visible.setAttribute('d', d);
      refs.fuzz.setAttribute('d', d);
    });
  }

  function findNode(id){
    for(var i=0;i<state.nodes.length;i++) if(state.nodes[i].id === id) return state.nodes[i];
    return null;
  }

  // ---------------- mutations ----------------
  function deleteNode(id){
    pushUndo();
    state.nodes = state.nodes.filter(function(n){ return n.id !== id; });
    state.edges = state.edges.filter(function(e){ return e.a !== id && e.b !== id; });
    if(selectedNodeId === id) selectedNodeId = null;
    var si = selectedIds.indexOf(id);
    if(si !== -1) selectedIds.splice(si, 1);
    if(cropNodeId === id){ cropNodeId = null; cropRect = null; }
    saveState(); render();
  }
  function deleteEdge(id){
    pushUndo();
    state.edges = state.edges.filter(function(e){ return e.id !== id; });
    saveState(); render();
  }
  function addTextNode(worldPos){
    pushUndo();
    var n = { id: uid(), type:'text', x: worldPos.x-95, y: worldPos.y-55, text:'', scale:1 };
    state.nodes.push(n);
    saveState(); render();
    var el = nodeEls[n.id];
    if(el){ var ed = el.querySelector('.editable'); if(ed){ ed.contentEditable = 'true'; ed.focus(); } }
  }

  function addImageFile(file, worldPos){
    var reader = new FileReader();
    reader.onload = function(){
      var img = new Image();
      img.onload = function(){
        var ratio = img.naturalWidth / img.naturalHeight;
        var w = IMG_W, h = Math.round(w/ratio);
        if(h > IMG_MAX_H){ h = IMG_MAX_H; w = Math.round(h*ratio); }
        if(h < IMG_MIN_H){ h = IMG_MIN_H; w = Math.round(h*ratio); }
        if(w > 260){ w = 260; h = Math.round(w/ratio); }

        var scale = 2;
        var ow = Math.min(560, Math.round(w*scale));
        var oh = Math.round(ow/ratio);
        var cvs = document.createElement('canvas');
        cvs.width = ow; cvs.height = oh;
        var ctx = cvs.getContext('2d');
        ctx.drawImage(img,0,0,ow,oh);
        var dataUrl = cvs.toDataURL('image/jpeg',0.86);

        var n = {
          id: uid(), type:'image',
          x: worldPos.x - w/2, y: worldPos.y - h/2,
          w:w, h:h, src:dataUrl, origSrc:dataUrl,
          removed:false, tolerance:35, scale:1
        };
        pushUndo();
        state.nodes.push(n);
        saveState(); render();
      };
      img.onerror = function(){ showToast('Could not read that image'); };
      img.src = reader.result;
    };
    reader.onerror = function(){ showToast('Could not read that image'); };
    reader.readAsDataURL(file);
  }

  // ---------------- drag / connect / pan ----------------
  // Bring a node to the top of the stack (both in the saved node order and
  // visually) whenever it's clicked or dragged, so the last-touched circle
  // always sits above the others.
  function bringNodeToFront(id){
    var idx = state.nodes.findIndex(function(x){ return x.id === id; });
    if(idx === -1 || idx === state.nodes.length - 1) return;
    var n = state.nodes.splice(idx,1)[0];
    state.nodes.push(n);
    var el = nodeEls[id];
    if(el && el.parentNode) el.parentNode.appendChild(el);
    saveState();
  }
  var dragCtx = null;
  function startNodeDrag(e, id, el){
    if(e.button !== undefined && e.button !== 0) return;
    if(el.classList.contains('editing')) return; // let text selection happen instead
    e.stopPropagation();
    if(e.shiftKey){
      toggleSelect(id);
      refreshSelectedClasses();
      return;
    }
    if(!isSelected(id)) setSelection([id]);
    else selectedNodeId = id;
    refreshSelectedClasses();
    var n = findNode(id);
    if(!n) return;
    bringNodeToFront(id);
    var groupIds = (selectedIds.length > 1 && isSelected(id)) ? selectedIds.slice() : [id];
    var startPositions = {};
    groupIds.forEach(function(gid){ var gn = findNode(gid); if(gn) startPositions[gid] = {x:gn.x, y:gn.y}; });
    dragCtx = { id:id, el:el, startClientX:e.clientX, startClientY:e.clientY, startX:n.x, startY:n.y, moved:false, pointerId:e.pointerId, snapshot:snapshotState(), groupIds:groupIds, startPositions:startPositions };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    window.addEventListener('pointermove', onNodeDragMove);
    window.addEventListener('pointerup', onNodeDragEnd);
  }
  function onNodeDragMove(e){
    if(!dragCtx) return;
    var dx = (e.clientX - dragCtx.startClientX) / zoom;
    var dy = (e.clientY - dragCtx.startClientY) / zoom;
    if(Math.abs(dx) > 4 || Math.abs(dy) > 4) dragCtx.moved = true;
    dragCtx.groupIds.forEach(function(gid){
      var gn = findNode(gid);
      var sp = dragCtx.startPositions[gid];
      if(!gn || !sp) return;
      gn.x = sp.x + dx; gn.y = sp.y + dy;
      var gel = nodeEls[gid];
      if(gel){ gel.style.left = gn.x + 'px'; gel.style.top = gn.y + 'px'; }
      updateEdgesTouching(gid);
    });
  }
  function onNodeDragEnd(e){
    if(!dragCtx) return;
    dragCtx.el.classList.remove('dragging');
    window.removeEventListener('pointermove', onNodeDragMove);
    window.removeEventListener('pointerup', onNodeDragEnd);
    if(dragCtx.moved){ pushUndoSnapshot(dragCtx.snapshot); saveState(); }
    dragCtx = null;
  }

  var resizeCtx = null;
  function startResize(e, id, el){
    e.stopPropagation(); e.preventDefault();
    var n = findNode(id);
    if(!n) return;
    var origin = worldToScreen(n.x, n.y);
    var startDist = Math.hypot(e.clientX-origin.x, e.clientY-origin.y) || 1;
    var groupIds = (selectedIds.length > 1 && isSelected(id)) ? selectedIds.slice() : [id];
    var startScales = {};
    groupIds.forEach(function(gid){ var gn = findNode(gid); if(gn) startScales[gid] = gn.scale || 1; });
    resizeCtx = { id:id, el:el, origin:origin, startDist:startDist, groupIds:groupIds, startScales:startScales, pointerId:e.pointerId, snapshot:snapshotState() };
    el.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd);
  }
  function onResizeMove(e){
    if(!resizeCtx) return;
    var d = Math.hypot(e.clientX-resizeCtx.origin.x, e.clientY-resizeCtx.origin.y) || 1;
    var ratio = d/resizeCtx.startDist;
    resizeCtx.groupIds.forEach(function(gid){
      var gn = findNode(gid);
      if(!gn) return;
      var s = (resizeCtx.startScales[gid] || 1) * ratio;
      s = Math.min(2.4, Math.max(0.5, s));
      gn.scale = s;
      var gel = nodeEls[gid];
      if(gel) gel.style.transform = 'scale(' + s + ')';
      updateEdgesTouching(gid);
    });
  }
  function onResizeEnd(e){
    if(!resizeCtx) return;
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeEnd);
    var changed = resizeCtx.groupIds.some(function(gid){
      var gn = findNode(gid);
      return gn && gn.scale !== resizeCtx.startScales[gid];
    });
    if(changed) pushUndoSnapshot(resizeCtx.snapshot);
    saveState();
    resizeCtx = null;
  }

  var connectCtx = null;
  var tempPath = null;
  function startConnect(e, id){
    e.stopPropagation(); e.preventDefault();
    connectCtx = {from:id, pointerId:e.pointerId};
    appEl.classList.add('connecting');
    tempPath = document.createElementNS('http://www.w3.org/2000/svg','path');
    tempPath.setAttribute('class','temp');
    svg.appendChild(tempPath);
    window.addEventListener('pointermove', onConnectMove);
    window.addEventListener('pointerup', onConnectEnd);
  }
  function onConnectMove(e){
    if(!connectCtx) return;
    var p = screenToWorld(e.clientX, e.clientY);
    var a = ellipseBoundaryPoint(nodeCenterWorld(connectCtx.from), p);
    tempPath.setAttribute('d', pathD(a,p));
    // The line's anchor slides around the source circle's edge to follow
    // the cursor; keep the little connector dot glued to that same spot
    // while dragging instead of leaving it frozen where the drag started —
    // a static dot next to a moving line-start felt disconnected.
    var fromNode = findNode(connectCtx.from);
    var fromEl = nodeEls[connectCtx.from];
    var handle = fromEl && fromEl.querySelector('.connector-handle');
    if(fromNode && handle){
      var size = computeContentSize(fromNode);
      var geom = circleGeom(size.w, size.h, fromNode.type === 'image');
      var wobble = ensureWobble(fromNode);
      var s = fromNode.scale || 1;
      var localX = (p.x - fromNode.x) / s, localY = (p.y - fromNode.y) / s;
      var dx = localX - geom.cx, dy = localY - geom.cy;
      if(dx || dy){
        var pt = pointOnWobblyEllipse(geom, wobble, Math.atan2(dy, dx));
        handle.style.left = pt.x + 'px';
        handle.style.top = pt.y + 'px';
      }
    }
  }
  function onConnectEnd(e){
    if(!connectCtx) return;
    appEl.classList.remove('connecting');
    window.removeEventListener('pointermove', onConnectMove);
    window.removeEventListener('pointerup', onConnectEnd);
    if(tempPath && tempPath.parentNode) tempPath.parentNode.removeChild(tempPath);
    tempPath = null;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var targetEl = el ? el.closest('.node') : null;
    var targetId = targetEl ? targetEl.dataset.id : null;
    var fromId = connectCtx.from;
    connectCtx = null;
    if(targetId && targetId !== fromId){
      var exists = state.edges.some(function(ed){ return (ed.a===fromId && ed.b===targetId) || (ed.a===targetId && ed.b===fromId); });
      if(!exists){
        pushUndo();
        state.edges.push({id:uid(), a:fromId, b:targetId});
        saveState(); render();
        return;
      }
    }
    renderEdges();
  }

  var panCtx = null;
  var marqueeCtx = null;
  var marqueeEl = null;
  function startMarquee(e){
    var startWorld = screenToWorld(e.clientX, e.clientY);
    var wobble = []; for(var i=0;i<12;i++) wobble.push(Math.random()*2-1);
    marqueeCtx = { startClientX:e.clientX, startClientY:e.clientY, startWorld:startWorld, pointerId:e.pointerId, wobble:wobble };
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee';
    var svgEl = document.createElementNS('http://www.w3.org/2000/svg','svg');
    var pathEl = document.createElementNS('http://www.w3.org/2000/svg','path');
    svgEl.appendChild(pathEl);
    marqueeEl.appendChild(svgEl);
    viewport.appendChild(marqueeEl);
    viewport.setPointerCapture(e.pointerId);
  }
  function onMarqueeMove(e){
    if(!marqueeCtx) return;
    var r = viewport.getBoundingClientRect();
    var x0 = marqueeCtx.startClientX - r.left, y0 = marqueeCtx.startClientY - r.top;
    var x1 = e.clientX - r.left, y1 = e.clientY - r.top;
    var w = Math.max(1, Math.abs(x1-x0)), h = Math.max(1, Math.abs(y1-y0));
    marqueeEl.style.left = Math.min(x0,x1) + 'px';
    marqueeEl.style.top = Math.min(y0,y1) + 'px';
    marqueeEl.style.width = w + 'px';
    marqueeEl.style.height = h + 'px';
    var svgEl = marqueeEl.firstChild, pathEl = svgEl.firstChild;
    svgEl.setAttribute('width', w);
    svgEl.setAttribute('height', h);
    svgEl.setAttribute('viewBox', '0 0 '+w+' '+h);
    pathEl.setAttribute('d', blobPath(w/2, h/2, w/2, h/2, marqueeCtx.wobble));
  }
  function endMarquee(e){
    if(!marqueeCtx) return;
    var endWorld = screenToWorld(e.clientX, e.clientY);
    var x0 = Math.min(marqueeCtx.startWorld.x, endWorld.x), x1 = Math.max(marqueeCtx.startWorld.x, endWorld.x);
    var y0 = Math.min(marqueeCtx.startWorld.y, endWorld.y), y1 = Math.max(marqueeCtx.startWorld.y, endWorld.y);
    var picked = [];
    state.nodes.forEach(function(n){
      var c = nodeCenterWorld(n.id);
      var nx0 = c.x - c.rx, nx1 = c.x + c.rx, ny0 = c.y - c.ry, ny1 = c.y + c.ry;
      if(nx1 >= x0 && nx0 <= x1 && ny1 >= y0 && ny0 <= y1) picked.push(n.id);
    });
    if(marqueeEl && marqueeEl.parentNode) marqueeEl.parentNode.removeChild(marqueeEl);
    marqueeEl = null;
    marqueeCtx = null;
    if(picked.length){ setSelection(picked); refreshSelectedClasses(); }
  }
  // A second pointerdown landing near/soon-after the first, on empty canvas,
  // is treated as the start of a possible double-click: if it then moves, it
  // becomes a lasso-select (like shift-drag) instead of adding a note.
  var lastEmptyDown = null;
  var dblDragCtx = null;
  var suppressDblClick = false;
  viewport.addEventListener('pointerdown', function(e){
    if(e.target !== viewport && e.target !== world && e.target !== svg && e.target !== nodesLayer) return;
    if(e.shiftKey){
      startMarquee(e);
      return;
    }
    var now = Date.now();
    var isDblStart = lastEmptyDown && (now - lastEmptyDown.time < 400) &&
      Math.hypot(e.clientX - lastEmptyDown.x, e.clientY - lastEmptyDown.y) < 8;
    lastEmptyDown = { time: now, x:e.clientX, y:e.clientY };
    if(isDblStart){
      dblDragCtx = { startClientX:e.clientX, startClientY:e.clientY, pointerId:e.pointerId, active:false };
      return;
    }
    selectedIds = []; selectedNodeId = null;
    document.querySelectorAll('.node.selected').forEach(function(x){ x.classList.remove('selected'); });
    panCtx = {startX:e.clientX, startY:e.clientY, panX:pan.x, panY:pan.y, pointerId:e.pointerId};
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('panning');
  });
  viewport.addEventListener('pointermove', function(e){
    if(dblDragCtx){
      var dx = e.clientX - dblDragCtx.startClientX, dy = e.clientY - dblDragCtx.startClientY;
      if(!dblDragCtx.active && Math.hypot(dx,dy) > 4){
        dblDragCtx.active = true;
        suppressDblClick = true;
        startMarquee({ clientX:dblDragCtx.startClientX, clientY:dblDragCtx.startClientY, pointerId:dblDragCtx.pointerId });
      }
      if(dblDragCtx.active) onMarqueeMove(e);
      return;
    }
    if(marqueeCtx){ onMarqueeMove(e); return; }
    if(!panCtx) return;
    pan.x = panCtx.panX + (e.clientX - panCtx.startX);
    pan.y = panCtx.panY + (e.clientY - panCtx.startY);
    applyTransform();
  });
  function endPan(e){
    if(dblDragCtx){
      var wasActive = dblDragCtx.active;
      dblDragCtx = null;
      if(wasActive && marqueeCtx) endMarquee(e);
      // Any dblclick belonging to this same gesture fires synchronously
      // right after pointerup/mouseup, before this timeout runs — so by the
      // time we clear the flag, a real dblclick has already consumed it.
      if(wasActive) setTimeout(function(){ suppressDblClick = false; }, 0);
      return;
    }
    if(marqueeCtx){ endMarquee(e); return; }
    if(!panCtx) return; panCtx = null; viewport.classList.remove('panning');
  }
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  viewport.addEventListener('dblclick', function(e){
    if(suppressDblClick){ suppressDblClick = false; return; }
    if(e.target !== viewport && e.target !== world && e.target !== svg && e.target !== nodesLayer) return;
    addTextNode(screenToWorld(e.clientX, e.clientY));
  });

  viewport.addEventListener('wheel', function(e){
    e.preventDefault();
    var r = viewport.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var before = { x:(mx - pan.x)/zoom, y:(my - pan.y)/zoom };
    var delta = -e.deltaY * 0.0015;
    zoom = clampZoom(zoom * (1 + delta));
    pan.x = mx - before.x*zoom; pan.y = my - before.y*zoom;
    applyTransform();
  }, {passive:false});

  document.getElementById('zoomIn').addEventListener('click', function(){ zoom = clampZoom(zoom*1.2); applyTransform(); });
  document.getElementById('zoomOut').addEventListener('click', function(){ zoom = clampZoom(zoom/1.2); applyTransform(); });
  document.getElementById('zoomReset').addEventListener('click', function(){ zoom = 1; pan = {x:0,y:0}; applyTransform(); });

  var fileInput = document.getElementById('fileInput');
  fileInput.addEventListener('change', function(){
    var files = Array.prototype.slice.call(fileInput.files || []);
    var r = viewport.getBoundingClientRect();
    var center = screenToWorld(r.left + r.width/2, r.top + r.height/2);
    files.forEach(function(f, i){
      if(!/^image\//.test(f.type)) return;
      var jitter = {x: center.x + (Math.random()*160-80) + i*8, y: center.y + (Math.random()*140-70)};
      addImageFile(f, jitter);
    });
    fileInput.value = '';
  });

  viewport.addEventListener('dragover', function(e){ e.preventDefault(); });
  viewport.addEventListener('drop', function(e){
    e.preventDefault();
    var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
    var pos = screenToWorld(e.clientX, e.clientY);
    var any = false;
    files.forEach(function(f, i){
      if(!/^image\//.test(f.type)) return;
      any = true;
      addImageFile(f, {x:pos.x + i*10, y:pos.y + i*10});
    });
    if(!any && files.length) showToast('Please drop image files');
  });

  document.addEventListener('paste', function(e){
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for(var i=0;i<items.length;i++){
      if(items[i].type && items[i].type.indexOf('image') === 0){
        var f = items[i].getAsFile();
        if(f){
          var r = viewport.getBoundingClientRect();
          addImageFile(f, screenToWorld(r.left+r.width/2, r.top+r.height/2));
        }
      }
    }
  });

  document.getElementById('addTextBtn').addEventListener('click', function(){
    var r = viewport.getBoundingClientRect();
    addTextNode(screenToWorld(r.left + r.width/2 + (Math.random()*60-30), r.top + r.height/2 + (Math.random()*60-30)));
  });

  document.getElementById('clearBtn').addEventListener('click', function(){
    if(state.nodes.length === 0) return;
    showConfirmDialog('Clear every image, note and string from the board?', function(){
      pushUndo();
      state = {nodes:[], edges:[]};
      selectedIds = []; selectedNodeId = null; cropNodeId = null; cropRect = null;
      saveState(); render();
      showToast('Board cleared');
    });
  });

  function howtoListHTML(){
    return '<ul>' + HOWTO_ITEMS.map(function(t){ return '<li>'+t+'</li>'; }).join('') + '</ul>';
  }
  var helpBtn = document.getElementById('helpBtn');
  var helpEl = null;
  helpBtn.addEventListener('click', function(){
    if(helpEl){ helpEl.remove(); helpEl = null; return; }
    helpEl = document.createElement('div');
    helpEl.className = 'help';
    helpEl.innerHTML =
      '<button class="close" aria-label="Close">×</button>'+
      '<h3>How To</h3>'+
      howtoListHTML();
    document.querySelector('.viewport').appendChild(helpEl);
    helpEl.querySelector('.close').addEventListener('click', function(){ helpEl.remove(); helpEl=null; });
  });

  document.addEventListener('keydown', function(e){
    var ae = document.activeElement;
    var editing = !!(ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'));
    var mod = e.ctrlKey || e.metaKey;

    if(mod && !editing && (e.key === 'z' || e.key === 'Z')){
      e.preventDefault();
      undo();
      return;
    }
    if(mod && !editing && (e.key === 'c' || e.key === 'C')){
      if(selectedIds.length){
        clipboardNodes = selectedIds.map(function(id){
          var n = findNode(id);
          return n ? JSON.parse(JSON.stringify(n)) : null;
        }).filter(Boolean);
        pasteOffset = 0;
        showToast(clipboardNodes.length > 1 ? ('Copied ' + clipboardNodes.length) : 'Copied');
      }
      return;
    }
    if(mod && !editing && (e.key === 'v' || e.key === 'V')){
      if(clipboardNodes && clipboardNodes.length){
        e.preventDefault();
        pushUndo();
        pasteOffset += 24;
        var newIds = [];
        clipboardNodes.forEach(function(cn){
          var copy = JSON.parse(JSON.stringify(cn));
          copy.id = uid();
          copy.x += pasteOffset; copy.y += pasteOffset;
          copy.wobble = null;
          state.nodes.push(copy);
          newIds.push(copy.id);
        });
        setSelection(newIds);
        saveState(); render();
      }
      return;
    }
    if((e.key === 'Delete' || e.key === 'Backspace') && !editing){
      if(selectedIds.length){ e.preventDefault(); deleteSelected(); }
    }
  });

  // ---------------- theme / color picker ----------------
  var accentDot = document.getElementById('accentDot');
  var accentPanel = document.getElementById('accentPanel');
  var paperPicker = document.getElementById('paperPicker');
  var cardPicker = document.getElementById('cardPicker');
  var linePicker = document.getElementById('linePicker');
  var inkPicker = document.getElementById('inkPicker');
  var accentReset = document.getElementById('accentReset');
  var accentWobble = [0.05,-0.07,0.03,-0.05,0.06,-0.03,0.04,-0.06,0.03,-0.04];
  function rgbToHex(c){
    var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
    if(!m) return null;
    function h(v){ v = parseInt(v,10).toString(16); return v.length<2 ? '0'+v : v; }
    return '#'+h(m[1])+h(m[2])+h(m[3]);
  }
  function toHex(c){
    if(!c) return null;
    c = c.trim();
    if(/^#[0-9a-fA-F]{6}$/.test(c)) return c;
    return rgbToHex(c);
  }
  // The theme's own base colors, captured right now — before any saved
  // customization is applied — so "Reset" always has the true originals to
  // return to.
  var themeDefaults = {
    crayon: toHex(getComputedStyle(document.documentElement).getPropertyValue('--crayon')) || '#e2572b',
    paper: toHex(getComputedStyle(document.documentElement).getPropertyValue('--bg')) || '#ffffff',
    card: toHex(getComputedStyle(document.documentElement).getPropertyValue('--card')) || '#ffffff',
    ink: toHex(getComputedStyle(document.documentElement).getPropertyValue('--ink')) || '#141311'
  };
  function refreshAccentDot(){
    var th = currentTheme();
    var color = th.crayon || th.accent || themeDefaults.crayon;
    var d = blobPath(11,11,9,9,accentWobble);
    // Always the solid filled dot — hovering it (see .dot-btn:hover path)
    // is what signals it's interactive, so there's no separate open/closed
    // shape to keep track of.
    accentDot.innerHTML = '<svg viewBox="0 0 22 22"><path d="'+d+'" fill="'+color+'"></path></svg>';
  }
  // A swatch whose own color happens to match the panel's own background
  // (--card) would otherwise be invisible against it — ring just that one,
  // in the board's current line color so it reads as "drawn on", not a
  // plain system outline.
  function refreshSwatchOutlines(){
    var cardVal = (toHex(getComputedStyle(document.documentElement).getPropertyValue('--card')) || themeDefaults.card || '').toLowerCase();
    var th = currentTheme();
    var lineColor = th.crayon || th.accent || themeDefaults.crayon;
    [paperPicker, cardPicker, linePicker, inkPicker].forEach(function(p){
      var wrap = p.closest('.swatch-wrap');
      if(!wrap) return;
      wrap.classList.toggle('swatch-outline', (p.value || '').toLowerCase() === cardVal);
      var ringPath = wrap.querySelector('.swatch-ring path');
      if(ringPath) ringPath.setAttribute('stroke', lineColor);
    });
  }
  function setThemeField(field, color){
    if(!state.theme) state.theme = {};
    delete state.accent; // legacy single-field form, superseded once edited here
    state.theme[field] = color;
    applyTheme();
    refreshAccentDot();
    refreshSwatchOutlines();
    saveState();
  }
  function syncPickers(){
    var th = currentTheme();
    paperPicker.value = th.paper || themeDefaults.paper;
    cardPicker.value = th.card || themeDefaults.card;
    linePicker.value = th.crayon || th.accent || themeDefaults.crayon;
    inkPicker.value = th.ink || themeDefaults.ink;
    refreshSwatchOutlines();
  }
  // Draw a tiny wobbly-circle clip over each native color swatch, once, so
  // the picker reads as a hand-drawn dot instead of a square with rounded
  // corners — and with no colored ring around it, so the swatch shows
  // exactly the color it holds. The (normally hidden) outline ring reuses
  // this same wobble seed, just a touch bigger, so when it does appear it
  // looks like a hand-drawn echo of the swatch's own edge, not a stock circle.
  function wobblifySwatch(el){
    if(!el) return;
    var seed = []; for(var i=0;i<10;i++) seed.push(Math.random()*2-1);
    el.style.clipPath = 'path("' + blobPath(15,15,13,13,seed) + '")';
    var ringPath = el.parentElement && el.parentElement.querySelector('.swatch-ring path');
    if(ringPath) ringPath.setAttribute('d', blobPath(15,15,13.6,13.6,seed));
  }
  [paperPicker, cardPicker, linePicker, inkPicker].forEach(wobblifySwatch);
  function openAccentPanel(){
    syncPickers();
    accentPanel.hidden = false;
    refreshAccentDot();
    // This button lives inside the (until-now hidden) panel, so its
    // hand-drawn frame never got built at load time — do it now that it
    // actually has a layout size.
    buildButtonFrame(accentReset);
  }
  function closeAccentPanel(){ accentPanel.hidden = true; refreshAccentDot(); }
  accentDot.addEventListener('click', function(e){
    e.stopPropagation();
    if(accentPanel.hidden) openAccentPanel(); else closeAccentPanel();
  });
  accentPanel.addEventListener('pointerdown', function(e){ e.stopPropagation(); });
  paperPicker.addEventListener('input', function(){ setThemeField('paper', paperPicker.value); });
  cardPicker.addEventListener('input', function(){ setThemeField('card', cardPicker.value); });
  linePicker.addEventListener('input', function(){ setThemeField('crayon', linePicker.value); });
  inkPicker.addEventListener('input', function(){ setThemeField('ink', inkPicker.value); });
  accentReset.addEventListener('click', function(){
    state.theme = null;
    state.accent = null;
    applyTheme();
    syncPickers();
    refreshAccentDot();
    saveState();
  });
  document.addEventListener('pointerdown', function(e){
    if(!accentPanel.hidden && e.target !== accentDot && !accentDot.contains(e.target) && !accentPanel.contains(e.target)){
      closeAccentPanel();
    }
  });
  if(window.matchMedia){
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(){
      var th = currentTheme();
      if(!(th.crayon || th.accent)) refreshAccentDot();
    });
  }

  // ---------------- board tabs panel ----------------
  var brandLabel = document.getElementById('brandLabel');
  function closeBoardPanel(){
    if(boardPanelEl){ boardPanelEl.remove(); boardPanelEl = null; }
  }
  function renderBoardPanelContent(){
    if(!boardPanelEl) return;
    boardPanelEl.innerHTML = '';
    var idx = loadBoardsIndex() || ensureBoardsIndex();
    var list = document.createElement('div');
    list.className = 'boardlist';
    idx.boards.forEach(function(b){
      var row = document.createElement('div');
      row.className = 'boardrow' + (b.id === currentBoardId ? ' active' : '');
      row.draggable = true;
      row.dataset.boardId = b.id;
      var nameSpan = document.createElement('span');
      nameSpan.className = 'boardname';
      nameSpan.textContent = b.name;
      nameSpan.title = 'Switch to this board (double-click to rename)';
      nameSpan.addEventListener('click', function(){
        if(b.id !== currentBoardId){ switchToBoard(b.id); renderBoardPanelContent(); }
      });
      nameSpan.addEventListener('dblclick', function(e){
        e.stopPropagation();
        showPromptDialog('Rename board', b.name, function(nn){
          b.name = nn.slice(0,40);
          saveBoardsIndex(idx);
          renderBoardPanelContent();
        });
      });
      row.appendChild(nameSpan);
      if(idx.boards.length > 1){
        var delBtn = document.createElement('button');
        delBtn.className = 'boarddel';
        delBtn.type = 'button';
        // A hand-drawn X (via the same crayon displacement filter used
        // everywhere else) instead of a flat, perfectly straight glyph.
        delBtn.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3 3 L11 11 M11 3 L3 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" filter="url(#crayonA)"/></svg>';
        delBtn.title = 'Delete this board';
        delBtn.addEventListener('click', function(e){
          e.stopPropagation();
          showConfirmDialog('Delete "' + b.name + '"? This cannot be undone.', function(){
            deleteBoard(b.id);
            renderBoardPanelContent();
          });
        });
        row.appendChild(delBtn);
      }
      // Drag to reorder boards in the list.
      row.addEventListener('dragstart', function(e){
        e.dataTransfer.setData('text/plain', b.id);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', function(){
        row.classList.remove('dragging');
        list.querySelectorAll('.boardrow').forEach(function(r){ r.classList.remove('drop-before','drop-after'); });
      });
      row.addEventListener('dragover', function(e){
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var rect = row.getBoundingClientRect();
        var before = (e.clientY - rect.top) < rect.height/2;
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      });
      row.addEventListener('dragleave', function(){
        row.classList.remove('drop-before','drop-after');
      });
      row.addEventListener('drop', function(e){
        e.preventDefault();
        row.classList.remove('drop-before','drop-after');
        var draggedId = e.dataTransfer.getData('text/plain');
        if(!draggedId || draggedId === b.id) return;
        var fromIdx = idx.boards.findIndex(function(x){ return x.id === draggedId; });
        var toIdx = idx.boards.findIndex(function(x){ return x.id === b.id; });
        if(fromIdx === -1 || toIdx === -1) return;
        var rect = row.getBoundingClientRect();
        var before = (e.clientY - rect.top) < rect.height/2;
        var moved = idx.boards.splice(fromIdx,1)[0];
        var insertAt = idx.boards.findIndex(function(x){ return x.id === b.id; });
        if(!before) insertAt += 1;
        idx.boards.splice(insertAt,0,moved);
        saveBoardsIndex(idx);
        renderBoardPanelContent();
      });
      list.appendChild(row);
    });
    boardPanelEl.appendChild(list);
    var addBtn = document.createElement('button');
    addBtn.className = 'btn boardadd';
    addBtn.type = 'button';
    addBtn.textContent = '+ New Board';
    addBtn.addEventListener('click', function(){ createNewBoard(); renderBoardPanelContent(); });
    boardPanelEl.appendChild(addBtn);
    buildButtonFrame(addBtn);
  }
  function toggleBoardPanel(){
    if(boardPanelEl){ closeBoardPanel(); return; }
    boardPanelEl = document.createElement('div');
    boardPanelEl.className = 'boardpanel';
    boardPanelEl.addEventListener('pointerdown', function(e){ e.stopPropagation(); });
    document.querySelector('.toolbar').appendChild(boardPanelEl);
    renderBoardPanelContent();
  }
  brandLabel.addEventListener('click', function(e){
    if(e.target === accentDot || accentDot.contains(e.target)) return;
    toggleBoardPanel();
  });
  document.addEventListener('pointerdown', function(e){
    if(boardPanelEl && e.target !== brandLabel && !brandLabel.contains(e.target) && !boardPanelEl.contains(e.target)){
      closeBoardPanel();
    }
  });

  // ---------------- init ----------------
  var boardsIdx = ensureBoardsIndex();
  currentBoardId = boardsIdx.currentId || boardsIdx.boards[0].id;
  state = loadState();
  applyTheme();
  applyTransform();
  render();
  refreshButtonFrames();
  refreshAccentDot();
  showWelcomeIfNeeded();

  var resizeTimer = null;
  window.addEventListener('resize', function(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refreshButtonFrames, 150);
  });
  if(document.fonts && document.fonts.ready){
    document.fonts.ready.then(refreshButtonFrames);
  }
  window.addEventListener('load', refreshButtonFrames);
})();
