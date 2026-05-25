/* app.js – ESP32 Tank Robot controller */
(function () {
  'use strict';

  const HOST = window.location.hostname;
  const STREAM_URL = `http://${HOST}:81/stream`;
  const WS_URL     = `ws://${HOST}:82`;

  // ── DOM refs ──
  const streamImg   = document.getElementById('stream');
  const speedLabel  = document.getElementById('speed-label');
  const joystickZone = document.getElementById('joystick-zone');

  // ── State ──
  let flashOn = false;
  let jx = 0, jy = 0;

  /* =====================================================
     WebSocket
  ===================================================== */
  let ws = null;
  let wsReconnectTimer = null;
  let wsConnected = false;

  // Throttle: отправляем только последнюю команду, не чаще чем раз в 50 мс
  let pendingCmd = null;
  let cmdTimer = null;
  const CMD_INTERVAL = 50; // ms

  function wsConnect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[WS] Connected');
      wsConnected = true;
      // Включить индикацию на странице (можно добавить CSS-класс)
      document.body.classList.add('ws-connected');
      // Отменить pending reconnect
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      wsConnected = false;
      document.body.classList.remove('ws-connected');
      // Авто-реконнект через 2 секунды
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.warn('[WS] Error', err);
      // onclose будет вызван следом
    };

    ws.onmessage = () => {
      // Сервер не шлёт сообщений, только команды приходят
    };
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      console.log('[WS] Attempting reconnect...');
      wsConnect();
    }, 2000);
  }

  // Отправка команды с защитой от флуда и с отправкой только последнего состояния
  function sendWsCommand(x, y) {
    if (!wsConnected) return;

    // Сохраняем последнюю команду
    pendingCmd = { x: Math.round(x), y: Math.round(y), t: Date.now() };

    // Если таймер уже запущен — не делаем ничего, ждём его срабатывания
    if (cmdTimer) return;

    cmdTimer = setTimeout(() => {
      cmdTimer = null;
      if (pendingCmd) {
        // Проверяем: если websocket ещё жив — шлём
        if (ws && ws.readyState === WebSocket.OPEN) {
          const json = JSON.stringify(pendingCmd);
          ws.send(json);
        }
        pendingCmd = null;
      }
    }, CMD_INTERVAL);
  }

  // Отправить команду немедленно (для остановки)
  function sendWsCommandImmediate(x, y) {
    // Отменяем pending таймер и команду
    if (cmdTimer) {
      clearTimeout(cmdTimer);
      cmdTimer = null;
    }
    pendingCmd = null;

    if (ws && ws.readyState === WebSocket.OPEN) {
      const json = JSON.stringify({
        x: Math.round(x),
        y: Math.round(y),
        t: Date.now()
      });
      ws.send(json);
    }
  }

  /* =====================================================
     MJPEG Stream (порт 81, HTTP)
  ===================================================== */
  streamImg.src = STREAM_URL;

  /* =====================================================
     Joystick (nipplejs)
  ===================================================== */
  const manager = nipplejs.create({
    zone: joystickZone,
    mode: 'static',
    position: { left: '50%', top: '50%' },
    color: '#42a5f5',
    size: 160,
    restOpacity: 0.7,
    dynamicPage: true
  });

  function updateSpeedDisplay() {
    let l, r;
    if (Math.abs(jy) < 10 && Math.abs(jx) >= 10) {
      l = jx;
      r = -jx;
    } else {
      l = jy + jx;
      r = jy - jx;
      const mx = Math.max(Math.abs(l), Math.abs(r));
      if (mx > 100) { l = l / mx * 100; r = r / mx * 100; }
    }
    speedLabel.textContent = `L: ${Math.round(l)}% | R: ${Math.round(r)}%`;
  }

  manager.on('move', (evt, data) => {
    const angle = data.angle.radian;
    const force = Math.min(data.force, 1.0);
    // nipplejs: y increases upward → invert
    jx = Math.cos(angle) * force * 100;
    jy = Math.sin(angle) * force * 100;
    updateSpeedDisplay();
    sendWsCommand(jx, jy);
  });

  manager.on('end', () => {
    jx = 0; jy = 0;
    updateSpeedDisplay();
    sendWsCommandImmediate(0, 0);
  });

  /* =====================================================
     Flash (всё ещё HTTP)
  ===================================================== */
  const btnFlash = document.getElementById('btn-flash');
  btnFlash.addEventListener('click', () => {
    flashOn = !flashOn;
    btnFlash.classList.toggle('active', flashOn);
    fetch(`${window.location.protocol}//${HOST}/config?flash=${flashOn ? 1 : 0}`).catch(() => {});
  });

  /* =====================================================
     Settings panel (всё ещё HTTP)
  ===================================================== */
  const settingsPanel = document.getElementById('settings-panel');
  const btnSettings   = document.getElementById('btn-settings');
  const btnClose      = document.getElementById('btn-close-settings');
  const btnApply      = document.getElementById('btn-apply');

  btnSettings.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));
  btnClose.addEventListener('click',    () => settingsPanel.classList.add('hidden'));

  function bindRange(id, labelId) {
    const input = document.getElementById(id);
    const label = document.getElementById(labelId);
    input.addEventListener('input', () => { label.textContent = input.value; });
  }
  bindRange('accel',      'accel-val');
  bindRange('quality',    'quality-val');
  bindRange('brightness', 'brightness-val');
  bindRange('contrast',   'contrast-val');
  bindRange('fps',        'fps-val');

  btnApply.addEventListener('click', () => {
    const params = new URLSearchParams({
      accel:      document.getElementById('accel').value,
      quality:    document.getElementById('quality').value,
      framesize:  document.getElementById('framesize').value,
      brightness: document.getElementById('brightness').value,
      contrast:   document.getElementById('contrast').value,
      fps:        document.getElementById('fps').value
    });
    fetch(`/config?${params}`)
      .then(() => {
        // Restart stream to apply new resolution
        streamImg.src = '';
        setTimeout(() => { streamImg.src = STREAM_URL; }, 500);
      })
      .catch(() => {});
    settingsPanel.classList.add('hidden');
  });

  /* =====================================================
     Prevent scroll on joystick
  ===================================================== */
  joystickZone.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

  /* =====================================================
     WASD keyboard with ACCELERATION
  ===================================================== */
  const keys = { w: false, a: false, s: false, d: false, space: false };

  let kbSpeedY = 0;
  let kbTurn   = 0;

  const ACCEL_RATE     = 4;
  const BRAKE_RATE     = 8;
  const KB_INTERVAL    = 40;  // ms
  const MIN_SPEED      = 20;
  const SPOT_TURN_VAL  = 40;
  const DRIVE_TURN_VAL = 55;

  let kbLastTick = 0;
  let kbTickTimer = null;

  // Преобразуем kbSpeedY + kbTurn в x,y для WebSocket
  function sendKbState() {
    let x = 0, y = kbSpeedY;

    if (kbTurn !== 0) {
      if (Math.abs(kbSpeedY) < 10) {
        x = kbTurn * SPOT_TURN_VAL;
        y = 0;
      } else {
        x = kbTurn * DRIVE_TURN_VAL;
      }
    }

    if (x !== 0 && y !== 0) {
      const len = Math.sqrt(x * x + y * y);
      if (len > 100) {
        x = x / len * 100;
        y = y / len * 100;
      }
    }

    if (Math.abs(kbSpeedY) < MIN_SPEED && kbSpeedY !== 0) {
      y = kbSpeedY > 0 ? MIN_SPEED : -MIN_SPEED;
    }

    speedLabel.textContent = `L: ${Math.round(y + x)}% | R: ${Math.round(y - x)}%`;
    sendWsCommand(Math.round(x), Math.round(y));
  }

  function kbTick() {
    const now = Date.now();
    if (now - kbLastTick < KB_INTERVAL) return;
    kbLastTick = now;

    if (keys.w && !keys.s) {
      if (kbSpeedY < 0) {
        kbSpeedY = Math.min(kbSpeedY + BRAKE_RATE, 0);
      } else {
        kbSpeedY = Math.min(kbSpeedY + ACCEL_RATE, 100);
      }
    } else if (keys.s && !keys.w) {
      if (kbSpeedY > 0) {
        kbSpeedY = Math.max(kbSpeedY - BRAKE_RATE, 0);
      } else {
        kbSpeedY = Math.max(kbSpeedY - ACCEL_RATE, -100);
      }
    } else if (keys.w && keys.s) {
      if (kbSpeedY > 0) {
        kbSpeedY = Math.max(kbSpeedY - BRAKE_RATE * 2, 0);
      } else if (kbSpeedY < 0) {
        kbSpeedY = Math.min(kbSpeedY + BRAKE_RATE * 2, 0);
      }
    } else {
      if (kbSpeedY > 0) {
        kbSpeedY = Math.max(kbSpeedY - BRAKE_RATE, 0);
      } else if (kbSpeedY < 0) {
        kbSpeedY = Math.min(kbSpeedY + BRAKE_RATE, 0);
      }
    }

    sendKbState();
  }

  function updateTurn() {
    if (keys.a && !keys.d) {
      kbTurn = -1;
    } else if (keys.d && !keys.a) {
      kbTurn = 1;
    } else {
      kbTurn = 0;
    }
    sendKbState();
  }

  function startKbLoop() {
    if (kbTickTimer) return;
    kbLastTick = Date.now();
    kbTickTimer = setInterval(kbTick, KB_INTERVAL);
  }

  function stopKbLoop() {
    if (kbTickTimer) {
      clearInterval(kbTickTimer);
      kbTickTimer = null;
    }
  }

  // Keyboard handlers
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (key === ' ') {
      e.preventDefault();
      if (!keys.space) {
        keys.space = true;
        kbSpeedY = 0;
        kbTurn = 0;
        sendWsCommandImmediate(0, 0);
        speedLabel.textContent = 'L: 0% | R: 0%';
        stopKbLoop();
      }
      return;
    }

    if (key === 'w' || key === 's') {
      e.preventDefault();
      if (!keys[key]) {
        keys[key] = true;
        if (keys.space) { keys.space = false; }
        startKbLoop();
      }
    }

    if (key === 'a' || key === 'd') {
      e.preventDefault();
      if (!keys[key]) {
        keys[key] = true;
        if (keys.space) { keys.space = false; }
        updateTurn();
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (key === ' ') {
      e.preventDefault();
      keys.space = false;
      if (keys.w || keys.a || keys.s || keys.d) {
        startKbLoop();
      }
      return;
    }

    if (key === 'w' || key === 's') {
      e.preventDefault();
      keys[key] = false;
    }

    if (key === 'a' || key === 'd') {
      e.preventDefault();
      keys[key] = false;
      updateTurn();
    }
  });

  // Prevent scroll
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (['w','a','s','d',' ','arrowup','arrowdown','arrowleft','arrowright'].includes(key)) {
      const tag = e.target.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        e.preventDefault();
      }
    }
  });

  // Stop loop when idle
  setInterval(() => {
    if (kbTickTimer && kbSpeedY === 0 && kbTurn === 0) {
      if (!keys.w && !keys.a && !keys.s && !keys.d && !keys.space) {
        stopKbLoop();
        sendWsCommandImmediate(0, 0);
        speedLabel.textContent = 'L: 0% | R: 0%';
      }
    }
  }, 200);

  /* =====================================================
     Init WebSocket connection
  ===================================================== */
  wsConnect();

  // При потери фокуса окном — останавливаемся (безопасность)
  window.addEventListener('blur', () => {
    // Сбрасываем клавиши, останавливаем моторы
    keys.w = keys.a = keys.s = keys.d = keys.space = false;
    kbSpeedY = 0;
    kbTurn = 0;
    stopKbLoop();
    sendWsCommandImmediate(0, 0);
    speedLabel.textContent = 'L: 0% | R: 0%';
  });

})();