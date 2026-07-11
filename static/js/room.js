(function () {
  "use strict";

  const body = document.body;
  const ROOM_CODE = body.dataset.room;
  const nameFromUrl = (body.dataset.name || "").trim();

  const el = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------
  // Identity (persisted per browser so refreshing keeps the same player)
  // ---------------------------------------------------------------------
  const ID_KEY = "puzzle_player_id";
  const NAME_KEY = "puzzle_player_name";

  let playerId = localStorage.getItem(ID_KEY);
  if (!playerId) {
    playerId = window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : "p-" + Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem(ID_KEY, playerId);
  }

  // Only trust a name that was explicitly typed into the create/join form
  // (passed via ?name=...). A bare invite link never carries one, so those
  // visitors always get asked -- silently reusing whatever name a previous
  // session on this browser happened to store would be confusing when
  // joining a different game with different friends.
  let playerName = nameFromUrl || "";
  if (nameFromUrl) localStorage.setItem(NAME_KEY, nameFromUrl);

  const DIFFICULTIES = {
    easy: [4, 3],
    medium: [6, 4],
    hard: [8, 6],
    extreme: [10, 8],
  };

  let isHost = false;
  let started = false;

  // ---------------------------------------------------------------------
  // Toast helper
  // ---------------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
  }

  // ---------------------------------------------------------------------
  // Name prompt (if we don't know the player's name yet)
  // ---------------------------------------------------------------------
  function ensureName(cb) {
    if (playerName) return cb();
    const overlay = el("name-overlay");
    const input = el("name-input");
    input.value = ""; // always ask fresh, never prefill with a past name
    overlay.classList.remove("hidden");
    input.focus();
    el("name-form").addEventListener("submit", function onSubmit(e) {
      e.preventDefault();
      const val = input.value.trim().slice(0, 24);
      if (!val) return;
      playerName = val;
      localStorage.setItem(NAME_KEY, val);
      overlay.classList.add("hidden");
      el("name-form").removeEventListener("submit", onSubmit);
      cb();
    });
  }

  // ---------------------------------------------------------------------
  // View switching
  // ---------------------------------------------------------------------
  // Lobby <-> game is a single page (no real navigation), so we manage our
  // own history entries: switching view pushes/replaces a state object and
  // a popstate listener mirrors it back to the DOM. That way the browser's
  // Back button steps from the game view to the lobby (still inside the
  // room) before it ever leaves the room page, instead of skipping straight
  // to the previous real page.
  let gameAvailable = false;
  let currentView = "lobby";
  // True when this page load landed on a history entry we (or a previous
  // load of this same tab) already tagged with a view -- i.e. the user
  // navigated/reloaded onto it rather than arriving fresh. When true, that
  // tag wins over "the game happens to already be live on the server": we
  // must never overwrite an existing entry, or Back/Forward permanently
  // lose whichever view used to live there.
  let respectExistingView = false;

  function renderView(view) {
    currentView = view;
    if (view === "game" && gameAvailable) {
      el("lobby-view").classList.add("hidden");
      el("game-view").classList.remove("hidden");
      el("timer").classList.remove("hidden");
    } else {
      el("lobby-view").classList.remove("hidden");
      el("game-view").classList.add("hidden");
      el("timer").classList.add("hidden");
    }
  }

  function initHistory() {
    if (history.state && history.state.view) {
      respectExistingView = true;
      renderView(history.state.view === "game" ? "game" : "lobby");
    } else {
      history.replaceState({ view: "lobby" }, "", location.pathname + location.search);
      renderView("lobby");
    }
  }
  function showLobby() {
    if (currentView !== "lobby") history.pushState({ view: "lobby" }, "", location.pathname + location.search);
    renderView("lobby");
  }
  function showGame() {
    if (currentView !== "game") history.pushState({ view: "game" }, "", location.pathname + location.search);
    renderView("game");
  }

  window.addEventListener("popstate", (e) => {
    const view = (e.state && e.state.view) || "lobby";
    renderView(view);
  });

  // ---------------------------------------------------------------------
  // Lobby rendering
  // ---------------------------------------------------------------------
  function renderPlayers(players) {
    const ul = el("player-list");
    ul.innerHTML = "";
    players.forEach((p) => {
      const li = document.createElement("li");
      if (!p.connected) li.classList.add("player-offline");
      const dot = document.createElement("span");
      dot.className = "player-dot";
      dot.style.background = p.color;
      li.appendChild(dot);
      const label = document.createElement("span");
      label.textContent = p.name + (p.id === playerId ? " (вы)" : "");
      li.appendChild(label);
      if (p.id === lastState?.hostPlayer) {
        const badge = document.createElement("span");
        badge.className = "player-badge";
        badge.textContent = "хост";
        li.appendChild(badge);
      }
      ul.appendChild(li);
    });
  }

  // Source pixels a piece needs to still look reasonably sharp once drawn
  // at typical on-screen sizes. Below this, upscaling a low-res photo into
  // too many pieces is what actually causes the blur -- no amount of
  // client-side smoothing can put detail back that was never captured.
  const MIN_PX_PER_PIECE = 15000; // ~122x122
  let previewImgW = 0, previewImgH = 0;

  function renderPreview(imageUrl) {
    const img = el("preview-img");
    const empty = el("preview-empty");
    if (imageUrl) {
      img.onload = () => {
        previewImgW = img.naturalWidth;
        previewImgH = img.naturalHeight;
        if (lastState) renderDifficulty(lastState.rows, lastState.cols);
      };
      img.src = imageUrl;
      img.classList.remove("hidden");
      empty.classList.add("hidden");
    } else {
      previewImgW = previewImgH = 0;
      img.classList.add("hidden");
      empty.classList.remove("hidden");
    }
  }

  function renderDifficulty(rows, cols) {
    document.querySelectorAll(".diff-btn").forEach((btn) => {
      const [r, c] = DIFFICULTIES[btn.dataset.diff];
      btn.classList.toggle("active", r === rows && c === cols);
    });
    el("diff-current").textContent = `Текущий размер: ${cols} × ${rows} = ${rows * cols} кусочков`;

    const hint = el("quality-hint");
    if (previewImgW && previewImgH) {
      const pxPerPiece = (previewImgW * previewImgH) / (rows * cols);
      if (pxPerPiece < MIN_PX_PER_PIECE) {
        const maxPieces = Math.floor((previewImgW * previewImgH) / MIN_PX_PER_PIECE);
        const fits = Object.entries(DIFFICULTIES)
          .filter(([, [r, c]]) => r * c <= Math.max(maxPieces, 6))
          .map(([key]) => ({ easy: "Легко", medium: "Средне", hard: "Сложно", extreme: "Оч. сложно" }[key]));
        hint.textContent = fits.length
          ? `Картинка маловата для такой сложности — кусочки будут размытыми. Лучше подойдёт: ${fits.join(", ")}.`
          : "Картинка совсем небольшая — кусочки будут выглядеть размыто на любой сложности.";
        hint.classList.remove("hidden");
      } else {
        hint.classList.add("hidden");
      }
    } else {
      hint.classList.add("hidden");
    }
  }

  function updateHostUI(state) {
    const hostControls = el("host-controls");
    const guestHint = el("guest-hint");
    isHost = state.hostPlayer === playerId;
    hostControls.classList.toggle("hidden", !isHost);
    guestHint.classList.toggle("hidden", isHost);
    el("start-btn").disabled = !state.image;
    el("start-btn").textContent = state.started ? "Начать заново" : "Начать игру";
  }

  let lastState = null;

  // ---------------------------------------------------------------------
  // Socket setup
  // ---------------------------------------------------------------------
  const socket = io();

  socket.on("connect", () => {
    socket.emit("join_lobby", { room: ROOM_CODE, name: playerName, player_id: playerId });
  });

  socket.on("lobby_error", (data) => showToast(data.message));

  socket.on("lobby_state", (state) => {
    lastState = state;
    started = state.started;
    renderPlayers(state.players);
    renderPreview(state.image);
    renderDifficulty(state.rows, state.cols);
    updateHostUI(state);
  });

  socket.on("image_updated", (data) => renderPreview(data.image));

  socket.on("game_started", (payload) => {
    gameAvailable = true;
    game.load(payload);
    if (currentView === "game") {
      // Already showing the game (e.g. the host restarted it) -- just
      // refresh, no history change needed.
      renderView("game");
    } else if (respectExistingView) {
      // We landed here via Back/Forward/reload onto a history entry that
      // was already tagged "lobby" -- respect that even though the server
      // says the game is live. The data is ready; the user gets to the
      // game view by navigating Forward (or clicking "Начать игру").
      renderView(currentView);
    } else {
      // Fresh join: either watching the lobby as it starts, or opening a
      // link straight into an already-live game with no view to respect.
      showGame();
    }
  });

  socket.on("piece_held", (data) => game.onPieceHeld(data));
  socket.on("piece_moved", (data) => game.onPieceMoved(data));
  socket.on("piece_updated", (data) => game.onPieceUpdated(data));
  socket.on("piece_released_all", (data) => game.onPlayerReleasedAll(data.player));
  socket.on("puzzle_solved", (data) => showSolved(data.elapsed));

  // ---------------------------------------------------------------------
  // Lobby controls
  // ---------------------------------------------------------------------
  el("file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("image", file);
    fd.append("player_id", playerId);
    try {
      const res = await fetch(`/api/rooms/${ROOM_CODE}/upload`, { method: "POST", body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error === "invalid_image" ? "Файл не похож на картинку" : "Не удалось загрузить картинку");
      }
    } catch (err) {
      showToast("Ошибка сети при загрузке");
    }
    e.target.value = "";
  });

  document.querySelectorAll(".diff-btn").forEach((btn) => {
    btn.addEventListener("click", () => socket.emit("set_options", { difficulty: btn.dataset.diff }));
  });

  el("start-btn").addEventListener("click", () => socket.emit("start_game", {}));
  el("back-to-lobby-btn").addEventListener("click", () => history.back());

  el("copy-link-btn").addEventListener("click", () => {
    const link = window.location.origin + "/room/" + ROOM_CODE;
    navigator.clipboard.writeText(link).then(
      () => showToast("Ссылка скопирована"),
      () => showToast(link)
    );
  });

  el("solved-close-btn").addEventListener("click", () => el("solved-overlay").classList.add("hidden"));

  let solvedAt = null;
  function showSolved(elapsed) {
    solvedAt = elapsed;
    const mins = Math.floor(elapsed / 60);
    const secs = Math.floor(elapsed % 60);
    el("solved-time").textContent = `Время сборки: ${mins} мин ${secs.toString().padStart(2, "0")} сек`;
    el("solved-overlay").classList.remove("hidden");
  }

  // ---------------------------------------------------------------------
  // Timer display while playing
  // ---------------------------------------------------------------------
  let gameStartedAt = null;
  setInterval(() => {
    const timerEl = el("timer");
    if (!started || timerEl.classList.contains("hidden") || !gameStartedAt) return;
    const elapsed = (Date.now() - gameStartedAt) / 1000;
    const mins = Math.floor(elapsed / 60);
    const secs = Math.floor(elapsed % 60);
    timerEl.textContent = `⏱ ${mins}:${secs.toString().padStart(2, "0")}`;
  }, 500);

  // ---------------------------------------------------------------------
  // Puzzle game (canvas)
  // ---------------------------------------------------------------------
  const game = createGame(el("board"));

  function createGame(canvas) {
    const ctx = canvas.getContext("2d");
    // Default quality is "low" in most browsers -- "high" gives noticeably
    // smoother results when a piece is drawn larger than its native pixels
    // (small source photos, or zooming in), at a cost that's irrelevant for
    // a canvas this size. Reapplied in render() too, since resizing the
    // canvas resets the whole 2D context state.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    let payload = null;
    let pieces = new Map();
    let order = [];
    let localPaths = new Map();
    let sprites = new Map();
    let img = null;

    let scale = 1, offsetX = 0, offsetY = 0;
    let viewW = 0, viewH = 0; // last rendered canvas CSS size, for drag bounds
    let dragging = null;
    let activePointerId = null;
    let lastMoveEmit = 0;

    function colorFor(pid) {
      if (!lastState) return "#888";
      const p = lastState.players.find((pp) => pp.id === pid);
      return p ? p.color : "#888";
    }

    function tabSizeFor(pw, ph) {
      return Math.min(pw, ph) * 0.28;
    }

    // Classic mushroom-shaped jigsaw tab: a round head on a narrower neck,
    // built from two lines tangent to the head circle so the neck flares
    // smoothly into the round bulb (no visible seam at the tangent point).
    const ARC_SAMPLES = 16;

    function edgePoints(length, sign, jitter, tabSize) {
      if (!sign) return [[0, 0], [length, 0]];

      const center = length * (0.5 + jitter);
      const R = tabSize * 0.5; // head (bulb) radius
      const D = R * 1.0; // baseline -> bulb center distance
      const neckHalf = R * 0.42; // half-width of the neck opening

      const cx = center, cy = D;
      const qLeft = [center - neckHalf, 0];
      const qRight = [center + neckHalf, 0];

      function tangent(q) {
        const dx = q[0] - cx, dy = q[1] - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const phiCQ = Math.atan2(dy, dx); // angle from center to q
        const beta = Math.acos(Math.min(1, R / d));
        const a1 = phiCQ + beta, a2 = phiCQ - beta;
        const t1 = [cx + R * Math.cos(a1), cy + R * Math.sin(a1)];
        const t2 = [cx + R * Math.cos(a2), cy + R * Math.sin(a2)];
        return { t1, a1, t2, a2 };
      }

      const left = tangent(qLeft);
      const right = tangent(qRight);
      // pick the outer tangent point on each side (further from centerline)
      const tLeft = left.t1[0] <= left.t2[0] ? left.t1 : left.t2;
      const aLeft = left.t1[0] <= left.t2[0] ? left.a1 : left.a2;
      const tRight = right.t1[0] >= right.t2[0] ? right.t1 : right.t2;
      const aRight = right.t1[0] >= right.t2[0] ? right.a1 : right.a2;

      // sweep the arc from tLeft to tRight through the apex (angle = +90deg)
      const wrap = (a) => {
        while (a <= -Math.PI) a += 2 * Math.PI;
        while (a > Math.PI) a -= 2 * Math.PI;
        return a;
      };
      const apex = Math.PI / 2;
      let delta = wrap(aRight - aLeft);
      const deltaAlt = delta > 0 ? delta - 2 * Math.PI : delta + 2 * Math.PI;
      const mid = wrap(aLeft + delta / 2 - apex);
      const midAlt = wrap(aLeft + deltaAlt / 2 - apex);
      const sweep = Math.abs(mid) <= Math.abs(midAlt) ? delta : deltaAlt;

      const arcPts = [];
      for (let i = 1; i < ARC_SAMPLES; i++) {
        const a = aLeft + (sweep * i) / ARC_SAMPLES;
        arcPts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
      }

      const pts = [[0, 0], qLeft, tLeft, ...arcPts, tRight, qRight, [length, 0]];
      return pts.map(([t, perp]) => [t, perp * sign]);
    }

    function buildLocalPath(row, col) {
      const { rows, cols, pieceW: pw, pieceH: ph, edgesV, edgesH } = payload;
      const tabSize = tabSizeFor(pw, ph);

      const topPts = row === 0
        ? [[0, 0], [pw, 0]]
        : edgePoints(pw, edgesH[row - 1][col][0], edgesH[row - 1][col][1], tabSize);
      const rightPts = col === cols - 1
        ? [[0, 0], [ph, 0]]
        : edgePoints(ph, edgesV[row][col][0], edgesV[row][col][1], tabSize);
      const bottomPts = row === rows - 1
        ? [[0, 0], [pw, 0]]
        : edgePoints(pw, edgesH[row][col][0], edgesH[row][col][1], tabSize);
      const leftPts = col === 0
        ? [[0, 0], [ph, 0]]
        : edgePoints(ph, edgesV[row][col - 1][0], edgesV[row][col - 1][1], tabSize);

      // Map each edge's (t, perp) breakpoints into this piece's local (x, y)
      // space, in correct traversal order (clockwise winding: top, right,
      // bottom, left). Corner points (shared with neighboring pieces) land
      // exactly on the grid lines; only the interior tab points get rounded.
      const topMapped = topPts.map(([t, perp]) => [t, perp]);
      const rightMapped = rightPts.map(([t, perp]) => [pw + perp, t]);
      const bottomMapped = bottomPts.slice().reverse().map(([t, perp]) => [t, ph + perp]);
      const leftMapped = leftPts.slice().reverse().map(([t, perp]) => [perp, t]);

      const path = new Path2D();
      path.moveTo(topMapped[0][0], topMapped[0][1]);
      appendSmoothed(path, topMapped);
      appendSmoothed(path, rightMapped);
      appendSmoothed(path, bottomMapped);
      appendSmoothed(path, leftMapped);
      path.closePath();

      return { path, margin: tabSize };
    }

    // Draws from the path's current position (assumed to equal pts[0])
    // through pts, rounding every interior point with a quadratic curve
    // while keeping pts[0] and pts[last] exact -- so pieces still share
    // perfectly matching seams, but the tab corners look smooth.
    function appendSmoothed(path, pts) {
      const n = pts.length;
      if (n < 3) {
        for (let i = 1; i < n; i++) path.lineTo(pts[i][0], pts[i][1]);
        return;
      }
      for (let i = 1; i < n - 1; i++) {
        const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
        path.quadraticCurveTo(pts[i][0], pts[i][1], mid[0], mid[1]);
      }
      path.lineTo(pts[n - 1][0], pts[n - 1][1]);
    }

    function buildSprite(id, row, col) {
      const { pieceW: pw, pieceH: ph } = payload;
      const { path, margin } = localPaths.get(id);
      const w = Math.ceil(pw + margin * 2);
      const h = Math.ceil(ph + margin * 2);
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const octx = off.getContext("2d");
      octx.save();
      octx.translate(margin, margin);
      octx.clip(path);
      octx.drawImage(img, -(col * pw), -(row * ph));
      octx.restore();
      octx.save();
      octx.translate(margin, margin);
      octx.lineWidth = 1.5;
      octx.strokeStyle = "rgba(0,0,0,0.28)";
      octx.stroke(path);
      octx.restore();
      sprites.set(id, { canvas: off, w, h, margin });
    }

    function load(pl) {
      payload = pl;
      pieces.clear();
      order = [];
      sprites.clear();
      localPaths.clear();
      dragging = null;
      // Use the server's authoritative start time (seconds since epoch)
      // rather than "now" on this client -- otherwise a player who joins
      // or reconnects mid-game sees the timer start over from 0:00 instead
      // of showing the real elapsed time.
      gameStartedAt = pl.startTime ? pl.startTime * 1000 : Date.now();

      pl.pieces.forEach((p) => {
        pieces.set(p.id, Object.assign({}, p));
        order.push(p.id);
      });

      img = new Image();
      img.onload = () => {
        pl.pieces.forEach((p) => localPaths.set(p.id, buildLocalPath(p.row, p.col)));
        pl.pieces.forEach((p) => buildSprite(p.id, p.row, p.col));
        updateProgress();
      };
      img.src = pl.image;
    }

    function updateProgress() {
      let locked = 0;
      pieces.forEach((p) => { if (p.locked) locked++; });
      el("progress-label").textContent = `Собрано: ${locked} / ${pieces.size}`;
    }

    function bringToFront(id) {
      const idx = order.indexOf(id);
      if (idx >= 0) {
        order.splice(idx, 1);
        order.push(id);
      }
    }

    function computeLayout(cw, ch) {
      if (!payload) return;
      const tw = payload.scatterW, th = payload.scatterH;
      const pad = 24;
      const availW = Math.max(cw - pad * 2, 10);
      const availH = Math.max(ch - pad * 2, 10);
      scale = Math.min(availW / tw, availH / th);
      if (!isFinite(scale) || scale <= 0) scale = 1;
      offsetX = (cw - tw * scale) / 2;
      offsetY = (ch - th * scale) / 2;
    }

    function render() {
      const rect = canvas.getBoundingClientRect();
      viewW = rect.width;
      viewH = rect.height;
      const pw = Math.max(1, Math.round(rect.width * DPR));
      const ph = Math.max(1, Math.round(rect.height * DPR));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
        // Resizing a canvas resets its whole 2D context state, including
        // imageSmoothingQuality -- reapply it every time this happens.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
      }
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      if (payload) {
        computeLayout(rect.width, rect.height);

        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(offsetX, offsetY, payload.imageW * scale, payload.imageH * scale);
        ctx.restore();

        for (const id of order) {
          const p = pieces.get(id);
          const sprite = sprites.get(id);
          if (!p || !sprite) continue;
          const sx = offsetX + (p.x - sprite.margin) * scale;
          const sy = offsetY + (p.y - sprite.margin) * scale;
          const sw = sprite.w * scale, sh = sprite.h * scale;
          ctx.drawImage(sprite.canvas, sx, sy, sw, sh);
          if (p.holder) {
            ctx.save();
            ctx.strokeStyle = colorFor(p.holder);
            ctx.lineWidth = 3;
            ctx.strokeRect(sx + 2, sy + 2, sw - 4, sh - 4);
            ctx.restore();
          }
        }
      }

      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);

    function hitTest(cx, cy) {
      // isPointInPath() interprets both the query point and the path
      // through the context's CURRENT transform. render() leaves the
      // transform at [DPR,0,0,DPR,0,0] (CSS px -> device px) from the last
      // frame, but cx/cy and our test paths are in CSS-pixel space -- so on
      // any screen with devicePixelRatio > 1 (basically every phone) the
      // point would get scaled by DPR again and miss the piece entirely.
      // Reset to identity so both sides are compared in the same units.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i];
        const p = pieces.get(id);
        if (!p || p.locked) continue;
        const lp = localPaths.get(id);
        if (!lp) continue;
        const m = new DOMMatrix().translate(offsetX + p.x * scale, offsetY + p.y * scale).scale(scale, scale);
        const testPath = new Path2D();
        testPath.addPath(lp.path, m);
        if (ctx.isPointInPath(testPath, cx, cy)) return id;
      }
      return null;
    }

    function clientToCanvas(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return { cx: clientX - rect.left, cy: clientY - rect.top };
    }

    canvas.addEventListener("pointerdown", (e) => {
      if (!payload) return;
      const { cx, cy } = clientToCanvas(e.clientX, e.clientY);
      const id = hitTest(cx, cy);
      if (id == null) return;
      const p = pieces.get(id);
      const px = (cx - offsetX) / scale;
      const py = (cy - offsetY) / scale;
      dragging = { id, offX: px - p.x, offY: py - p.y };
      activePointerId = e.pointerId;
      canvas.setPointerCapture(activePointerId);
      canvas.style.cursor = "grabbing";
      bringToFront(id);
      socket.emit("pickup_piece", { id });
      e.preventDefault();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!dragging || e.pointerId !== activePointerId) return;
      const { cx, cy } = clientToCanvas(e.clientX, e.clientY);
      const p = pieces.get(dragging.id);
      if (!p) return;
      const rawX = (cx - offsetX) / scale - dragging.offX;
      const rawY = (cy - offsetY) / scale - dragging.offY;
      // Keep the piece from being dragged off the visible canvas -- a fixed
      // margin in puzzle-space isn't enough, because once multiplied by the
      // current zoom `scale` it can be smaller than the actual letterbox
      // gap around the board, letting the piece slip past the checkered
      // area entirely. Clamp in screen space instead (at least half the
      // piece must stay within the canvas's own on-screen bounds), then
      // convert back -- this always matches what's actually visible,
      // whatever the scale or aspect ratio.
      const halfW = (payload.pieceW * scale) / 2;
      const halfH = (payload.pieceH * scale) / 2;
      const minX = (-halfW - offsetX) / scale;
      const minY = (-halfH - offsetY) / scale;
      const maxX = (viewW + halfW - offsetX) / scale - payload.pieceW;
      const maxY = (viewH + halfH - offsetY) / scale - payload.pieceH;
      p.x = Math.min(Math.max(rawX, minX), maxX);
      p.y = Math.min(Math.max(rawY, minY), maxY);
      const now = performance.now();
      if (now - lastMoveEmit > 40) {
        lastMoveEmit = now;
        socket.emit("move_piece", { id: dragging.id, x: p.x, y: p.y });
      }
    });

    function endDrag() {
      if (!dragging) return;
      const p = pieces.get(dragging.id);
      if (p) socket.emit("drop_piece", { id: dragging.id, x: p.x, y: p.y });
      dragging = null;
      activePointerId = null;
      canvas.style.cursor = "grab";
    }
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    return {
      load,
      onPieceHeld({ id, holder }) {
        const p = pieces.get(id);
        if (!p) return;
        p.holder = holder;
        bringToFront(id);
      },
      onPieceMoved({ id, x, y }) {
        if (dragging && dragging.id === id) return;
        const p = pieces.get(id);
        if (!p) return;
        p.x = x;
        p.y = y;
      },
      onPieceUpdated(data) {
        const p = pieces.get(data.id);
        if (!p) return;
        Object.assign(p, data);
        updateProgress();
      },
      onPlayerReleasedAll(pid) {
        pieces.forEach((p) => {
          if (p.holder === pid) p.holder = null;
        });
      },
    };
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  initHistory();
  ensureName(() => {
    if (socket.connected) {
      socket.emit("join_lobby", { room: ROOM_CODE, name: playerName, player_id: playerId });
    }
  });
})();
