import json
import time
import math
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


# -------------------------
# Game config (easy knobs)
# -------------------------
MIN_PLAYERS_TO_START = 2
MAX_PLAYERS_PER_ROOM = 4
ROUNDS_TOTAL = 6
STARTING_STOCK = 40
MAX_HARVEST_PER_PLAYER = 20
GROWTH_START_ROUND = 2          # Round 2 onward: each remaining fish spawns +2 (=> 3x remaining)
STOCK_CAP = 200                 # prevents runaway numbers; set to None to disable


# -------------------------
# Room state
# -------------------------
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
    submissions: Dict[str, int] = field(default_factory=dict)  # player_id -> harvest
    totals: Dict[str, int] = field(default_factory=dict)       # player_id -> total catch
    last_round_results: Optional[dict] = None
    started: bool = False
    finished: bool = False

    def to_public(self):
        return {
            "room_code": self.room_code,
            "round_num": self.round_num,
            "rounds_total": ROUNDS_TOTAL,
            "stock": self.stock,
            "max_harvest_per_player": MAX_HARVEST_PER_PLAYER,
            "growth_start_round": GROWTH_START_ROUND,
            "stock_cap": STOCK_CAP,
            "min_players_to_start": MIN_PLAYERS_TO_START,
            "max_players_per_room": MAX_PLAYERS_PER_ROOM,
            "players": [{"player_id": p.player_id, "name": p.name} for p in self.players],
            "submitted": list(self.submissions.keys()),
            "totals": self.totals,
            "last_round_results": self.last_round_results,
            "started": self.started,
            "finished": self.finished,
        }


rooms: Dict[str, RoomState] = {}
connections: Dict[str, List[WebSocket]] = {}  # room_code -> websockets


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
    if dead:
        for ws in dead:
            try:
                connections[room_code].remove(ws)
            except ValueError:
                pass


def scale_down_harvests(stock: int, requested: Dict[str, int]) -> Dict[str, int]:
    total_req = sum(requested.values())
    if total_req <= stock:
        return requested

    # proportional scaling
    scale = stock / total_req if total_req > 0 else 0
    scaled = {pid: int(round(h * scale)) for pid, h in requested.items()}

    # fix rounding to match stock exactly
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
    # Compute actual catches
    requested = {pid: min(MAX_HARVEST_PER_PLAYER, max(0, int(h))) for pid, h in room.submissions.items()}
    actual = scale_down_harvests(room.stock, requested)

    harvested_total = sum(actual.values())
    remaining = max(0, room.stock - harvested_total)

    # growth rule starts in round 2 (by default)
    if room.round_num >= GROWTH_START_ROUND:
        next_stock = remaining * 3
    else:
        next_stock = remaining

    if STOCK_CAP is not None:
        next_stock = min(next_stock, STOCK_CAP)

    # update totals
    for pid, c in actual.items():
        room.totals[pid] = room.totals.get(pid, 0) + c

    room.last_round_results = {
        "requested": requested,
        "actual": actual,
        "harvested_total": harvested_total,
        "remaining": remaining,
        "next_stock": next_stock,
    }

    room.stock = next_stock
    room.round_num += 1
    room.submissions = {}

    if room.round_num > ROUNDS_TOTAL:
        room.finished = True


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    room_code = None
    player_id = None

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")

# Be tolerant of older/cached clients or slightly different payloads
            if not mtype:
                if "room_code" in msg and "name" in msg:
                    mtype = "join"
                elif "harvest" in msg:
                    mtype = "submit"
                else:
        # Ignore unknown/no-op messages rather than erroring
                    await websocket.send_text(json.dumps({"type": "error", "message": "Unknown message type."}))
                    continue


            if mtype == "join":
                room_code = msg.get("room_code", "").strip().upper()
                name = (msg.get("name") or "Player").strip()[:24]
                room = get_or_create_room(room_code)
                # Don't allow joining after game has started (keeps player count stable)
            if room.started:
                await websocket.send_text(json.dumps({"type": "error", "message": "This room already started. Use a different room code."}))
                continue

                # room full?
                if len(room.players) >= MAX_PLAYERS_PER_ROOM and not any(p.name == name for p in room.players):
                    await websocket.send_text(json.dumps({"type": "error", "message": "Room is full (4 players). Use a different room code."}))
                    continue

                # assign player_id (stable for this socket)
                player_id = str(uuid.uuid4())[:8]

                room.players.append(Player(player_id=player_id, name=name))
                room.totals[player_id] = room.totals.get(player_id, 0)

                connections[room_code].append(websocket)

                # start when 4 players join
                if len(room.players) >= MIN_PLAYERS_TO_START:
                    room.started = True

                await websocket.send_text(json.dumps({"type": "joined", "player_id": player_id}))
                await broadcast(room_code, {"type": "state", "state": room.to_public()})

            elif mtype == "submit":
                if not room_code or not player_id:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Join a room first."}))
                    continue

                room = get_or_create_room(room_code)
                if room.finished:
                    await websocket.send_text(json.dumps({"type": "state", "state": room.to_public()}))
                    continue
                if not room.started:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Waiting for 4 players to join."}))
                    continue

                harvest = int(msg.get("harvest", 0))
                harvest = max(0, min(MAX_HARVEST_PER_PLAYER, harvest))
                room.submissions[player_id] = harvest

                # if everyone submitted, resolve round
                if len(room.submissions) == len(room.players):
                    resolve_round(room)

                await broadcast(room_code, {"type": "state", "state": room.to_public()})

            elif mtype == "reset":
                # optional teacher reset if you want it later (simple shared password could be added)
                if not room_code:
                    continue
                room = get_or_create_room(room_code)
                rooms[room_code] = RoomState(room_code=room_code)
                await broadcast(room_code, {"type": "state", "state": rooms[room_code].to_public()})

            else:
                await websocket.send_text(json.dumps({"type": "error", "message": "Unknown message type."}))

    except WebSocketDisconnect:
        # remove websocket from connections
        if room_code and websocket in connections.get(room_code, []):
            connections[room_code].remove(websocket)
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": f"Server error: {e}"}))
        except Exception:
            pass
