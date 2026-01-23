let ws = null;
let current = null;

const roomEl = document.getElementById("room");
const watchBtn = document.getElementById("watch");
const metaEl = document.getElementById("meta");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");

const tbl = document.getElementById("tbl");
const tbody = document.getElementById("tbody");

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function render(state) {
  current = state;

  metaEl.textContent = `(${state.app_version || "no-version"})`;
  statusEl.textContent = state.finished
    ? "Room finished."
    : state.started ? "Room in progress." : "Waiting to start.";

  const collapseBadge = state.collapse_round
    ? `<span class="badge">Collapsed in season ${state.collapse_round}</span>`
    : "";

  summaryEl.innerHTML = `
    <div><b>Room:</b> ${state.room_code} ${collapseBadge}</div>
    <div><b>Current season:</b> ${state.round_num} / ${state.rounds_total}</div>
    <div><b>Current stock:</b> ${state.stock}</div>
    <div><b>Seasons completed:</b> ${state.seasons_completed}</div>
    ${state.last_round_results ? `
      <div style="margin-top:10px;">
        <b>Last season results:</b>
        Stock before: <b>${state.last_round_results.stock_before ?? ""}</b>,
        Harvested: <b>${state.last_round_results.harvested_total}</b>,
        Remaining: <b>${state.last_round_results.remaining}</b>,
        Next stock: <b>${state.last_round_results.next_stock}</b>
      </div>
    ` : ""}
  `;

  const scoreboard = state.scoreboard || [];
  tbl.style.display = "table";
  tbody.innerHTML = "";

  const seasons = [];
  const maxSeason = Math.max(0, state.seasons_completed || 0);
  for (let s = 1; s <= maxSeason; s++) seasons.push(s);

  for (const row of scoreboard) {
    const byRound = row.by_round || {};
    const seasonLines = seasons.length
      ? seasons.map(s => `Season ${s}: <b>${byRound[s] ?? 0}</b>`).join("<br/>")
      : "<span class='muted'>No seasons completed yet.</span>";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.name}</td>
      <td><b>${row.total}</b></td>
      <td>${seasonLines}</td>
      <td>${row.seasons_survived}</td>
    `;
    tbody.appendChild(tr);
  }
}

function connect(roomCode, pin) {
  if (ws) {
    try { ws.close(); } catch (e) {}
  }

  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "observe", room_code: roomCode, pin }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") render(msg.state);
    if (msg.type === "error") statusEl.textContent = msg.message;
  };

  ws.onclose = () => {
    if (current) statusEl.textContent = "Disconnected.";
  };
}

watchBtn.onclick = () => {
  const code = roomEl.value.trim();
  if (!code) return;

  const pin = prompt("Instructor PIN (3 digits):");
  if (!pin) return;

  connect(code, String(pin).trim());
};
