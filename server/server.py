"""
server.py — Прокси-сервер-посредник между ESP32 и браузерными клиентами.

Архитектура:
  Браузер пользователя ←→ Python-сервер (aiohttp) ←→ ESP32

Функции:
  1. MJPEG-ретрансляция: GET /stream — читает MJPEG с ESP32, раздаёт всем клиентам
  2. WebSocket-прокси: /ws — принимает WS от браузеров:
     - Обычный пользователь: представляется именем (без пароля)
     - Администратор: вводит пароль, получает права управления
     - Администратор может указать IP робота через WS-сообщение
  3. Статика: раздача index.html, app.js, style.css, nipplejs.min.js из ./www
  4. Прокси /config: GET /config → ESP32 /config
"""

import asyncio
import logging
import json
import time
import os
from typing import Optional

import aiohttp
from aiohttp import web

# ──────────────────────────────────────────────
# Конфигурация (вынесена в переменные)
# ──────────────────────────────────────────────
ESP32_HOST = "192.168.0.9"          # IP адрес ESP32 (AP mode) — по умолчанию
# ESP32_HOST = "10.153.61.63"          # IP адрес ESP32 (AP mode) — по умолчанию
ESP32_HTTP_PORT = 80                 # HTTP порт ESP32 (статика + /config)
ESP32_MJPEG_PORT = 81                # MJPEG порт ESP32
ESP32_WS_PORT = 82                   # WebSocket порт ESP32

SERVER_HOST = "0.0.0.0"              # На каком интерфейсе слушать
SERVER_PORT = 8080                   # Порт сервера-посредника

ADMIN_PASSWORD = "12345"             # Пароль администратора

MJPEG_RECONNECT_DELAY = 2.0          # Секунд между попытками переподключения MJPEG
WS_RECONNECT_DELAY = 2.0             # Секунд между попытками переподключения WS к ESP32
STATUS_BROADCAST_INTERVAL = 3.0      # Секунд между рассылкой статуса клиентам

# Абсолютный путь к папке со статикой (рядом с server.py)
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")

# ──────────────────────────────────────────────
# LLM / ИИ-бот (OpenAI-совместимый провайдер)
# ──────────────────────────────────────────────
LLM_ENABLED = True                        # включить/выключить ИИ-бота
LLM_BASE_URL = "https://ai.api.cloud.yandex.net/v1"  # OpenAI-совместимый endpoint
LLM_API_KEY  = ""                   # API-ключ
LLM_MODEL    = "gpt://b1g7q3l95b534eaueb63/aliceai-llm-flash/latest"              # модель
LLM_BOT_NAME = "Ассистент"               # имя бота в чате

LLM_SYSTEM_PROMPT = """Ты — помощник зрителей трансляции робота-танка ESP32.
Отвечай кратко (1-3 предложения), по-русски, дружелюбно.
Ты можешь отвечать на вопросы о роботе, управлении, камере и трансляции. При получении запроса "qr: Этап 1" расскажи о технических характеристиках колесной платформы робота, о танковой схеме и принципах управления платформой. При получении запроса "qr: Этап 2" расскажи о программных возможностях платформы ESP32 - cam.
Если вопрос не по теме — вежливо перенаправь обратно к теме робота."""

LLM_QUESTION_PROMPT = """Определи, содержит ли следующее сообщение прямую команду или запрос на управление роботом: движение вперёд/назад, поворот, разворот, остановка, изменение скорости, экстренная остановка, управление мотором, либо иную инструкцию, которую можно интерпретировать как команду управления.

Ответь строго одним словом:
NO — если сообщение является командой или запросом на управление роботом;
YES — если это обычное сообщение по теме обсуждения, вопрос о проекте, комментарий, уточнение, приветствие или любой другой текст, не являющийся командой управления.

Сообщение: \"{text}\""""

# ──────────────────────────────────────────────
# Логирование
# ──────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("proxy")

# ──────────────────────────────────────────────
# Состояние сервера
# ──────────────────────────────────────────────
class ClientInfo:
    """Информация о подключённом клиенте."""
    def __init__(self, ws: web.WebSocketResponse, name: str = "Аноним"):
        self.ws = ws
        self.name = name
        self.is_admin = False

class ServerState:
    def __init__(self):
        # Все WebSocket-клиенты (браузеры)
        self.clients: dict[web.WebSocketResponse, ClientInfo] = {}
        # Администратор (только один)
        self.admin: Optional[ClientInfo] = None
        # Очередь для MJPEG-кадров от ESP32
        self.mjpeg_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=10)
        # Флаг: есть ли связь с ESP32
        self.esp32_online: bool = False
        # WebSocket соединение с ESP32
        self.esp32_ws: Optional[aiohttp.ClientWebSocketResponse] = None
        # Сессия aiohttp для HTTP-запросов к ESP32
        self.http_session: Optional[aiohttp.ClientSession] = None
        # Последний полученный MJPEG-фрейм (для отдачи при потере связи)
        self.last_frame: Optional[bytes] = None
        # Текущий ESP32_HOST (может быть изменён администратором)
        self.esp32_host: str = ESP32_HOST

    @property
    def viewer_count(self) -> int:
        return len(self.clients)

    @property
    def admin_online(self) -> bool:
        return self.admin is not None and not self.admin.ws.closed

    def get_client_names(self) -> list[str]:
        """Возвращает список имён всех клиентов."""
        return [info.name for info in self.clients.values()]


state = ServerState()


# ──────────────────────────────────────────────
# MJPEG-ретрансляция
# ──────────────────────────────────────────────
async def mjpeg_reader():
    """Читает MJPEG-поток с ESP32 и кладёт кадры в очередь.
    
    Парсит multipart/x-mixed-replace поток через границы (boundary).
    ESP32 обычно использует границу вида "--frame" или "--boundary".
    """
    while True:
        try:
            mjpeg_url = f"http://{state.esp32_host}:{ESP32_MJPEG_PORT}/stream"
            log.info(f"[MJPEG] Connecting to {mjpeg_url} ...")
            async with state.http_session.get(
                mjpeg_url,
                timeout=aiohttp.ClientTimeout(total=0, sock_read=30),
            ) as resp:
                if resp.status != 200:
                    log.warning(f"[MJPEG] ESP32 returned status {resp.status}")
                    await asyncio.sleep(MJPEG_RECONNECT_DELAY)
                    continue

                state.esp32_online = True
                log.info("[MJPEG] Connected, reading stream...")

                # Определяем границу из Content-Type (используем headers, т.к.
                # resp.content_type возвращает только MIME-тип без параметров)
                content_type_header = resp.headers.get("Content-Type", "")
                boundary = None
                if "boundary" in content_type_header:
                    for part in content_type_header.split(";"):
                        part = part.strip()
                        if part.startswith("boundary"):
                            _, _, bval = part.partition("=")
                            bval = bval.strip().strip('"').strip("'")
                            if bval:
                                boundary = bval.encode()
                                break

                # Если граница не определена — пробуем стандартные варианты ESP32
                if not boundary:
                    # ESP32 часто использует "frame" как boundary
                    boundary = b"frame"

                log.info(f"[MJPEG] Using boundary: {boundary!r}")

                # Читаем поток, разбивая по границам
                # Формат: \r\n--boundary\r\nContent-Type: image/jpeg\r\n\r\n<JPEG data>\r\n
                boundary_marker = b"--" + boundary
                buffer = b""
                frame_start_marker = b"\r\n\r\n"  # разделитель заголовков и тела

                async for chunk in resp.content.iter_chunked(4096):
                    buffer += chunk
                    
                    # Ищем границу
                    while True:
                        bpos = buffer.find(boundary_marker)
                        if bpos == -1:
                            # Если буфер слишком большой — обрежем до последних 100 КБ
                            if len(buffer) > 200 * 1024:
                                # Ищем последнее вхождение JPEG-маркера
                                last_jpeg = buffer.rfind(b"\xff\xd8\xff")
                                if last_jpeg > 0:
                                    buffer = buffer[last_jpeg:]
                                else:
                                    buffer = buffer[-100 * 1024:]
                            break

                        # Нашли границу — ищем конец этой границы (\r\n после неё)
                        eol = buffer.find(b"\r\n", bpos + len(boundary_marker))
                        if eol == -1:
                            break

                        # Ищем разделитель заголовков \r\n\r\n после границы
                        headers_end = buffer.find(frame_start_marker, eol + 2)
                        if headers_end == -1:
                            break

                        # Тело JPEG начинается после \r\n\r\n
                        data_start = headers_end + len(frame_start_marker)
                        
                        # Ищем следующую границу, чтобы определить конец текущего кадра
                        next_bpos = buffer.find(boundary_marker, data_start)
                        if next_bpos == -1:
                            # Следующей границы ещё нет — ждём ещё данных
                            break

                        # Извлекаем JPEG-данные (между \r\n\r\n и следующей границей)
                        frame_data = buffer[data_start:next_bpos]
                        # Убираем trailing \r\n
                        frame_data = frame_data.rstrip(b"\r\n")

                        if frame_data:
                            state.last_frame = frame_data
                            try:
                                state.mjpeg_queue.put_nowait(frame_data)
                            except asyncio.QueueFull:
                                try:
                                    state.mjpeg_queue.get_nowait()
                                    state.mjpeg_queue.put_nowait(frame_data)
                                except asyncio.QueueEmpty:
                                    pass

                        # Сдвигаем буфер до конца обработанной границы
                        buffer = buffer[next_bpos:]

        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            log.warning(f"[MJPEG] Connection error: {exc}")
            state.esp32_online = False
            await asyncio.sleep(MJPEG_RECONNECT_DELAY)


async def mjpeg_broadcaster(request: web.Request):
    """HTTP-эндпоинт: отдаёт MJPEG-поток браузеру."""
    response = web.StreamResponse(
        status=200,
        reason="OK",
        headers={
            "Content-Type": "multipart/x-mixed-replace; boundary=frame",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Access-Control-Allow-Origin": "*",
        },
    )
    await response.prepare(request)

    client_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=5)

    if state.last_frame:
        try:
            client_queue.put_nowait(state.last_frame)
        except asyncio.QueueFull:
            pass

    broadcaster_id = id(client_queue)
    broadcasters[client_queue] = broadcaster_id
    log.info(f"[MJPEG] Client {broadcaster_id} connected")

    try:
        while True:
            try:
                frame = await asyncio.wait_for(client_queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                try:
                    await response.write(b"--frame\r\n")
                except (ConnectionResetError, ConnectionAbortedError):
                    break
                continue

            try:
                await response.write(
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n"
                    + b"\r\n"
                    + frame
                    + b"\r\n"
                )
            except (ConnectionResetError, ConnectionAbortedError, OSError):
                break
    finally:
        broadcasters.pop(client_queue, None)
        log.info(f"[MJPEG] Client {broadcaster_id} disconnected")

    return response


broadcasters: dict[asyncio.Queue[bytes], int] = {}


async def mjpeg_distributor():
    """Берёт кадры из очереди и рассылает всем подписчикам."""
    while True:
        frame = await state.mjpeg_queue.get()
        dead_queues = []
        for q in broadcasters:
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(frame)
                except asyncio.QueueEmpty:
                    pass
            except Exception:
                dead_queues.append(q)

        for q in dead_queues:
            broadcasters.pop(q, None)


# ──────────────────────────────────────────────
# WebSocket-прокси (управление)
# ──────────────────────────────────────────────
async def ws_handler(request: web.Request):
    """WebSocket-эндпоинт для браузеров."""
    ws = web.WebSocketResponse(max_msg_size=8192)
    await ws.prepare(request)

    # Создаём запись клиента (пока аноним)
    client = ClientInfo(ws)
    state.clients[ws] = client
    log.info(f"[WS] Client connected. Total: {len(state.clients)}")

    # Отправляем приветственный статус
    await send_status(ws)

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                await handle_ws_message(client, msg.data)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                log.warning(f"[WS] Client error: {ws.exception()}")
    except Exception as exc:
        log.warning(f"[WS] Client exception: {exc}")
    finally:
        state.clients.pop(ws, None)
        # Если это был администратор — снимаем права
        if state.admin is client:
            state.admin = None
            log.info("[WS] Admin disconnected, sending stop to ESP32")
            await send_stop_to_esp32()
        log.info(f"[WS] Client disconnected. Total: {len(state.clients)}")
        # Если не осталось ни одного клиента — сбрасываем историю LLM
        if len(state.clients) == 0:
            llm_reset_history()

    return ws


async def handle_ws_message(client: ClientInfo, data: str):
    """Обрабатывает входящее сообщение от браузера."""
    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        return

    msg_type = payload.get("type", "")

    if msg_type == "auth":
        await handle_auth(client, payload)
    elif msg_type == "join":
        await handle_join(client, payload)
    elif msg_type == "set_esp32_ip":
        await handle_set_esp32_ip(client, payload)
    elif msg_type == "chat":
        await handle_chat(client, payload)
    elif msg_type == "":
        # Команда движения (без type — просто {"x": ..., "y": ..., "t": ...})
        await handle_command(client, payload)


async def handle_join(client: ClientInfo, payload: dict):
    """Обрабатывает вход обычного пользователя (без пароля, только имя)."""
    name = payload.get("name", "").strip()
    if not name:
        name = "Аноним"
    client.name = name
    client.is_admin = False
    await client.ws.send_json({
        "type": "join",
        "status": "ok",
        "name": client.name,
    })
    log.info(f"[WS] User joined: {client.name}")


async def handle_auth(client: ClientInfo, payload: dict):
    """Обрабатывает попытку авторизации администратора."""
    password = payload.get("password", "")

    if state.admin is not None and state.admin is not client and not state.admin.ws.closed:
        await client.ws.send_json({
            "type": "auth",
            "status": "busy",
            "message": "Admin already connected",
        })
        return

    if password == ADMIN_PASSWORD:
        # Назначаем администратором
        state.admin = client
        client.is_admin = True
        # Если пользователь уже представился — сохраняем имя
        name = payload.get("name", "").strip()
        if name:
            client.name = name
        await client.ws.send_json({
            "type": "auth",
            "status": "ok",
            "role": "admin",
            "name": client.name,
        })
        log.info(f"[WS] Admin authenticated: {client.name}")
    else:
        await client.ws.send_json({
            "type": "auth",
            "status": "error",
            "message": "Wrong password",
        })


async def handle_set_esp32_ip(client: ClientInfo, payload: dict):
    """Обрабатывает смену IP адреса ESP32 (только администратор)."""
    if not client.is_admin:
        return

    new_ip = payload.get("ip", "").strip()
    if not new_ip:
        await client.ws.send_json({
            "type": "set_esp32_ip",
            "status": "error",
            "message": "IP address is empty",
        })
        return

    # Простейшая валидация IP
    parts = new_ip.split(".")
    if len(parts) != 4 or not all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        await client.ws.send_json({
            "type": "set_esp32_ip",
            "status": "error",
            "message": "Invalid IP address format",
        })
        return

    old_ip = state.esp32_host
    state.esp32_host = new_ip
    log.info(f"[WS] ESP32 IP changed by admin: {old_ip} -> {new_ip}")

    await client.ws.send_json({
        "type": "set_esp32_ip",
        "status": "ok",
        "ip": new_ip,
    })

    # Перезапустим MJPEG и WS коннекторы (они сами переподключатся с новым IP)
    # Просто сбросим флаг — задачи переподключатся автоматически
    state.esp32_online = False


async def handle_command(client: ClientInfo, payload: dict):
    """Обрабатывает команду движения. Только от администратора."""
    if not client.is_admin:
        return

    if state.esp32_ws and not state.esp32_ws.closed:
        try:
            await state.esp32_ws.send_json(payload)
        except (ConnectionResetError, ConnectionAbortedError, TypeError):
            log.warning("[WS] Failed to send command to ESP32")
    else:
        log.warning("[WS] ESP32 WebSocket not connected, command dropped")


async def send_stop_to_esp32():
    """Отправляет команду остановки на ESP32."""
    stop_cmd = {"x": 0, "y": 0, "t": int(time.time() * 1000)}
    if state.esp32_ws and not state.esp32_ws.closed:
        try:
            await state.esp32_ws.send_json(stop_cmd)
        except Exception:
            pass


# ──────────────────────────────────────────────
# История LLM-сессии
# ──────────────────────────────────────────────
llm_history: list[dict] = []  # сообщения вида {"role": "user"/"assistant", "content": "..."}

def llm_reset_history():
    """Сбрасывает историю LLM-диалога."""
    global llm_history
    llm_history = []
    log.info("[LLM] History reset (all clients disconnected)")

def llm_add_message(role: str, content: str):
    """Добавляет сообщение в историю LLM."""
    global llm_history
    llm_history.append({"role": role, "content": content})
    # Ограничиваем историю последними 20 сообщениями
    if len(llm_history) > 20:
        llm_history = llm_history[-20:]

# ──────────────────────────────────────────────
# Чат и ИИ-бот
# ──────────────────────────────────────────────
async def broadcast_json(msg: dict):
    """Рассылает JSON-сообщение всем подключённым клиентам."""
    dead_clients = []
    for ws, client in list(state.clients.items()):
        try:
            if not ws.closed:
                await ws.send_json(msg)
        except Exception:
            dead_clients.append(ws)
    for ws in dead_clients:
        state.clients.pop(ws, None)


async def handle_chat(client: ClientInfo, payload: dict):
    """Обрабатывает чат-сообщение от клиента."""
    text = payload.get("text", "").strip()
    if not text or len(text) > 300:
        return

    chat_msg = {
        "type": "chat",
        "name": client.name,
        "text": text,
        "is_admin": client.is_admin,
        "ts": time.time(),
    }
    await broadcast_json(chat_msg)

    # Запускаем проверку на ИИ-ответ (не блокируем обработку)
    asyncio.create_task(llm_check_and_reply(text, client.name))


async def llm_check_and_reply(text: str, sender_name: str):
    """Проверяет, является ли сообщение вопросом, и при необходимости генерирует ответ ИИ."""
    if not LLM_ENABLED:
        return

    timeout = aiohttp.ClientTimeout(total=15.0)
    headers = {
        "Authorization": f"Bearer {LLM_API_KEY}",
        "Content-Type": "application/json",
    }

    # Шаг 1: проверка вопросительной интонации
    try:
        question_prompt = LLM_QUESTION_PROMPT.format(text=text)
        async with state.http_session.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers=headers,
            json={
                "model": LLM_MODEL,
                "messages": [{"role": "user", "content": question_prompt}],
                "max_tokens": 5,
                "temperature": 0,
            },
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                log.warning(f"[LLM] Question check returned status {resp.status}")
                return
            data = await resp.json()
            answer = data["choices"][0]["message"]["content"].strip().upper()
            if "YES" not in answer:
                return
    except (aiohttp.ClientError, KeyError, json.JSONDecodeError, asyncio.TimeoutError) as exc:
        log.warning(f"[LLM] Question check error: {exc}")
        return

    # Добавляем сообщение пользователя в историю
    llm_add_message("user", text)

    # Шаг 2: генерация ответа с учётом истории
    try:
        # Формируем полный список сообщений: system + история
        messages = [{"role": "system", "content": LLM_SYSTEM_PROMPT}] + llm_history

        async with state.http_session.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers=headers,
            json={
                "model": LLM_MODEL,
                "messages": messages,
                "max_tokens": 150,
                "temperature": 0.7,
            },
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                log.warning(f"[LLM] Reply generation returned status {resp.status}")
                # Удаляем сообщение пользователя из истории при ошибке
                if llm_history and llm_history[-1]["role"] == "user":
                    llm_history.pop()
                return
            data = await resp.json()
            reply_text = data["choices"][0]["message"]["content"].strip()
    except (aiohttp.ClientError, KeyError, json.JSONDecodeError, asyncio.TimeoutError) as exc:
        log.warning(f"[LLM] Reply generation error: {exc}")
        # Удаляем сообщение пользователя из истории при ошибке
        if llm_history and llm_history[-1]["role"] == "user":
            llm_history.pop()
        return

    # Добавляем ответ ассистента в историю
    llm_add_message("assistant", reply_text)

    # Отправляем ответ бота в чат
    bot_msg = {
        "type": "chat",
        "name": LLM_BOT_NAME,
        "text": reply_text,
        "is_admin": False,
        "is_ai": True,
        "ts": time.time(),
    }
    await broadcast_json(bot_msg)


# ──────────────────────────────────────────────
# WebSocket-соединение с ESP32
# ──────────────────────────────────────────────
async def esp32_ws_connector():
    """Поддерживает WebSocket-соединение с ESP32."""
    while True:
        try:
            ws_url = f"ws://{state.esp32_host}:{ESP32_WS_PORT}"
            log.info(f"[ESP32-WS] Connecting to {ws_url} ...")
            async with state.http_session.ws_connect(
                ws_url,
                timeout=10.0,
                heartbeat=30.0,
            ) as ws:
                state.esp32_ws = ws
                log.info("[ESP32-WS] Connected")
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        pass
                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        break
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            log.warning(f"[ESP32-WS] Connection error: {exc}")
        finally:
            state.esp32_ws = None
            log.info("[ESP32-WS] Disconnected")
            await send_stop_to_esp32()
            await asyncio.sleep(WS_RECONNECT_DELAY)


# ──────────────────────────────────────────────
# Статус-рассылка
# ──────────────────────────────────────────────
async def status_broadcaster():
    """Периодически рассылает статус всем подключённым клиентам."""
    while True:
        await asyncio.sleep(STATUS_BROADCAST_INTERVAL)
        client_names = state.get_client_names()
        status_msg = {
            "type": "status",
            "viewers": state.viewer_count,
            "admin_online": state.admin_online,
            "esp32_online": state.esp32_online,
            "esp32_ip": state.esp32_host,
            "clients": client_names,
        }
        dead_clients = []
        for ws, client in list(state.clients.items()):
            try:
                if not ws.closed:
                    await ws.send_json(status_msg)
            except Exception:
                dead_clients.append(ws)

        for ws in dead_clients:
            state.clients.pop(ws, None)


async def send_status(ws: web.WebSocketResponse):
    """Отправляет текущий статус одному клиенту."""
    try:
        client_names = state.get_client_names()
        await ws.send_json({
            "type": "status",
            "viewers": state.viewer_count,
            "admin_online": state.admin_online,
            "esp32_online": state.esp32_online,
            "esp32_ip": state.esp32_host,
            "clients": client_names,
        })
    except Exception:
        pass


# ──────────────────────────────────────────────
# Прокси /config
# ──────────────────────────────────────────────
async def config_proxy(request: web.Request):
    """Проксирует GET /config к ESP32."""
    query = request.query_string
    esp32_url = f"http://{state.esp32_host}:{ESP32_HTTP_PORT}/config"
    if query:
        esp32_url += "?" + query

    try:
        async with state.http_session.get(
            esp32_url,
            timeout=aiohttp.ClientTimeout(total=10.0),
        ) as resp:
            body = await resp.read()
            return web.Response(
                body=body,
                status=resp.status,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Content-Type": resp.content_type or "application/octet-stream",
                },
            )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
        log.warning(f"[Config] Proxy error: {exc}")
        return web.Response(
            status=502,
            text=json.dumps({"error": "Cannot reach ESP32"}),
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )


# ──────────────────────────────────────────────
# Запуск сервера
# ──────────────────────────────────────────────
async def on_startup(app: web.Application):
    """Инициализация при старте."""
    state.http_session = aiohttp.ClientSession()
    asyncio.create_task(mjpeg_reader())
    asyncio.create_task(mjpeg_distributor())
    asyncio.create_task(esp32_ws_connector())
    asyncio.create_task(status_broadcaster())
    log.info(f"Server starting on {SERVER_HOST}:{SERVER_PORT}")
    log.info(f"ESP32 target: {state.esp32_host}")
    log.info(f"Admin password: {ADMIN_PASSWORD}")
    log.info(f"Static dir: {STATIC_DIR}")


async def on_shutdown(app: web.Application):
    """Очистка при остановке."""
    if state.http_session:
        await state.http_session.close()
    log.info("Server shutdown")


def create_app() -> web.Application:
    """Создаёт и настраивает aiohttp приложение."""
    app = web.Application()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)

    # Маршруты
    app.router.add_get("/stream", mjpeg_broadcaster)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/config", config_proxy)

    # Статика
    app.router.add_static("/", STATIC_DIR, show_index=True)

    return app


if __name__ == "__main__":
    app = create_app()
    web.run_app(app, host=SERVER_HOST, port=SERVER_PORT, print=lambda *a: log.info(*a))
