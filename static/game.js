// Drag-into-net fishing UI + WebSocket room sync.
// Gamey tweak: two nets + two fish colors (red/blue). Only correctly sorted fish count.

let ws = null;
let playerId = null;
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

// Two nets to add “sorting” distraction.
let redNet = { x: 620, y: 90,  w: 210, h: 130 };
let blueNet = { x: 620, y: 250, w: 210, h: 130 };

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

// --- Utility drawing helpers (no fancy dependencies) ---
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

function inRect(mx, my, rect) {
  return (mx >= rect.x && mx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h);
}

function resetBoard(stock, maxHarvest) {
  fishTokens = [];

  // Display up to 30 “tokens” in the pond; each token represents tokenValue fish.
  const displayCount = Math.min(30, stock);
  const tokenValue = Math.max(1, Math.ceil(stock / Math.max(1, displayCount)));
  tokenValueEl.textContent = tokenValue;

  // Spawn tokens up to maxHarvest for “game feel”
  const tokensToSpawn = Math.min(maxHarvest, displayCount);

  for (let i = 0; i < tokensToSpawn; i++) {
    const color = (i % 2 === 0) ? "red" : "blue"; // simple alternating colors
    fishTokens.push({
      id: i,
      x: 70 + (i % 10) * 55,
      y: 70 + Math.floor(i / 10) * 55,
      r: 16,
      color,          // "red" or "blue"
      inRed: false,
      inBlue: false
    });
  }

  updateCatchNow();
  draw();
}

function updateCatchNow() {
  const tokenValue = parseInt(tokenValueEl.textContent, 10) || 1;

  // Only correctly sorted fish count:
  // - red fish must be in red net
  // - blue fish must be in blue net
  const correctCount = fishTokens.filter(f =>
    (f.color === "red" && f.inRed) || (f.color === "blue" && f.inBlue)
  ).length;

  catchNowEl.textContent = correctCount * tokenValue;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background label
  ctx.font = "16px system-ui";
  ctx.fillText("Pond", 16, 24);

  // Nets (gamey UI)
  // Red net
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = "red";
  drawRoundedRect(redNet.x, redNet.y, redNet.w, redNet.h, 14);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = "black";
  drawRoundedRect(redNet.x, redNet.y, redNet.w, redNet.h, 14);
  ctx.stroke();

  ctx.font = "14px system-ui";
  ctx.fillText("Red Net", redNet.x + 10, redNet.y + 20);
  ctx.font = "12px system-ui";
  ctx.fillText("Drop red fish here", redNet.x + 10, redNet.y + 40);

  // Blue net
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = "blue";
  drawRoundedRect(blueNet.x, blueNet.y, blueNet.w, blueNet.h, 14);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = "black";
  drawRoundedRect(blueNet.x, blueNet.y, blueNet.w, blueNet.h, 14);
  ctx.stroke();

  ctx.font = "14px system-ui";
  ctx.fillText("Blue Net", blueNet.x + 10, blueNet.y + 20);
  ctx.font = "12px system-ui";
  ctx.fillText("Drop blue fish here", blueNet.x + 10, blueNet.y + 40);

  // Fish tokens
  for (const f of fishTokens) {
    // fish body
    ctx.beginPath();
    ctx.fillStyle = (f.color === "red") ? "red" : "blue";
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "black";
    ctx.stroke();

    // tail
    ctx.beginPath();
    ctx.moveTo(f.x + f.r, f.y);
    ctx.lineTo(f.x + f.r + 10, f.y - 6);
    ctx.lineTo(f.x + f.r + 10, f.y + 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Bottom instruction (kept “gamey”)
  ctx.font = "14px system-ui";
  ctx.fillStyle = "black";
  ctx.fillText("Drag fish into the correct net, then Submit.", 16, canvas.height - 16);
}

function hitFish(mx, my) {
  for (let i = fishTokens.length - 1; i >= 0; i--) {
    const f = fishTokens[i];
    const dx = mx - f.x, dy = my - f.y;
    if (Math.sqrt(dx * dx + dy * dy) <= f.r + 2) return f;
  }
  return null;
}

function placeFishInNets(f) {
  // Clear prior net state
  f.inRed = false;
  f.inBlue = false;

  if (inRect(f.x, f.y, redNet)) f.inRed = true;
  if (inRect(f.x, f.y, blueNet)) f.inBlue = true;

  // If fish overlaps both (rare), keep the one it overlaps more by preference:
  if (f.inRed && f.inBlue) {
    // Simple tie-breaker: whichever net center is closer
    const rcx = redNet.x + redNet.w / 2, rcy = redNet.y + redNet.h / 2;
    const bcx = blueNet.x + blueNet.w / 2, bcy = blueNet.y + blueNet.h / 2;
    const dr = (f.x - rcx) ** 2 + (f.y - rcy) ** 2;
    const db = (f.x - bcx) ** 2 + (f.y - bcy) ** 2;
    if (dr <= db) f.inBlue = false;
    else f.inRed = false;
  }
}

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const f = hitFish(mx, my);
  if (f) dragging = { fish: f, ox: mx - f.x, oy: my - f.y };
});

canvas.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  dragging.fish.x = mx - dragging.ox;
  dragging.fish.y = my - dragging.oy;
  draw();
});

function dropFish() {
  if (!dragging) return;
  placeFishInNets(dragging.fish);
  dragging = null;
  updateCatchNow();
  draw();
}

canvas.addEventListener("mouseup", dropFish);
canvas.addEventListener("mouseleave", dropFish);

// --------------------
// Rendering game state
// --------------------
function renderState(state) {
  currentState = state;

  roomLabel.textContent = state.room_code;
  roundLabel.textContent = `${state.round_num} / ${state.rounds_total}`;
  stockLabel.textContent = state.stock;
  maxPer.textContent = state.max_harvest_per_player;

  const submitted = new Set(state.submitted || []);
  const players = (state.players || []).map(p => `${p.name}${submitted.has(p.player_id) ? " ✓" : ""}`);
  playersLabel.textContent = players.join(", ");

  const minP = state.min_players_to_start || 2;
  const maxP = state.max_players_per_room || 4;

  if (!state.started) {
    statusEl.textContent = `Waiting for at least ${minP} players… (${(state.players || []).length}/${maxP})`;
    submitBtn.disabled = true;
  } else if (state.finished) {
    statusEl.textContent = `Finished.`;
    submitBtn.disabled = true;
  } else {
    statusEl.textContent = `Sort your catch and submit.`;
    submitBtn.disabled = false;
  }

  // Keep results minimal so it doesn't “teach the trick” too early
  if (state.last_round_results) {
    const r = state.last_round_results;
    const lines = [];
    lines.push(`<div><b>Last round:</b></div>`);
    lines.push(`<div>Total harvested: <b>${r.harvested_total}</b>, Remaining: <b>${r.remaining ?? "?"}</b></div>`);
    resultsEl.innerHTML = lines.join("");
  } else {
    resultsEl.innerHTML = "";
  }

  // Reset the board each round for that “fresh pond” feeling
  if (window._lastRenderedRound !== state.round_num) {
    window._lastRenderedRound = state.round_num;
    resetBoard(state.stock, state.max_harvest_per_player);
  }

  // Leaderboard at end
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

// --------------------
// WebSocket connection
// --------------------
function connectAndJoin(room, name) {
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", room_code: room, name }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "joined") {
      playerId = msg.player_id;
      joinMsg.textContent = "";
      joinDiv.classList.add("hidden");
      gameDiv.classList.remove("hidden");
    } else if (msg.type === "state") {
      renderState(msg.state);
    } else if (msg.type === "error") {
      statusEl.textContent = msg.message;
      joinMsg.textContent = msg.message;
    }
  };

  ws.onclose = () => {
    // auto-reconnect
    statusEl.textContent = "Disconnected. Reconnecting…";
    setTimeout(() => connectAndJoin(room, name), 1200);
  };
}

joinBtn.addEventListener("click", () => {
  const room = roomInput.value.trim();
  const name = nameInput.value.trim();
  if (!room || !name) {
    joinMsg.textContent = "Enter a room code and your name.";
    return;
  }
  connectAndJoin(room, name);
});

submitBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== 1) return;
  if (!currentState || !currentState.started || currentState.finished) return;

  const tokenValue = parseInt(tokenValueEl.textContent, 10) || 1;

  // Only correctly sorted fish count
  const correctCount = fishTokens.filter(f =>
    (f.color === "red" && f.inRed) || (f.color === "blue" && f.inBlue)
  ).length;

  let harvest = correctCount * tokenValue;

  // enforce server max
  harvest = Math.max(0, Math.min(currentState.max_harvest_per_player, harvest));

  ws.send(JSON.stringify({ type: "submit", harvest }));
  statusEl.textContent = "Submitted. Waiting for others…";
});
