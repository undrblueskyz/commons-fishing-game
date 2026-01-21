// Simple drag-into-net fishing UI + WebSocket room sync.

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
let net = { x: 680, y: 250, w: 150, h: 140 };

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function resetBoard(stock, maxHarvest) {
  fishTokens = [];
  // show up to 30 tokens; each token represents "tokenValue" fish
  const displayCount = Math.min(30, stock);
  const tokenValue = Math.max(1, Math.ceil(stock / Math.max(1, displayCount)));
  tokenValueEl.textContent = tokenValue;

  // tokens available to drag: cap by maxHarvest (game feel)
  // we still render a pond; player can't exceed maxHarvest tokens.
  const tokensToSpawn = Math.min(maxHarvest, displayCount);

  for (let i = 0; i < tokensToSpawn; i++) {
    fishTokens.push({
      id: i,
      x: 70 + (i % 10) * 55,
      y: 70 + Math.floor(i / 10) * 55,
      r: 16,
      inNet: false
    });
  }
  updateCatchNow();
  draw();
}

function updateCatchNow() {
  const tokenValue = parseInt(tokenValueEl.textContent, 10) || 1;
  const count = fishTokens.filter(f => f.inNet).length;
  catchNowEl.textContent = count * tokenValue;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Title text
  ctx.font = "16px system-ui";
  ctx.fillText("Pond", 16, 24);

  // Net area
  ctx.fillText("Net", net.x, net.y - 10);
  ctx.strokeRect(net.x, net.y, net.w, net.h);

  // Fish tokens
  for (const f of fishTokens) {
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // tiny tail
    ctx.beginPath();
    ctx.moveTo(f.x + f.r, f.y);
    ctx.lineTo(f.x + f.r + 10, f.y - 6);
    ctx.lineTo(f.x + f.r + 10, f.y + 6);
    ctx.closePath();
    ctx.fill();
  }

  // Instructions
  ctx.font = "14px system-ui";
  ctx.fillText("Drag fish into the Net, then Submit.", 16, canvas.height - 16);
}

function hitFish(mx, my) {
  for (let i = fishTokens.length - 1; i >= 0; i--) {
    const f = fishTokens[i];
    const dx = mx - f.x, dy = my - f.y;
    if (Math.sqrt(dx*dx + dy*dy) <= f.r + 2) return f;
  }
  return null;
}

function inNet(f) {
  return (f.x >= net.x && f.x <= net.x + net.w && f.y >= net.y && f.y <= net.y + net.h);
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

canvas.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging.fish.inNet = inNet(dragging.fish);
  dragging = null;
  updateCatchNow();
  draw();
});

canvas.addEventListener("mouseleave", () => {
  if (!dragging) return;
  dragging.fish.inNet = inNet(dragging.fish);
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
  const players = (state.players || []).map(p => `${p.name}${submitted.has(p.player_id) ? " ✓" : ""}`);
  playersLabel.textContent = players.join(", ");

  if (!state.started) {
    statusEl.textContent = `Waiting for 4 players… (${(state.players||[]).length}/4)`;
    submitBtn.disabled = true;
  } else if (state.finished) {
    statusEl.textContent = `Finished.`;
    submitBtn.disabled = true;
  } else {
    statusEl.textContent = `Make your catch and submit.`;
    submitBtn.disabled = false;
  }

  // show last round results to make the commons dynamic visible AFTER round 1
  if (state.last_round_results) {
    const r = state.last_round_results;
    const lines = [];
    lines.push(`<div><b>Last round:</b></div>`);
    lines.push(`<div>Harvested total: <b>${r.harvested_total}</b>, Remaining: <b>${r.remaining}</b></div>`);
    if (state.round_num >= state.growth_start_round) {
      lines.push(`<div>Growth rule active: next stock = 3 × remaining</div>`);
    } else {
      lines.push(`<div>No growth yet (round 1)</div>`);
    }
    resultsEl.innerHTML = lines.join("");
  } else {
    resultsEl.innerHTML = "";
  }

  // Reset the board each round for that "game" feel
  // Only do this when state round changes OR on first render
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
      .sort((a,b) => b.tot - a.tot);

    leaderboardEl.innerHTML = entries.map((e,i) => `<div>${i+1}. <b>${e.name}</b>: ${e.tot}</div>`).join("");
  } else {
    endDiv.classList.add("hidden");
  }
}

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
    // auto-reconnect with a gentle message
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
  const count = fishTokens.filter(f => f.inNet).length;
  let harvest = count * tokenValue;

  // enforce server max, but keep UI consistent
  harvest = Math.max(0, Math.min(currentState.max_harvest_per_player, harvest));

  ws.send(JSON.stringify({ type: "submit", harvest }));
  statusEl.textContent = "Submitted. Waiting for others…";
});
