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


# -------------------------
# Game config (easy knobs)
# -------------------------
MIN_PLAYERS_TO_START = 2
MAX_PLAYERS_PER_ROOM = 4

ROUNDS_TOTAL = 6
STARTING_STOCK = 40
MAX_HARVEST_PER_PLAYER = 20

GROWTH_START_ROUND = 2          # Round 2 onward: next_stock = 3 * remaining
STOCK_CAP = 200                 # set None to disable


# -------------------------
# Shared (global) pond state
# -------------------------
@dataclass
class GlobalState:
    round_num: int = 1
    stock: int = STARTING_STOCK
    finished: bool = False
    # For each round, we track which rooms have "completed" and their totals
    room_round_harvest: Dict[str, int] = field(default_factory=dict)  # room_code -> harvested_total

    def to_public(self):
        return {
            "global_round_num": self.round_num,
            "global_stock": self.stock,
            "global_finished": self.finished,
            "rounds_total": ROUNDS_TOTAL,
            "growth_start_round": GROWTH_START_ROUND,
            "stock_cap": STOCK_CAP,
        }


GLOBAL = GlobalState()


# -------------------------
# Room state (players + submissions)
# -------------------------
@dataclass
class Player:
    player_id: str
    name: str


@dataclass
class RoomState:
    room_code: str
    created_at: float = field(default_factory=time.time)

    players: List[Player] = field(default_factory=list)
    submissions: Dict[str, int] = field(default_factory=dict)  # player_id -> harvest choice
    totals: Dict[str, int] = field(default_factory=dict)       # player_id -> total catch across game

    # Last resolved results for THIS ROOM (so each room can see their own)
    last_round_results: Optional[dict] = None

    started: bool = False
    # When True, this room has finished submitting for the current GLOBAL round
    room_done_this_round: bool = False

    def to_public(self):
        # publish global + local together so the front-end can display stock/round
        pub = {
            "room_code": self.room_code,
            "round_num": GLOBAL.round_num,               # front-end expects round_num
            "rounds_total": ROUNDS_TOTAL,                # front-end expects rounds_total
            "stock": GLOBAL.stock,                       # front-end expects stock
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
            "finished": GLOBAL.finished,
        }
        return pub


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


async def broadcast_all_rooms():
    for code in list(rooms.keys()):
        await broadcast(code, {"type": "state", "state": rooms[code].to_public()})


def scale_down_harvests(stock: int, requested: Dict[str, int]) -> Dict[str, int]:
    """
    If a room requests more than the GLOBAL stock, scale that ROOM's requests down.
    Note: Global scaling across rooms is handled at global resolution step; this scaling
    just ensures a single room doesn't submit crazy numbers.
    """
    total_req = sum(requested.values())
    if total_req <= stock:
        return requested

    scale = stock / total_req if total_req > 0 else 0
    scaled = {pid: int(round(h * scale)) for pid, h in requested.items()}

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


def resolve_room_for_global_round(room: RoomState):
    """
    Resolve this room's submissions into actual catches for THIS round, update player totals,
    and record the room's harvested_total into GLOBAL.room_round_harvest.
    """
    # clamp each player's request
    requested = {pid: min(MAX_HARVEST_PER_PLAYER, max(0, int(h))) for pid, h in room.submissions.items()}

    # scale down within the room if needed relative to current global stock
    # (global shortage across rooms will be handled at global resolution below)
    actual = scale_down_harvests(GLOBAL.stock, requested)

    harvested_total = sum(actual.values())

    # update player totals for this room
    for pid, c in actual.items():
        room.totals[pid] = room.totals.get(pid, 0) + c

    room.last_round_results = {
        "requested": requested,
        "actual": actual,
        "harvested_total": harvested_total,
        # remaining/next_stock are GLOBAL concepts; we fill them in after global resolves
        "remaining": None,
        "next_stock": None,
        "players_this_room": len(room.players),
    }

    # Mark room done and write its harvest for this global round
    room.room_done_this_round = True
    GLOBAL.room_round_harvest[room.room_code] = harvested_total

    # clear submissions for the room (lock in their decision)
    room.submissions = {}


def resolve_global_round_if_ready():
    """
    If all *started* rooms are done this round, resolve the GLOBAL pond:
    remaining = stock - sum(room harvests) ; next_stock = remaining (round1) else 3*remaining.
    """
    if GLOBAL.finished:
        return

    started_rooms = [r for r in rooms.values() if r.started]
    if not started_rooms:
        return

    # Only resolve when every started room has completed their submissions
    if not all(r.room_done_this_round for r in started_rooms):
        return

    total_harvested_all_rooms = sum(GLOBAL.room_round_harvest.get(r.room_code, 0) for r in started_rooms)
    remaining = max(0, GLOBAL.stock - total_harvested_all_rooms)

    if GLOBAL.round_num >= GROWTH_START_ROUND:
        next_stock = remaining * 3
    else:
        next_stock = remaining

    if STOCK_CAP is not None:
        next_stock = min(next_stock, STOCK_CAP)

    # Fill in the remaining/next_stock for each room's last result (nice feedback)
    for r in started_rooms:
        if r.last_round_results:
            r.last_round_results["remaining"] = remaining
            r.last_round_results["next_stock"] = next_stock

    # Advance global state
    GLOBAL.stock = next_stock
    GLOBAL.round_num += 1
    GLOBAL.room_round_harvest = {}

    # Reset room round flags so next global round can start
    for r in started_rooms:
        r.room_done_this_round = False

    if GLOBAL.round_num > ROUNDS_TOTAL:
        GLOBAL.finished = True


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    room_code = None
    player_id = None

    try:
        while True:
            raw = await websocket.receive_text()

            # tolerate non-JSON frames
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            mtype = (msg.get("type") or "").strip().lower()
            if not mtype:
                if "room_code" in msg and "name" in msg:
                    mtype = "join"
                elif "harvest" in msg:
                    mtype = "submit"

            if mtype == "join":
                room_code = (msg.get("room_code", "") or "").strip().upper()
                name = ((msg.get("name") or "Player").strip() or "Player")[:24]
                room = get_or_create_room(room_code)

                # allow joining only before the room has started
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

                # start room when min players reached
                if len(room.players) >= MIN_PLAYERS_TO_START:
                    room.started = True

                await websocket.send_text(json.dumps({"type": "joined", "player_id": player_id}))
                await broadcast(room_code, {"type": "state", "state": room.to_public()})

            elif mtype == "submit":
                if not room_code or not player_id:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Join a room first."}))
                    continue

                room = get_or_create_room(room_code)

                if GLOBAL.finished:
                    await websocket.send_text(json.dumps({"type": "state", "state": room.to_public()}))
                    continue

                if not room.started:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Waiting for at least 2 players to join."}))
                    continue

                # prevent multiple submissions after room is done
                if room.room_done_this_round:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Your room is waiting for other rooms to finish this round."}))
                    continue

                harvest = int(msg.get("harvest", 0))
                harvest = max(0, min(MAX_HARVEST_PER_PLAYER, harvest))
                room.submissions[player_id] = harvest

                # resolve this room when all players in the room have submitted
                if len(room.submissions) == len(room.players):
                    resolve_room_for_global_round(room)
                    resolve_global_round_if_ready()

                    # broadcast updated state to ALL rooms (global stock/round changed)
                    await broadcast_all_rooms()
                else:
                    # broadcast room state update (shows checkmarks)
                    await broadcast(room_code, {"type": "state", "state": room.to_public()})

            elif mtype == "reset":
                # resets global + the room (basic admin action)
                if not room_code:
                    continue
                GLOBAL.round_num = 1
                GLOBAL.stock = STARTING_STOCK
                GLOBAL.finished = False
                GLOBAL.room_round_harvest = {}
                # reset all rooms
                for code in list(rooms.keys()):
                    rooms[code] = RoomState(room_code=code)
                await broadcast_all_rooms()

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
