import mqtt from "mqtt";

export function connectMqtt({ url, clientId }) {
  const client = mqtt.connect(url, {
    clientId,
    clean: true,
    reconnectPeriod: 1000
  });

  return client;
}

export function topicsForDevice(deviceId) {
  return {
    cmd: `henri/dev/${deviceId}/cmd`,
    ack: `henri/dev/${deviceId}/ack`
  };
}
