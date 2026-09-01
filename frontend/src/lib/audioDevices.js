export function audioInputConstraints(deviceId = "default") {
  const selectedDevice = String(deviceId || "default");
  return {
    audio: {
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      ...(selectedDevice === "default" ? {} : { deviceId: { exact: selectedDevice } }),
    },
  };
}

export async function listAudioInputDevices(mediaDevices = globalThis.navigator?.mediaDevices) {
  if (!mediaDevices?.enumerateDevices) return [];
  const devices = await mediaDevices.enumerateDevices();
  let fallbackIndex = 0;
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => {
      fallbackIndex += 1;
      return {
        id: device.deviceId,
        label: device.label || `Microphone ${fallbackIndex}`,
      };
    });
}
