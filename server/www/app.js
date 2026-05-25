/* app.js – Tank Robot controller (через Python-посредник) */
(function () {
  'use strict';

  const HOST = window.location.hostname;
  const PORT = 8080;
  const STREAM_URL = `http://${HOST}:${PORT}/stream`;
  const WS_URL     = `ws://${HOST}:${PORT}/ws`;

  // ── DOM refs ──
  const streamImg      = document.getElementById('stream');
  const speedLabel     = document.getElementById('speed-label');
  const joystickZone   = document.getElementById('joystick-zone');
  const statusEl       = document.getElementById('status-text');
  const joinForm       = document.getElementById('join-form');
  const joinNameInput  = document.getElementById('join-name');
  const joinBtn        = document.getElementById('join-btn');
  const joinError      = document.getElementById('join-error');
  const authForm       = document.getElementById('auth-form');
  const authPassword   = document.getElementById('auth-password');
  const authBtn        = document.getElementById('auth-btn');
  const authError      = document.getElementById('auth-error');
  const mainContent    = document.getElementById('main-content');
  const adminPanel     = document.getElementById('admin-panel');
  const esp32IpInput   = document.getElementById('esp32-ip');
  const esp32IpBtn     = document.getElementById('esp32-ip-btn');
  const esp32IpStatus  = document.getElementById('esp32-ip-status');
  const btnAdmin       = document.getElementById('btn-admin');
  const authCancel     = document.getElementById('auth-cancel');
  const controlsEl     = document.getElementById('controls');

  // ── Chat DOM refs ──
  const chatMessages   = document.getElementById('chat-messages');
  const chatInput      = document.getElementById('chat-input');
  const chatSendBtn    = document.getElementById('chat-send-btn');

  // ── State ──
  let flashOn = false;
  let jx = 0, jy = 0;
  let isAdmin = false;
  let isAuthenticating = false;
  let userName = '';
  let esp32Ip = '';

  /* =====================================================
     WebSocket
  ===================================================== */
  let ws = null;
  let wsReconnectTimer = null;
  let wsConnected = false;

  let pendingCmd = null;
  let cmdTimer = null;
  const CMD_INTERVAL = 50;

  function wsConnect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[WS] Connected');
      wsConnected = true;
      document.body.classList.add('ws-connected');
      updateStatusUI();
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      wsConnected = false;
      isAdmin = false;
      document.body.classList.remove('ws-connected');
      updateControlsVisibility();
      updateStatusUI();
      stopQrScanner();
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.warn('[WS] Error', err);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        console.warn('[WS] Invalid message', e);
      }
    };
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'status':
        updateStatusUI(msg);
        break;
      case 'join':
        handleJoinResponse(msg);
        break;
      case 'auth':
        handleAuthResponse(msg);
        break;
      case 'set_esp32_ip':
        handleSetEsp32IpResponse(msg);
        break;
      case 'chat':
        appendChatMessage(msg);
        break;
    }
  }

  function handleJoinResponse(msg) {
    if (msg.status === 'ok') {
      userName = msg.name;
      joinForm.classList.add('hidden');
      mainContent.classList.remove('hidden');
      // Запускаем MJPEG-стрим только после того, как контейнер стал видимым
      // Используем requestAnimationFrame, чтобы браузер успел отрендерить элемент
      requestAnimationFrame(() => { streamImg.src = STREAM_URL; });
      updateControlsVisibility();
      updateStatusUI();
      console.log(`[Join] Joined as ${userName}`);
    }
  }

  function handleAuthResponse(msg) {
    isAuthenticating = false;
    if (msg.status === 'ok' && msg.role === 'admin') {
      isAdmin = true;
      authForm.classList.add('hidden');
      authError.textContent = '';
      updateControlsVisibility();
      updateStatusUI();
      console.log('[Auth] Admin authenticated');
    } else if (msg.status === 'busy') {
      authError.textContent = '❌ Администратор уже подключён';
      authPassword.value = '';
    } else if (msg.status === 'error') {
      authError.textContent = '❌ ' + (msg.message || 'Неверный пароль');
      authPassword.value = '';
    }
  }

  function handleSetEsp32IpResponse(msg) {
    if (msg.status === 'ok') {
      esp32IpStatus.textContent = `✅ IP изменён на ${msg.ip}`;
      esp32IpStatus.className = 'ip-status-ok';
      esp32Ip = msg.ip;
    } else {
      esp32IpStatus.textContent = '❌ ' + (msg.message || 'Ошибка');
      esp32IpStatus.className = 'ip-status-error';
    }
  }

  function updateControlsVisibility() {
    // Показываем элементы управления только администратору (поверх видео)
    if (isAdmin) {
      controlsEl.classList.remove('hidden');
      btnAdmin.textContent = '⚙️ Панель администратора';
    } else {
      controlsEl.classList.add('hidden');
      btnAdmin.textContent = '🔑 Стать администратором';
    }
  }

  function updateStatusUI(statusMsg) {
    if (!statusMsg) {
      statusEl.textContent = wsConnected ? '🟡 Подключено' : '🔴 Отключено';
      return;
    }

    const { viewers, admin_online, esp32_online, esp32_ip, clients } = statusMsg;
    let roleText = '';
    if (isAdmin) {
      roleText = '🎮 Администратор';
    } else if (userName) {
      roleText = `👤 ${userName}`;
    } else {
      roleText = '👤 Зритель';
    }

    const espStatus = esp32_online ? '🟢 ESP32 онлайн' : '🔴 ESP32 оффлайн';
    const adminStatus = admin_online ? '🎮 Админ в сети' : '👤 Админа нет';
    statusEl.textContent = `${roleText} | ${espStatus} | ${adminStatus} | 👥 ${viewers}`;

    // Обновляем IP в поле для админа
    if (esp32_ip && esp32IpInput) {
      esp32IpInput.value = esp32_ip;
    }
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      console.log('[WS] Attempting reconnect...');
      wsConnect();
    }, 2000);
  }

  function sendWsCommand(x, y) {
    if (!wsConnected || !isAdmin) return;

    pendingCmd = { x: Math.round(x), y: Math.round(y), t: Date.now() };

    if (cmdTimer) return;

    cmdTimer = setTimeout(() => {
      cmdTimer = null;
      if (pendingCmd) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(pendingCmd));
        }
        pendingCmd = null;
      }
    }, CMD_INTERVAL);
  }

  function sendWsCommandImmediate(x, y) {
    if (!wsConnected || !isAdmin) return;

    if (cmdTimer) {
      clearTimeout(cmdTimer);
      cmdTimer = null;
    }
    pendingCmd = null;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        x: Math.round(x),
        y: Math.round(y),
        t: Date.now()
      }));
    }
  }

  function sendJoin(name) {
    if (!wsConnected) return;
    ws.send(JSON.stringify({ type: 'join', name: name }));
  }

  function sendAuth(password) {
    if (!wsConnected || isAuthenticating) return;
    isAuthenticating = true;
    ws.send(JSON.stringify({ type: 'auth', password: password, name: userName }));
  }

  function sendSetEsp32Ip(ip) {
    if (!wsConnected || !isAdmin) return;
    ws.send(JSON.stringify({ type: 'set_esp32_ip', ip: ip }));
  }

  /* =====================================================
     Joystick (nipplejs)
  ===================================================== */
  const manager = nipplejs.create({
    zone: joystickZone,
    mode: 'static',
    position: { left: '50%', top: '50%' },
    color: '#1565c0',
    size: 140,
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
    if (!isAdmin) return;
    const angle = data.angle.radian;
    const force = Math.min(data.force, 1.0);
    jx = Math.cos(angle) * force * 100;
    jy = Math.sin(angle) * force * 100;
    updateSpeedDisplay();
    sendWsCommand(jx, jy);
  });

  manager.on('end', () => {
    if (!isAdmin) return;
    jx = 0; jy = 0;
    updateSpeedDisplay();
    sendWsCommandImmediate(0, 0);
  });

  /* =====================================================
     Flash
  ===================================================== */
  const btnFlash = document.getElementById('btn-flash');
  btnFlash.addEventListener('click', () => {
    flashOn = !flashOn;
    btnFlash.classList.toggle('active', flashOn);
    fetch(`/config?flash=${flashOn ? 1 : 0}`).catch(() => {});
  });

  /* =====================================================
     Settings panel
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
     WASD keyboard
  ===================================================== */
  const keys = { w: false, a: false, s: false, d: false, space: false };

  let kbSpeedY = 0;
  let kbTurn   = 0;

  const ACCEL_RATE     = 4;
  const BRAKE_RATE     = 8;
  const KB_INTERVAL    = 40;
  const MIN_SPEED      = 20;
  const SPOT_TURN_VAL  = 40;
  const DRIVE_TURN_VAL = 55;

  let kbLastTick = 0;
  let kbTickTimer = null;

  function sendKbState() {
    if (!isAdmin) return;
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

  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (['w','a','s','d',' ','arrowup','arrowdown','arrowleft','arrowright'].includes(key)) {
      const tag = e.target.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        e.preventDefault();
      }
    }
  });

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
     Chat
  ===================================================== */
  function appendChatMessage(msg) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    if (msg.is_admin) div.classList.add('is-admin');
    if (msg.is_ai) div.classList.add('is-ai');
    div.innerHTML = '<span class="chat-name">' + escapeHtml(msg.name) + ':</span> <span class="chat-text">' + escapeHtml(msg.text) + '</span>';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    // Ограничение истории: не более 100 сообщений
    while (chatMessages.children.length > 100) {
      chatMessages.removeChild(chatMessages.firstChild);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    if (!wsConnected) return;
    ws.send(JSON.stringify({ type: 'chat', text: text }));
    chatInput.value = '';
  }

  chatSendBtn.addEventListener('click', sendChatMessage);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChatMessage();
    }
  });

  /* =====================================================
      QR Scanner (сканирование с MJPEG-стрима робота)
  ===================================================== */
  const qrCanvas = document.getElementById('qr-canvas');
  const qrCtx = qrCanvas.getContext('2d');
  let qrScanning = false;
  let qrAnimationId = null;
  let lastQrData = ''; // чтобы не отправлять одно и то же повторно
  let qrFrameCount = 0;

  function startQrScanner() {
    if (qrScanning) return;
    qrScanning = true;
    lastQrData = '';
    qrFrameCount = 0;
    console.log('[QR] Сканирование стрима запущено');
    qrTick();
  }

  function stopQrScanner() {
    qrScanning = false;
    if (qrAnimationId) {
      cancelAnimationFrame(qrAnimationId);
      qrAnimationId = null;
    }
    console.log('[QR] Сканирование стрима остановлено');
  }

  function qrTick() {
    if (!qrScanning) return;

    // Анализируем каждый 5-й кадр для снижения нагрузки
    qrFrameCount++;
    if (qrFrameCount % 5 === 0) {
      const img = streamImg;
      if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        qrCanvas.width = img.naturalWidth;
        qrCanvas.height = img.naturalHeight;
        qrCtx.drawImage(img, 0, 0, qrCanvas.width, qrCanvas.height);

        try {
          const imageData = qrCtx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height);

          if (code && code.data && code.data !== lastQrData) {
            lastQrData = code.data;
            console.log('[QR] Найден код:', code.data);
            // Отправляем в чат от имени администратора
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'chat',
                text: '📷 QR: ' + code.data
              }));
            }
          }
        } catch (e) {
          // Игнорируем ошибки canvas (например, CORS)
        }
      }
    }

    qrAnimationId = requestAnimationFrame(qrTick);
  }

  /* =====================================================
      Join form handler
  ===================================================== */
  joinBtn.addEventListener('click', () => {
    const name = joinNameInput.value.trim();
    if (!name) {
      joinError.textContent = '❌ Введите ваше имя';
      return;
    }
    joinError.textContent = '';
    userName = name;
    sendJoin(name);
  });

  joinNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      joinBtn.click();
    }
  });

  /* =====================================================
     Auth form handler
  ===================================================== */
  authBtn.addEventListener('click', () => {
    const password = authPassword.value.trim();
    if (!password) {
      authError.textContent = '❌ Введите пароль';
      return;
    }
    authError.textContent = '';
    sendAuth(password);
  });

  authPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      authBtn.click();
    }
  });

  /* =====================================================
     ESP32 IP setter handler
  ===================================================== */
  esp32IpBtn.addEventListener('click', () => {
    const ip = esp32IpInput.value.trim();
    if (!ip) {
      esp32IpStatus.textContent = '❌ Введите IP адрес';
      esp32IpStatus.className = 'ip-status-error';
      return;
    }
    esp32IpStatus.textContent = '⏳ Отправка...';
    esp32IpStatus.className = '';
    sendSetEsp32Ip(ip);
  });

  esp32IpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      esp32IpBtn.click();
    }
  });

  /* =====================================================
     Admin link handler (в статус-баре)
  ===================================================== */
  btnAdmin.addEventListener('click', (e) => {
    e.preventDefault();
    if (isAdmin) {
      // Уже админ — показываем/скрываем панель
      adminPanel.classList.toggle('hidden');
      return;
    }
    authForm.classList.remove('hidden');
    authPassword.value = '';
    authError.textContent = '';
    authPassword.focus();
  });

  /* =====================================================
     Auth cancel button
  ===================================================== */
  authCancel.addEventListener('click', () => {
    authForm.classList.add('hidden');
    authPassword.value = '';
    authError.textContent = '';
  });

  /* =====================================================
     Показываем панель администратора и запускаем QR-сканер
  ===================================================== */
  const origHandleAuth = handleAuthResponse;
  handleAuthResponse = function(msg) {
    origHandleAuth(msg);
    if (msg.status === 'ok' && msg.role === 'admin') {
      adminPanel.classList.remove('hidden');
      // Запускаем QR-сканер при получении прав администратора
      startQrScanner();
    }
  };

  /* =====================================================
     Init WebSocket connection
  ===================================================== */
  wsConnect();

  window.addEventListener('blur', () => {
    keys.w = keys.a = keys.s = keys.d = keys.space = false;
    kbSpeedY = 0;
    kbTurn = 0;
    stopKbLoop();
    sendWsCommandImmediate(0, 0);
    speedLabel.textContent = 'L: 0% | R: 0%';
  });

})();
