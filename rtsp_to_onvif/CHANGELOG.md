# Changelog

## 1.0.2

- Respond to Protect's `GetNetworkInterfaces` and
  `GetVideoEncoderConfigurationOptions` requests instead of returning SOAP faults.
- Report the virtual camera's MAC/IP and the selected stream's existing encoder
  settings; the bridge continues to forward RTSP without transcoding.
- Omit SOAP request bodies from debug output to avoid logging WS-Security tokens.

## 1.0.1

- Support per-camera static IP addresses.
