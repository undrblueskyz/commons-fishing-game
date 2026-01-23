import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def root():
    return FileResponse("static/index.html")


@app.get("/observer")
def observer():
    return FileResponse("static/observer.html")


# =====================================================
# CONFIG
# =====================================================
APP_VERSION = "ROOM-POND-SEASONS-3X-COLLAPSE-OBSERVERPIN-2026-01-23F"

INSTRUCTOR_PIN = "522"  # 3-digit instructor PIN required for observer mode

MIN_PLAYERS_TO_START = 2
MAX_PLAYERS_PER_ROOM = 4

ROUNDS_TOTAL = 6
STARTING_STOCK = 20
MAX_HARVEST_PER_PLAYER = 20

# Growth: each remaining fish spawns 2 more -> total triples
GROWTH_START_ROUND = 1

# Disable cap to avoid clipping
STOCK_CAP = None


# =====================================================
# STATE
# =====================================================
@dataclass
class Player:
    player_id: str
    name: str


@dataclass
class RoomState:
    room_code: str
    created_at: float = field(default_factory=time.time)

    round_num: int = 1
    stock: int = STARTING_STOCK

    players: List[Player] = field(default_factory=list)
    submissions: Dict[str, int] = field(default_factory=dict)  # player_id -> harvest this season
    totals: Dict[str, int] = field(default_factory=dict)       # player_id -> total catch
    last_round_results: Optional[dict] = None

    # Per-season harvest history: season -> {player_id: actual_harvest}
    round_history: Dict[int, Dict[str, int]] = field(default_factory=dict)

    started: bool = False
    finished: bool = False
    collapse_round: Optional[int] = None

    def seasons_completed(self) -> int:
        return max(0, self.round_num - 1)

    def to_public(self):
        players_public = [{"player_id": p.player_id, "name": p.name} for p in self.players]

        per_player_by_round: Dict[str, Dict[int, int]] = {p["player_id"]: {} for p in players_public}
        for rnum, harvests in self.round_history.items():
            for pid, amt in harvests.items():
                if pid not in per_player_by_round:
                    per_player_by_round[pid] = {}
                per_player_by_round[pid][rnum] = amt

        seasons_survived = self.seasons_completed()

        scoreboard = []
        for p in players_public:
            pid = p["player_id"]
            scoreboard.append({
                "player_id": pid,
                "name": p["name"],
                "total": self.totals.get(pid, 0),
                "by_round": per_player_by_round.get(pid, {}),
                "seasons_survived": seasons_survived,
            })
        scoreboard.sort(key=lambda x: x["total"], reverse=True)

        return {
            "app_version": APP_VERSION,

            "room_code": self.room_code,
            "round_num": self.round_num,
            "rounds_total": ROUNDS_TOTAL,

            "stock": self.stock,
            "max_harvest_per_player": MAX_HARVEST_PER_PLAYER,

            "growth_start_round": GROWTH_START_ROUND,
            "stock_cap": STOCK_CAP,

            "min_players_to_start": MIN_PLAYERS_TO_START,
            "max_players_per_room": MAX_PLAYERS_PER_ROOM,

            "players": players_public,
            "submitted": list(self.submissions.keys()),
            "totals": self.totals,
            "last_round_results": self.last_round_results,

            # Observer fields
            "seasons_completed": self.seasons_completed(),
            "collapse_round": self.collapse_round,
            "scoreboard": scoreboard,
            "round_history": self.round_history,

            "started": self.started,
            "finished": self.finished,
        }


rooms: Dict[str, RoomState] = {}
connections: Dict[str, List[WebSocket]] = {}  # room_code -> websockets (players + observers)


def get_or_create_room(room_code: str) -> RoomState:
    code = room_code.strip().upper()
    if code not in rooms:
        rooms[code] = RoomState(room_code=code)
        connections[code] = []
    return rooms[code]


async def broadcast(room_code: str, message: dict):
    dead = []
    for ws in connections.get(room_code, []):
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            dead.append(ws)
    for ws in dead:
        try:
            connections[room_code].remove(ws)
        except ValueError:
            pass


def scale_down_harvests(stock: int, requested: Dict[str, int]) -> Dict[str, int]:
    """
    If total requested > available stock, scale requests proportionally so total actual == stock.
    """
    total_req = sum(requested.values())
    if total_req <= stock:
        return requested

    scale = stock / total_req if total_req > 0 else 0.0
    scaled = {pid: int(round(h * scale)) for pid, h in requested.items()}

    # Fix rounding so sum(scaled) == stock exactly
    diff = stock - sum(scaled.values())
    pids = list(scaled.keys())
    i = 0
    while diff != 0 and pids:
        pid = pids[i % len(pids)]
        if diff > 0:
            scaled[pid] += 1
            diff -= 1
        else:
            if scaled[pid] > 0:
                scaled[pid] -= 1
                diff += 1
        i += 1

    return scaled


def resolve_round(room: RoomState):
    stock_before = room.stock

    requested = {
        pid: min(MAX_HARVEST_PER_PLAYER, max(0, int(h)))
        for pid, h in room.submissions.items()
    }

    actual = scale_down_harvests(room.stock, requested)
    harvested_total = sum(actual.values())
    remaining = max(0, room.stock - harvested_total)

    # Growth rule: remaining fish spawn 2 more each => total triples
    if room.round_num >= GROWTH_START_ROUND:
        next_stock = remaining * 3
    else:
        next_stock = remaining

    if STOCK_CAP is not None:
        next_stock = min(next_stock, STOCK_CAP)

    # Save per-season harvest history (season = current round before increment)
    room.round_history[room.round_num] = actual.copy()

    # Update totals
    for pid, c in actual.items():
        room.totals[pid] = room.totals.get(pid, 0) + c

    room.last_round_results = {
        "stock_before": stock_before,
        "requested": requested,
        "actual": actual,
        "harvested_total": harvested_total,
        "remaining": remaining,
        "next_stock": next_stock,
    }

    # Advance season
    room.stock = next_stock
    room.round_num += 1
    room.submissions = {}

    # Collapse condition: if pond is empty, end immediately
    if room.stock <= 0:
        room.finished = True
        room.collapse_round = room.round_num - 1
        room.last_round_results["collapse"] = True
        room.last_round_results["collapse_message"] = "Overfished — there are no fish left in the pond."

    # Normal end condition
    if room.round_num > ROUNDS_TOTAL:
        room.finished = True


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    room_code: Optional[str] = None
    player_id: Optional[str] = None
    is_observer: bool = False

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            mtype = (msg.get("type") or "").strip().lower()

            # fallback if type omitted
            if not mtype:
                if "room_code" in msg and "name" in msg:
                    mtype = "join"
                elif "harvest" in msg:
                    mtype = "submit"

            if mtype == "observe":
                pin = str(msg.get("pin", "")).strip()
                if pin != INSTRUCTOR_PIN:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "Invalid instructor PIN."
                    }))
                    continue

                is_observer = True
                room_code = (msg.get("room_code", "") or "").strip().upper()
                room = get_or_create_room(room_code)
                connections[room_code].append(websocket)

                await websocket.send_text(json.dumps({"type": "observing"}))
                await websocket.send_text(json.dumps({"type": "state", "state": room.to_public()}))

            elif mtype == "join":
                room_code = (msg.get("room_code", "") or "").strip().upper()
                name = ((msg.get("name") or "Player").strip() or "Player")[:24]
                room = get_or_create_room(room_code)

                # lock roster after start
                if room.started:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "This room already started. Use a different room code."
                    }))
                    continue

                if len(room.players) >= MAX_PLAYERS_PER_ROOM:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "Room is full (max 4 players). Use a different room code."
                    }))
                    continue

                player_id = str(uuid.uuid4())[:8]
                room.players.append(Player(player_id=player_id, name=name))
                room.totals[player_id] = room.totals.get(player_id, 0)

                connections[room_code].append(websocket)

                if len(room.players) >= MIN_PLAYERS_TO_START:
                    room.started = True

                await websocket.send_text(json.dumps({"type": "joined", "player_id": player_id}))
                await broadcast(room_code, {"type": "state", "state": room.to_public()})

            elif mtype == "submit":
                if is_observer:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Observers cannot submit."}))
                    continue

                if not room_code or not player_id:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Join a room first."}))
                    continue

                room = get_or_create_room(room_code)

                if room.finished:
                    await websocket.send_text(json.dumps({"type": "state", "state": room.to_public()}))
                    continue

                if not room.started:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Waiting for more players to join."}))
                    continue

                harvest = int(msg.get("harvest", 0))
                harvest = max(0, min(MAX_HARVEST_PER_PLAYER, harvest))
                room.submissions[player_id] = harvest

                if len(room.submissions) == len(room.players):
                    resolve_round(room)

                await broadcast(room_code, {"type": "state", "state": room.to_public()})

            elif mtype == "reset":
                if not room_code:
                    continue
                rooms[room_code] = RoomState(room_code=room_code)
                await broadcast(room_code, {"type": "state", "state": rooms[room_code].to_public()})

            else:
                continue

    except WebSocketDisconnect:
        if room_code and websocket in connections.get(room_code, []):
            connections[room_code].remove(websocket)
    except Exception:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": "Server error."}))
        except Exception:
            pass
