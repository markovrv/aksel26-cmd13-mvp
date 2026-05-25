/*
 * ESP32-CAM Tank Robot
 * - HTTP (port 80):  static files (SD→RAM) + config endpoint
 * - MJPEG (port 81): camera video stream
 * - WebSocket (port 82): drive commands (JSON {"x":-100..100,"y":-100..100,"t":timestamp})
 * Motor driver: L298N (IN1=GPIO2, IN2=GPIO14, IN3=GPIO15, IN4=GPIO13)
 * Flash LED: GPIO4
 КЧ_ЖРФО_
 */

#include "Arduino.h"
#include "esp_camera.h"
#include "SD_MMC.h"
#include "WiFi.h"
#include "WebServer.h"
#include "WebSocketsServer.h"
#include "esp_timer.h"
#include "img_converters.h"
#include "fb_gfx.h"
#include <map>

// ─── WiFi ────────────────────────────────────────────────
const char* ssid     = "11935";
const char* password = "9091433506";

// ─── Motor pins (доступные GPIO на ESP32-CAM AI-Thinker) ─
#define IN1 2   // Left  forward  ⚠️ он же SD_MMC CLK
#define IN2 14  // Left  backward ⚠️ он же SD_MMC CMD
#define IN3 15  // Right forward ⚠️ он же SD_MMC DATA0
#define IN4 13  // Right backward

// ─── Flash LED ───────────────────────────────────────────
#define FLASH_PIN 4  // ⚠️ он же SD_MMC DATA1

// ─── Camera pin map (AI-Thinker ESP32-CAM) ───────────────
#define PWDN_GPIO_NUM  32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM   0
#define SIOD_GPIO_NUM  26
#define SIOC_GPIO_NUM  27
#define Y9_GPIO_NUM    35
#define Y8_GPIO_NUM    34
#define Y7_GPIO_NUM    39
#define Y6_GPIO_NUM    36
#define Y5_GPIO_NUM    21
#define Y4_GPIO_NUM    19
#define Y3_GPIO_NUM    18
#define Y2_GPIO_NUM     5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM  23
#define PCLK_GPIO_NUM  22

// ─── HTTP server (port 80: static files + config) ─────────
WebServer httpServer(80);

// ─── WebSocket server (port 82: drive commands) ──────────
WebSocketsServer wsServer(82);

// ─── MJPEG stream server (port 81: video) ─────────────────
WiFiServer streamServer(81);
WiFiClient streamClient;
bool    streamHeadersSent = false;
unsigned long streamFrameTimer = 0;

// ─── Config / state ───────────────────────────────────────
int  accelMs      = 20;   // ms per accel step
int  framesize    = 5;    // FRAMESIZE_QVGA default
int  jpegQuality  = 12;
bool flashEnabled = false;
int  fpsInterval  = 33;   // ~30 FPS

int  leftSpeed  = 0;  // -255..255 (current)
int  rightSpeed = 0;

int  targetLeft  = 0;  // -255..255 (desired)
int  targetRight = 0;

unsigned long lastAccelTime = 0;
unsigned long lastWsPing    = 0;

// ─── PWM helpers ──────────────────────────────────────────
#define PWM_FREQ  1000
#define PWM_BITS  8

void setupPWM() {
  ledcAttach(IN1, PWM_FREQ, PWM_BITS);
  ledcAttach(IN2, PWM_FREQ, PWM_BITS);
  ledcAttach(IN3, PWM_FREQ, PWM_BITS);
  ledcAttach(IN4, PWM_FREQ, PWM_BITS);
}

void setMotors(int l, int r) {
  // l, r: -255..255
  ledcWrite(IN1, l > 0 ? l : 0);
  ledcWrite(IN2, l < 0 ? -l : 0);
  ledcWrite(IN3, r > 0 ? r : 0);
  ledcWrite(IN4, r < 0 ? -r : 0);
}

// ─── Плавный разгон ──────────────────────────────────────
void accelStep() {
  if (millis() - lastAccelTime < (unsigned long)accelMs) return;
  lastAccelTime = millis();

  auto approach = [](int cur, int tgt) -> int {
    if (cur == tgt) return cur;
    int step = max(1, abs(tgt - cur) / 4);
    int next = cur + (tgt > cur ? step : -step);
    // Не перескакиваем
    if ((tgt > cur && next > tgt) || (tgt < cur && next < tgt)) next = tgt;
    return next;
  };

  leftSpeed  = approach(leftSpeed,  targetLeft);
  rightSpeed = approach(rightSpeed, targetRight);
  setMotors(leftSpeed, rightSpeed);
}

// ─── Преобразование джойстика (x,y) в моторы (танковая схема) ──
void setDriveTarget(int jx, int jy) {
  float left, right;

  if (abs(jy) < 10 && abs(jx) >= 10) {
    // Чистый разворот на месте
    left  = (float)jx;
    right = (float)-jx;
  } else {
    // Танковая схема
    left  = (float)jy + (float)jx;
    right = (float)jy - (float)jx;

    float mx = max(abs(left), abs(right));
    if (mx > 100.0f) {
      left  = left  / mx * 100.0f;
      right = right / mx * 100.0f;
    }
  }

  targetLeft  = (int)(left  / 100.0f * 255.0f);
  targetRight = (int)(right / 100.0f * 255.0f);
}

// ─── WebSocket event handler ──────────────────────────────
void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client %u disconnected\n", num);
      // При потере соединения — экстренная остановка
      targetLeft  = 0;
      targetRight = 0;
      break;

    case WStype_CONNECTED:
      Serial.printf("[WS] Client %u connected\n", num);
      break;

    case WStype_TEXT: {
      // Парсим JSON: {"x":-100..100,"y":-100..100,"t":timestamp}
      if (length == 0) break;

      // Простейший JSON-парсер (без библиотеки)
      String msg = String((char*)payload).substring(0, length);
      msg.trim();

      // Ищем "x": и "y":
      int xi = msg.indexOf("\"x\"");
      int yi = msg.indexOf("\"y\"");

      if (xi < 0 || yi < 0) break;

      // Парсим x
      int xc = msg.indexOf(':', xi + 2);
      int xe = msg.indexOf(',', xc + 1);
      if (xe < 0) xe = msg.indexOf('}', xc + 1);
      if (xc < 0 || xe < 0) break;
      int jx = msg.substring(xc + 1, xe).toInt();

      // Парсим y
      int yc = msg.indexOf(':', yi + 2);
      int ye = msg.indexOf(',', yc + 1);
      if (ye < 0) ye = msg.indexOf('}', yc + 1);
      if (yc < 0 || ye < 0) break;
      int jy = msg.substring(yc + 1, ye).toInt();

      // Ограничиваем значения
      jx = constrain(jx, -100, 100);
      jy = constrain(jy, -100, 100);

      setDriveTarget(jx, jy);
      break;
    }

    case WStype_BIN:
      // Игнорируем бинарные данные
      break;

    case WStype_ERROR:
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_FRAGMENT_FIN:
      break;

    case WStype_PING:
    case WStype_PONG:
      break;
  }
}

// ─── MJPEG stream handler (неблокирующий) ─────────────────
void handleStreamClient() {
  // 1. Принимаем нового клиента, закрываем старого
  WiFiClient newClient = streamServer.available();
  if (newClient) {
    if (streamClient && streamClient.connected()) {
      streamClient.stop();
    }
    streamClient = newClient;
    streamHeadersSent = false;
    Serial.println("[MJPEG] New client");
  }

  // 2. Если нет активного клиента — ничего не делаем
  if (!streamClient || !streamClient.connected()) {
    if (streamClient) {
      streamClient.stop();
      streamClient = WiFiClient();
    }
    return;
  }

  // 3. Отправляем заголовки (один раз)
  if (!streamHeadersSent) {
    streamClient.print("HTTP/1.1 200 OK\r\n");
    streamClient.print("Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n");
    streamHeadersSent = true;
  }

  // 4. Ограничиваем частоту кадров (fpsInterval мс)
  unsigned long now = millis();
  if (now - streamFrameTimer < (unsigned long)fpsInterval) return;
  streamFrameTimer = now;

  // 5. Захватываем и отправляем кадр
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return;

  streamClient.printf("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);
  streamClient.write(fb->buf, fb->len);
  streamClient.print("\r\n");
  esp_camera_fb_return(fb);
}

// ─── File cache (SD → RAM) ───────────────────────────────
std::map<String, String> fileCache;

String getContentType(String filename) {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".css"))  return "text/css";
  if (filename.endsWith(".js"))   return "application/javascript";
  if (filename.endsWith(".ico"))  return "image/x-icon";
  if (filename.endsWith(".svg"))  return "image/svg+xml";
  if (filename.endsWith(".png"))  return "image/png";
  return "text/plain";
}

void loadFilesToRam() {
  if (!SD_MMC.begin("/sdcard")) {
    Serial.println("[SD] Mount failed, no cache");
    return;
  }
  File root = SD_MMC.open("/www");
  if (!root || !root.isDirectory()) {
    Serial.println("[SD] /www not found");
    SD_MMC.end();
    return;
  }
  File entry;
  while ((entry = root.openNextFile())) {
    if (!entry.isDirectory()) {
      String path = String("/www/") + entry.name();
      String content;
      while (entry.available()) content += (char)entry.read();
      fileCache[path] = content;
      Serial.printf("[SD] Cached: %s (%u)\n", path.c_str(), content.length());
    }
    entry.close();
  }
  root.close();
  SD_MMC.end();
  Serial.println("[SD] Unmounted, pins released");
}

// ─── Принудительный сброс пинов после SD_MMC ────────────
void resetSdPins() {
  ledcDetach(IN1);
  ledcDetach(IN2);
  ledcDetach(IN3);
  ledcDetach(IN4);

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  pinMode(FLASH_PIN, OUTPUT);

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
  digitalWrite(FLASH_PIN, LOW);

  delay(10);
  Serial.println("[PINS] Reset to LOW after SD");
}

// ─── HTTP handlers ────────────────────────────────────────
void handleFileRequest() {
  String path = httpServer.uri();
  if (path == "/") path = "/index.html";

  String sdPath = "/www" + path;
  auto it = fileCache.find(sdPath);
  if (it != fileCache.end()) {
    httpServer.send(200, getContentType(path), it->second);
  } else {
    httpServer.send(404, "text/plain", "Not found: " + sdPath);
  }
}

// GET /config?accel=<ms>&framesize=<0-10>&quality=<4-63>&flash=<0|1>&brightness=<-2..2>&contrast=<-2..2>&fps=<1..30>
void handleConfig() {
  if (httpServer.hasArg("accel"))     accelMs      = httpServer.arg("accel").toInt();
  if (httpServer.hasArg("quality")) {
    jpegQuality = httpServer.arg("quality").toInt();
    sensor_t* s = esp_camera_sensor_get();
    if (s) s->set_quality(s, jpegQuality);
  }
  if (httpServer.hasArg("flash")) {
    flashEnabled = httpServer.arg("flash").toInt();
    digitalWrite(FLASH_PIN, flashEnabled ? HIGH : LOW);
  }
  if (httpServer.hasArg("fps")) {
    int fps = httpServer.arg("fps").toInt();
    if (fps < 1) fps = 1;
    if (fps > 30) fps = 30;
    fpsInterval = 1000 / fps;
  }
  if (httpServer.hasArg("framesize")) {
    int fs = httpServer.arg("framesize").toInt();
    sensor_t* s = esp_camera_sensor_get();
    if (s) s->set_framesize(s, (framesize_t)fs);
  }
  if (httpServer.hasArg("brightness")) {
    sensor_t* s = esp_camera_sensor_get();
    if (s) s->set_brightness(s, httpServer.arg("brightness").toInt());
  }
  if (httpServer.hasArg("contrast")) {
    sensor_t* s = esp_camera_sensor_get();
    if (s) s->set_contrast(s, httpServer.arg("contrast").toInt());
  }
  httpServer.send(200, "application/json", "{\"ok\":true}");
}

// ─── Setup ───────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  // ── Camera ──
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_4;
  config.ledc_timer   = LEDC_TIMER_2;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size   = FRAMESIZE_QVGA;
  config.jpeg_quality = jpegQuality;
  config.fb_count     = 2;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] Init failed: 0x%x\n", err);
  }

  // ── SD → RAM ──
  loadFilesToRam();
  resetSdPins();

  // ── Motors ──
  setupPWM();
  setMotors(0, 0);

  // ── Flash ──
  pinMode(FLASH_PIN, OUTPUT);
  digitalWrite(FLASH_PIN, LOW);

  // ── WiFi ──
  WiFi.setSleep(false);               // отключаем Wi-Fi sleep для минимальной задержки
  WiFi.begin(ssid, password);
  Serial.print("[WiFi] Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500); Serial.print(".");
  }
  Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("[HTTP]   http://%s\n",       WiFi.localIP().toString().c_str());
  Serial.printf("[MJPEG]  http://%s:81\n",    WiFi.localIP().toString().c_str());
  Serial.printf("[WS]     ws://%s:82\n",      WiFi.localIP().toString().c_str());

  // ── HTTP routes (port 80) ──
  httpServer.on("/config", handleConfig);
  httpServer.onNotFound(handleFileRequest);
  httpServer.begin();

  // ── WebSocket (port 82) ──
  wsServer.begin();
  wsServer.onEvent(onWsEvent);
  wsServer.enableHeartbeat(5000, 3000, 2);  // ping every 5s, timeout 3s*2=6s

  // ── MJPEG stream (port 81) ──
  streamServer.begin();
}

// ─── Loop ────────────────────────────────────────────────
void loop() {
  httpServer.handleClient();
  wsServer.loop();
  handleStreamClient();
  accelStep();
}