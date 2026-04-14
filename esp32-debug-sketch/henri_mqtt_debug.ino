#include <WiFi.h>
#include <PubSubClient.h>

static const char *WIFI_SSID = "YOUR_WIFI_SSID";
static const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

static const char *MQTT_HOST = "YOUR_MQTT_HOST";
static const uint16_t MQTT_PORT = 1883;

static const char *DEVICE_ID = "c3-debug";

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

String topicCmd() {
  return String("henri/dev/") + DEVICE_ID + "/cmd";
}

String topicAck() {
  return String("henri/dev/") + DEVICE_ID + "/ack";
}

String extractJsonStringValue(const char *json, const char *key) {
  String pattern = String("\"") + key + "\":\"";
  const char *start = strstr(json, pattern.c_str());
  if (!start) return String("");
  start += pattern.length();
  const char *end = strchr(start, '"');
  if (!end) return String("");
  return String(start).substring(0, end - start);
}

void onMessage(char *topic, byte *payload, unsigned int length) {
  String raw;
  raw.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) raw += (char)payload[i];

  Serial.println();
  Serial.print("[MQTT] Topic: ");
  Serial.println(topic);
  Serial.println("[MQTT] Payload:");
  Serial.println(raw);

  String cmdId = extractJsonStringValue(raw.c_str(), "cmd_id");
  String kind = extractJsonStringValue(raw.c_str(), "kind");

  String ack = String("{\"cmd_id\":\"") + cmdId + "\",\"ok\":true,\"device\":\"" + DEVICE_ID + "\",\"kind\":\"" + kind + "\",\"ts_ms\":" + String(millis()) + "}";
  mqttClient.publish(topicAck().c_str(), ack.c_str(), false);

  Serial.println("[MQTT] ACK sent:");
  Serial.println(ack);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi connected. IP: ");
  Serial.println(WiFi.localIP());
}

void ensureMqttConnected() {
  while (!mqttClient.connected()) {
    Serial.print("Connecting to MQTT...");
    if (mqttClient.connect(DEVICE_ID)) {
      Serial.println("connected.");
      mqttClient.subscribe(topicCmd().c_str(), 1);
      Serial.print("Subscribed: ");
      Serial.println(topicCmd());
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" retrying...");
      delay(1000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("HENRI ESP32 MQTT Debug");

  connectWifi();

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(onMessage);
  ensureMqttConnected();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
  }
  if (!mqttClient.connected()) {
    ensureMqttConnected();
  }
  mqttClient.loop();
  delay(10);
}
