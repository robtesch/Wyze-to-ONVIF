#!/bin/sh
set -eu

# Match the version already proven with the copy-only Protect workaround.
# Digests are GitHub's SHA-256 release-asset digests for AlexxIT/go2rtc v1.9.14.
case "$(apk --print-arch)" in
    x86_64) ASSET=amd64; DIGEST=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6 ;;
    aarch64) ASSET=arm64; DIGEST=359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50 ;;
    armv7) ASSET=arm; DIGEST=4d7e1639af5a2722a28e864468fd8099b3c1682565446c798bf9e3b38fde12e4 ;;
    *) echo 'Unsupported go2rtc architecture' >&2; exit 1 ;;
esac
wget -qO /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_${ASSET}"
echo "${DIGEST}  /usr/local/bin/go2rtc" | sha256sum -c -
chmod 755 /usr/local/bin/go2rtc
