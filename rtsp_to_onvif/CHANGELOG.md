# Changelog

## 1.1.0

- Add optional bundled go2rtc/FFmpeg copy-only restreams for legacy RTSP sources,
  so Protect integration can run in one HA app without transcoding video/audio.
- Preserve camera identities and original snapshot routing when restreaming.
- Supervise both services and their FFmpeg children together; redact source
  credentials from child-process logs and keep generated credentials private.
- Verify real H.264/PCMU playback, copied frames and clean shutdown in image CI.

## 1.0.4

- When debug mode is enabled, log RTSP methods, response status codes, transport,
  SDP codec/profile summaries, first interleaved media frames, and connection
  closure counts. Credentials, complete URLs, SDP bodies and media payloads are
  omitted. The proxy continues to forward the original bytes.

## 1.0.3

- Allow `snapshot_path: ""` for RTSP sources without an HTTP snapshot endpoint.
  The virtual camera then advertises the bridge's built-in placeholder image.

## 1.0.2

- Respond to Protect's `GetNetworkInterfaces` and
  `GetVideoEncoderConfigurationOptions` requests instead of returning SOAP faults.
- Report the virtual camera's MAC/IP and the selected stream's existing encoder
  settings; the bridge continues to forward RTSP without transcoding.
- Omit SOAP request bodies from debug output to avoid logging WS-Security tokens.

## 1.0.1

- Support per-camera static IP addresses.
