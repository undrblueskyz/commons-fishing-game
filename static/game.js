// =====================================================
// Commons Fishing Game — Red/Blue Sorting + Swimming Fish
// UX fix: after Submit, remove caught fish + lock input until next round updates
// =====================================================

let ws = null;
let currentState = null;

const joinDiv = document.getElementById("join");
const gameDiv = document.getElementById("game");
const joinMsg = document.getElementById("joinMsg");

const roomInput = document.getElementById("room");
const nameInput = document.getElementById("name");
const joinBtn = document.getElementById("joinBtn");

const roomLabel = document.getElementById("roomLabel");
const roundLabel = document.getElementById("roundLabel");
const stockLabel = document.getElementById("stockLabel");
const playersLabel = document.getElementById("playersLabel");
const maxPer = document.getElementById("maxPer");
const tokenValueEl = document.getElementById("tokenValue");
const catchNowEl = document.getElementById("catchNow");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const submitBtn = document.getElementById("submitBtn");
const endDiv = document.getElementById("end");
const leaderboardEl = document.getElementById("leaderboard");

const canvas = document.getElementById("pond");
const ctx = canvas.getContext("2d");

let fishTokens = [];
let dragging = null;

let inputLocked = false;        // lock after submit until next round update
let lastRoundRendered = null;

const redNet = { x: 610, y: 90,  w: 220, h: 130 };
const blueNet = { x: 610, y: 250, w: 220, h: 130 };

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function resetBoard(stock, maxHarvest) {
  fishTokens = [];
  dragging = null;
  inputLocked = false;

  const displayCount = Math.min(30, stock);
  const tokenValue = Math.max(1, Math.ceil(stock / Math.max(1, displayCount)));
  tokenValueEl.textContent = tokenValue;

  const spawn = Math.min(displayCount, maxHarvest);

  for (let i = 0; i < spawn; i++) {
    fishTokens.push({
      id: i,
      x: 70 + (i % 10) * 55,
      y: 70 + Math.floor(i / 10) * 55,
      r: 16,
      color: i % 2 === 0 ? "red" : "blue",
      inRed: false,
      inBlue: false,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6
    });
  }

  updateCatchNow();
  draw();
}

function drawRoundedRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.font = "16px system-ui";
  ctx.fillStyle = "black";
  ctx.fillText("Pond", 16, 24);

  // Red net
  ctx.fillStyle = "rgba(255,0,0,0.15)";
  drawRoundedRect(redNet.x, redNet.y, redNet.w, redNet.h, 14);
  ctx.fill();
  ctx.strokeStyle = "black";
  ctx.stroke();
  ctx.fillStyle = "black";
  ctx.fillText("Red Net", redNet.x + 10, redNet.y + 20);

  // Blue net
  ctx.fillStyle = "rgba(0,0,255,0.15)";
  drawRoundedRect(blueNet.x, blueNet.y, blueNet.w, blueNet.h, 14);
  ctx.fill();
  ctx.strokeStyle = "black";
  ctx.stroke();
  ctx.fillStyle = "black";
  ctx.fillText("Blue Net", blueNet.x + 10, blueNet.y + 20);

  // Fish
  for (const f of fishTokens) {
    ctx.beginPath();
    ctx.fillStyle = f.color;   // red/blue
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "black";
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(f.x + f.r, f.y);
    ctx.lineTo(f.x + f.r + 10, f.y - 6);
    ctx.lineTo(f.x + f.r + 10, f.y + 6);
    ctx.closePath();
    ctx.fill();
  }

  ctx.font = "14px system-ui";
  ctx.fillStyle = "black";
  ctx.fillText(inputLocked ? "Waiting for the round to resolve…" : "Sort fish into the matching net, then Submit.", 16, canvas.height - 16);
}

function animateFish() {
  for (const f of fishTokens) {
    if (dragging && dragging.fish === f) continue;
    // Don't animate fish once input locked (keeps the “submitted” state calm)
    if (inputLocked) continue;

    f.x += f.vx;
    f.y += f.vy;

    if (f.x < 30 || f.x > 560) f.vx *= -1;
    if (f.y < 40 || f.y > 380) f.vy *= -1;
  }

  draw();
  requestAnimationFrame(animateFish);
}

function updateCatchNow() {
  const tokenValue = parseInt(tokenValueEl.textContent, 10) || 1;
  const correct = fishTokens.filter(f =>
    (f.color === "red" && f.inRed) ||
    (f.color === "blue" && f.inBlue)
  ).length;
  catchNowEl.textContent = correct * tokenValue;
}

function hitFish(mx, my) {
  for (let i = fishTokens.length - 1; i >= 0; i--) {
    const f = fishTokens[i];
    const dx = mx - f.x;
    const dy = my - f.y;
    if (Math.sqrt(dx * dx + dy * dy) <= f.r + 2) return f;
  }
  return null;
}

function inRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

canvas.addEventListener("mousedown", e => {
  if (inputLocked) return;
  const rect = canvas.getBoundingClientRect();
  const f = hitFish(e.clientX - rect.left, e.clientY - rect.top);
  if (f) dragging = { fish: f };
});

canvas.addEventListener("mousemove", e => {
  if (!dragging || inputLocked) return;
  const rect = canvas.getBoundingClientRect();
  dragging.fish.x = e.clientX - rect.left;
  dragging.fish.y = e.clientY - rect.top;
  draw();
});

canvas.addEventListener("mouseup", () => {
  if (!dragging) return;
  const f = dragging.fish;
  f.inRed = inRect(f.x, f.y, redNet);
  f.inBlue = inRect(f.x, f.y, blueNet);
  dragging = null;
  updateCatchNow();
  draw();
});

function renderState(state) {
  currentState = state;

  roomLabel.textContent = state.room_code;
  roundLabel.textContent = `${state.round_num} / ${state.rounds_total}`;
  stockLabel.textContent = state.stock;
  maxPer.textContent = state.max_harvest_per_player;

  const submitted = new Set(state.submitted || []);
  playersLabel.textContent =
    (state.players || []).map(p =>
      `${p.name}${submitted.has(p.player_id) ? " ✓" : ""}`
    ).join(", ");

  // Status + results
  if (!state.started) {
    statusEl.textContent = "Waiting for players…";
    submitBtn.disabled = true;
  } else if (state.finished) {
    statusEl.textContent = "Finished.";
    submitBtn.disabled = true;
  } else if (inputLocked) {
    statusEl.textContent = "Submitted — waiting for the global pond to resolve…";
    submitBtn.disabled = true;
  } else {
    statusEl.textContent = "Sort fish and submit.";
    submitBtn.disabled = false;
  }

  // Show a little more feedback AFTER a round resolves (remaining/next_stock come from server)
  if (state.last_round_results) {
    const r = state.last_round_results;
    const parts = [];
    parts.push(`<div><b>Last round:</b></div>`);
    parts.push(`<div>Your room harvested: <b>${r.harvested_total}</b></div>`);
    if (r.remaining !== null && r.remaining !== undefined) {
      parts.push(`<div>Commons remaining (all rooms): <b>${r.remaining}</b></div>`);
    }
    if (r.next_stock !== null && r.next_stock !== undefined) {
      parts.push(`<div>Next commons stock: <b>${r.next_stock}</b></div>`);
    }
    resultsEl.innerHTML = parts.join("");
  } else {
    resultsEl.innerHTML = "";
  }

  // IMPORTANT: Only reset fish board when the ROUND changes (global pond advanced).
  if (lastRoundRendered !== state.round_num) {
    lastRoundRendered = state.round_num;
    resetBoard(state.stock, state.max_harvest_per_player);

    if (!window._swimmingStarted) {
      window._swimmingStarted = true;
      requestAnimationFrame(animateFish);
    }
  }

  // Leaderboard (end)
  if (state.finished) {
    endDiv.classList.remove("hidden");
    const nameById = {};
    for (const p of state.players || []) nameById[p.player_id] = p.name;

    const entries = Object.entries(state.totals || {})
      .map(([pid, tot]) => ({ name: nameById[pid] || pid, tot }))
      .sort((a, b) => b.tot - a.tot);

    leaderboardEl.innerHTML = entries
      .map((e, i) => `<div>${i + 1}. <b>${e.name}</b>: ${e.tot}</div>`)
      .join("");
  } else {
    endDiv.classList.add("hidden");
  }
}

function connectAndJoin(room, name) {
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", room_code: room, name }));
  };

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === "joined") {
      joinDiv.classList.add("hidden");
      gameDiv.classList.remove("hidden");
    } else if (msg.type === "state") {
      renderState(msg.state);
    } else if (msg.type === "error") {
      statusEl.textContent = msg.message;
      joinMsg.textContent = msg.message;
    }
  };
}

joinBtn.onclick = () => {
  const room = roomInput.value.trim();
  const name = nameInput.value.trim();
  if (!room || !name) {
    joinMsg.textContent = "Enter a room code and your name.";
    return;
  }
  connectAndJoin(room, name);
};

submitBtn.onclick = () => {
  if (!currentState || !currentState.started || currentState.finished) return;
  if (inputLocked) return;

  const tokenValue = parseInt(tokenValueEl.textContent, 10) || 1;

  // Correctly sorted fish count
  const correctFish = fishTokens.filter(f =>
    (f.color === "red" && f.inRed) ||
    (f.color === "blue" && f.inBlue)
  );

  const harvest = correctFish.length * tokenValue;

  // UX: immediately remove the caught fish from view + lock
  inputLocked = true;
  // Remove correctly sorted fish from the pond so it feels like harvesting
  fishTokens = fishTokens.filter(f => !correctFish.includes(f));
  updateCatchNow();
  draw();

  ws.send(JSON.stringify({ type: "submit", harvest }));
  statusEl.textContent = "Submitted — waiting for the global pond to resolve…";
  submitBtn.disabled = true;
};
