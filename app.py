import os
import random
import string
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, render_template, request, redirect, url_for, jsonify, abort
from flask_socketio import SocketIO, emit, join_room as sio_join_room, leave_room as sio_leave_room
from werkzeug.utils import secure_filename
from PIL import Image

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif", "bmp"}
MAX_IMAGE_DIMENSION = 1400
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # без похожих символов
PLAYER_COLORS = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
    "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080",
    "#e6beff", "#9a6324", "#800000", "#808000", "#000075",
]
DIFFICULTIES = {
    "easy": (4, 3),
    "medium": (6, 4),
    "hard": (8, 6),
    "extreme": (10, 8),
}
ROOM_GRACE_SECONDS = 90  # сколько ждём переподключения игрока, прежде чем убрать его

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024  # 15 МБ на загрузку

socketio = SocketIO(
    app,
    async_mode="threading",
    max_http_buffer_size=15 * 1024 * 1024,
    # Flask-SocketIO's default (async_handlers=True) dispatches every incoming
    # event to its own new thread, with no guarantee they run in the order
    # they arrived. A single player's pickup -> move -> drop sequence (fired
    # within milliseconds of each other on any real drag) could then be
    # processed out of order, e.g. drop_piece running before pickup_piece had
    # set the piece's holder -- silently discarding the drop and leaving the
    # piece stuck "held" forever. Disabling it makes each connection process
    # its own events strictly in order; different players' connections still
    # run concurrently (still guarded by each room's lock).
    async_handlers=False,
)

rooms = {}          # code -> room dict
rooms_lock = threading.Lock()
sid_to_player = {}  # sid -> (room_code, player_id)


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def upload_url(filename):
    # Plain string instead of url_for(): background threads (e.g. the
    # disconnect grace-period timer) have no request context, and url_for
    # needs either one or a configured SERVER_NAME to build a URL.
    return f"/static/uploads/{filename}"


def make_room_code():
    while True:
        code = "".join(random.choices(ROOM_CODE_ALPHABET, k=5))
        if code not in rooms:
            return code


def new_room(code):
    return {
        "code": code,
        "lock": threading.Lock(),  # guards every mutation below; socket.io
                                    # handlers run on separate threads and
                                    # would otherwise race (e.g. two players
                                    # both passing the pickup_piece check
                                    # before either sets the holder).
        "host_player": None,
        "players": {},        # player_id -> {name, sid, color, connected, disconnect_timer}
        "image_file": None,   # имя файла в static/uploads
        "image_w": 0,
        "image_h": 0,
        "rows": 6,
        "cols": 4,
        "piece_w": 0,
        "piece_h": 0,
        "scatter_w": 0,
        "scatter_h": 0,
        "pieces": {},         # piece_id -> dict
        "edgesV": [],
        "edgesH": [],
        "started": False,
        "solved": False,
        "start_time": None,
        "created_at": time.time(),
    }


def public_room_state(room):
    return {
        "code": room["code"],
        "hostPlayer": room["host_player"],
        "players": [
            {"id": pid, "name": p["name"], "color": p["color"], "connected": p["connected"]}
            for pid, p in room["players"].items()
        ],
        "image": upload_url(room["image_file"]) if room["image_file"] else None,
        "rows": room["rows"],
        "cols": room["cols"],
        "started": room["started"],
        "solved": room["solved"],
    }


def build_pieces(room):
    rows, cols = room["rows"], room["cols"]
    pw = room["image_w"] / cols
    ph = room["image_h"] / rows
    room["piece_w"], room["piece_h"] = pw, ph
    room["scatter_w"] = room["image_w"] * 1.6
    room["scatter_h"] = room["image_h"] * 1.15

    pieces = {}
    pid = 0
    for r in range(rows):
        for c in range(cols):
            pieces[str(pid)] = {
                "id": str(pid),
                "row": r,
                "col": c,
                "x": random.uniform(0, max(room["scatter_w"] - pw, 1)),
                "y": random.uniform(0, max(room["scatter_h"] - ph, 1)),
                "locked": False,
                "holder": None,
            }
            pid += 1
    room["pieces"] = pieces
    room["edgesV"] = [
        [[random.choice([1, -1]), random.uniform(-0.12, 0.12)] for _ in range(cols - 1)]
        for _ in range(rows)
    ]
    room["edgesH"] = [
        [[random.choice([1, -1]), random.uniform(-0.12, 0.12)] for _ in range(cols)]
        for _ in range(rows - 1)
    ]
    room["started"] = True
    room["solved"] = False
    room["start_time"] = time.time()


def game_payload(room):
    return {
        "image": upload_url(room["image_file"]),
        "imageW": room["image_w"],
        "imageH": room["image_h"],
        "rows": room["rows"],
        "cols": room["cols"],
        "pieceW": room["piece_w"],
        "pieceH": room["piece_h"],
        "scatterW": room["scatter_w"],
        "scatterH": room["scatter_h"],
        "edgesV": room["edgesV"],
        "edgesH": room["edgesH"],
        "pieces": list(room["pieces"].values()),
        # Authoritative start time (seconds since epoch) rather than letting
        # each client stamp "now" on arrival -- otherwise a player who joins
        # or reconnects mid-game sees the timer start over from 0:00.
        "startTime": room["start_time"],
    }


def get_room_or_none(code):
    if not code:
        return None
    return rooms.get(code.upper())


def assign_color(room):
    used = {p["color"] for p in room["players"].values()}
    for c in PLAYER_COLORS:
        if c not in used:
            return c
    return random.choice(PLAYER_COLORS)


def cleanup_room_if_empty(code):
    room = rooms.get(code)
    if not room:
        return
    if all(not p["connected"] for p in room["players"].values()):
        img = room.get("image_file")
        if img:
            try:
                (UPLOAD_DIR / img).unlink(missing_ok=True)
            except OSError:
                pass
        rooms.pop(code, None)


# --------------------------------------------------------------------------
# HTTP routes
# --------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/create", methods=["POST"])
def create_room():
    name = (request.form.get("name") or "").strip()[:24]
    if not name:
        return redirect(url_for("index", error="name"))
    with rooms_lock:
        code = make_room_code()
        rooms[code] = new_room(code)
    return redirect(url_for("room_page", code=code, name=name))


@app.route("/join", methods=["POST"])
def join_room_http():
    name = (request.form.get("name") or "").strip()[:24]
    code = (request.form.get("code") or "").strip().upper()
    if not name or not code:
        return redirect(url_for("index", error="fields"))
    if code not in rooms:
        return redirect(url_for("index", error="notfound"))
    return redirect(url_for("room_page", code=code, name=name))


@app.route("/room/<code>")
def room_page(code):
    code = code.upper()
    if code not in rooms:
        return redirect(url_for("index", error="notfound"))
    return render_template("room.html", code=code, name=request.args.get("name", ""))


@app.route("/api/rooms/<code>/upload", methods=["POST"])
def upload_image(code):
    code = code.upper()
    room = get_room_or_none(code)
    if room is None:
        abort(404)

    player_id = request.form.get("player_id", "")
    if room["host_player"] and player_id != room["host_player"]:
        return jsonify({"error": "only_host"}), 403

    file = request.files.get("image")
    if not file or file.filename == "":
        return jsonify({"error": "no_file"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "bad_type"}), 400

    try:
        img = Image.open(file.stream)
        img.verify()
        file.stream.seek(0)
        img = Image.open(file.stream)
        img = img.convert("RGB")
    except Exception:
        return jsonify({"error": "invalid_image"}), 400

    w, h = img.size
    if max(w, h) > MAX_IMAGE_DIMENSION:
        scale = MAX_IMAGE_DIMENSION / max(w, h)
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

    old_file = room.get("image_file")
    filename = f"{code}_{uuid.uuid4().hex[:8]}.jpg"
    img.save(UPLOAD_DIR / filename, "JPEG", quality=88)
    if old_file:
        try:
            (UPLOAD_DIR / old_file).unlink(missing_ok=True)
        except OSError:
            pass

    with room["lock"]:
        room["image_file"] = filename
        room["image_w"], room["image_h"] = img.size
        room["started"] = False
        room["solved"] = False
        state = public_room_state(room)

    socketio.emit("image_updated", {"image": upload_url(filename)}, room=code)
    socketio.emit("lobby_state", state, room=code)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Socket.IO events
# --------------------------------------------------------------------------

@socketio.on("join_lobby")
def on_join_lobby(data):
    code = (data.get("room") or "").strip().upper()
    name = (data.get("name") or "Игрок").strip()[:24] or "Игрок"
    player_id = data.get("player_id") or uuid.uuid4().hex

    room = get_room_or_none(code)
    if room is None:
        emit("lobby_error", {"message": "Комната не найдена"})
        return

    sio_join_room(code)
    sid_to_player[request.sid] = (code, player_id)

    with room["lock"]:
        existing = room["players"].get(player_id)
        if existing:
            timer = existing.pop("disconnect_timer", None)
            if timer:
                timer.cancel()
            existing["sid"] = request.sid
            existing["connected"] = True
            existing["name"] = name or existing["name"]
        else:
            room["players"][player_id] = {
                "name": name,
                "sid": request.sid,
                "color": assign_color(room),
                "connected": True,
                "disconnect_timer": None,
            }

        if not room["host_player"]:
            room["host_player"] = player_id

        is_host = room["host_player"] == player_id
        state = public_room_state(room)
        game_state = game_payload(room) if room["started"] else None
        started, solved = room["started"], room["solved"]
        elapsed = time.time() - room["start_time"] if solved else None

    emit("joined", {"playerId": player_id, "isHost": is_host})
    emit("lobby_state", state, room=code)

    if started and game_state is not None:
        emit("game_started", game_state)
        if solved:
            emit("puzzle_solved", {"elapsed": elapsed})


@socketio.on("set_options")
def on_set_options(data):
    entry = sid_to_player.get(request.sid)
    if not entry:
        return
    code, player_id = entry
    room = get_room_or_none(code)
    if not room or room["host_player"] != player_id:
        return

    with room["lock"]:
        difficulty = data.get("difficulty")
        if difficulty in DIFFICULTIES:
            room["rows"], room["cols"] = DIFFICULTIES[difficulty]
        else:
            try:
                rows = max(2, min(14, int(data.get("rows"))))
                cols = max(2, min(14, int(data.get("cols"))))
                room["rows"], room["cols"] = rows, cols
            except (TypeError, ValueError):
                pass
        state = public_room_state(room)

    emit("lobby_state", state, room=code)


@socketio.on("start_game")
def on_start_game(data):
    entry = sid_to_player.get(request.sid)
    if not entry:
        return
    code, player_id = entry
    room = get_room_or_none(code)
    if not room or room["host_player"] != player_id:
        return
    if not room["image_file"]:
        emit("lobby_error", {"message": "Сначала загрузите картинку"})
        return

    with room["lock"]:
        build_pieces(room)
        payload = game_payload(room)
        state = public_room_state(room)

    emit("game_started", payload, room=code)
    emit("lobby_state", state, room=code)


@socketio.on("pickup_piece")
def on_pickup_piece(data):
    entry = sid_to_player.get(request.sid)
    if not entry:
        return
    code, player_id = entry
    room = get_room_or_none(code)
    if not room:
        return

    with room["lock"]:
        piece = room["pieces"].get(str(data.get("id")))
        if not piece or piece["locked"]:
            return
        if piece["holder"] not in (None, player_id):
            return
        piece["holder"] = player_id
        color = room["players"].get(player_id, {}).get("color", "#888")

    emit("piece_held", {"id": piece["id"], "holder": player_id, "color": color}, room=code)


def clamp_piece_pos(room, x, y):
    # The client clamps tightly to whatever it can actually see on screen
    # (see room.js), which depends on that client's own viewport/zoom and
    # can't be replicated exactly here. This is just a generous backstop
    # against a broken or malicious client sending wild coordinates.
    margin = max(room["scatter_w"], room["scatter_h"])
    min_x, min_y = -margin, -margin
    max_x = room["scatter_w"] + margin
    max_y = room["scatter_h"] + margin
    return min(max(x, min_x), max_x), min(max(y, min_y), max_y)


@socketio.on("move_piece")
def on_move_piece(data):
    entry = sid_to_player.get(request.sid)
    if not entry:
        return
    code, player_id = entry
    room = get_room_or_none(code)
    if not room:
        return

    with room["lock"]:
        piece = room["pieces"].get(str(data.get("id")))
        if not piece or piece["locked"] or piece["holder"] != player_id:
            return
        try:
            x, y = clamp_piece_pos(room, float(data["x"]), float(data["y"]))
            piece["x"] = x
            piece["y"] = y
        except (KeyError, TypeError, ValueError):
            return

    emit(
        "piece_moved",
        {"id": piece["id"], "x": piece["x"], "y": piece["y"], "by": player_id},
        room=code,
        include_self=False,
    )


@socketio.on("drop_piece")
def on_drop_piece(data):
    entry = sid_to_player.get(request.sid)
    if not entry:
        return
    code, player_id = entry
    room = get_room_or_none(code)
    if not room:
        return

    with room["lock"]:
        piece = room["pieces"].get(str(data.get("id")))
        if not piece or piece["locked"] or piece["holder"] != player_id:
            return

        try:
            x, y = clamp_piece_pos(room, float(data["x"]), float(data["y"]))
        except (KeyError, TypeError, ValueError):
            piece["holder"] = None
            return

        target_x = piece["col"] * room["piece_w"]
        target_y = piece["row"] * room["piece_h"]
        dist = ((x - target_x) ** 2 + (y - target_y) ** 2) ** 0.5
        threshold = min(room["piece_w"], room["piece_h"]) * 0.3

        if dist <= threshold:
            piece["x"], piece["y"] = target_x, target_y
            piece["locked"] = True
        else:
            piece["x"], piece["y"] = x, y
        piece["holder"] = None

        piece_snapshot = dict(piece)
        just_solved = room["pieces"] and all(p["locked"] for p in room["pieces"].values())
        if just_solved:
            room["solved"] = True
            elapsed = time.time() - room["start_time"]

    emit("piece_updated", piece_snapshot, room=code)
    if just_solved:
        emit("puzzle_solved", {"elapsed": elapsed}, room=code)


@socketio.on("release_piece")
def on_release_piece(data):
    """Игрок отпустил кусочек не роняя (например, курсор ушёл с канваса)."""
    entry = sid_to_player.get(request.sid)
    if not entry:
        return
    code, player_id = entry
    room = get_room_or_none(code)
    if not room:
        return

    with room["lock"]:
        piece = room["pieces"].get(str(data.get("id")))
        if not piece or piece["holder"] != player_id:
            return
        piece["holder"] = None
        piece_snapshot = dict(piece)

    emit("piece_updated", piece_snapshot, room=code)


@socketio.on("disconnect")
def on_disconnect():
    entry = sid_to_player.pop(request.sid, None)
    if not entry:
        return
    code, player_id = entry
    room = get_room_or_none(code)
    if not room:
        return

    with room["lock"]:
        player = room["players"].get(player_id)
        if not player or player["sid"] != request.sid:
            return
        player["connected"] = False
        for piece in room["pieces"].values():
            if piece["holder"] == player_id:
                piece["holder"] = None
        state = public_room_state(room)

    socketio.emit("piece_released_all", {"player": player_id}, room=code)
    socketio.emit("lobby_state", state, room=code)

    def expire():
        with app.app_context():
            still = rooms.get(code)
            if not still:
                return
            with still["lock"]:
                p = still["players"].get(player_id)
                removed = False
                if p and not p["connected"]:
                    del still["players"][player_id]
                    removed = True
                    if still["host_player"] == player_id:
                        remaining = [pid for pid, pp in still["players"].items() if pp["connected"]]
                        still["host_player"] = remaining[0] if remaining else None
                state = public_room_state(still) if removed else None
            if state is not None:
                socketio.emit("lobby_state", state, room=code)
            with rooms_lock:
                cleanup_room_if_empty(code)

    timer = threading.Timer(ROOM_GRACE_SECONDS, expire)
    timer.daemon = True
    player["disconnect_timer"] = timer
    timer.start()


if __name__ == "__main__":
    # Hosting platforms (Render, Railway, etc.) inject PORT and run the app
    # with no attached tty -- treat that as "production" and turn off the
    # interactive debugger, which would otherwise let a visitor execute
    # arbitrary code from the browser on an unhandled exception.
    is_production = "PORT" in os.environ
    port = int(os.environ.get("PORT", 5000))
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=not is_production,
        use_reloader=False,  # rooms live only in memory; a reload would wipe them
        allow_unsafe_werkzeug=True,  # needed when stdin isn't a tty (e.g. on a host)
    )
