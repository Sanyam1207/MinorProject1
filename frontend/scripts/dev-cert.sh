#!/usr/bin/env bash
# Create a self-signed certificate so phones on your Wi-Fi can open the dev
# server over HTTPS (required for the camera-based QR scanner).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cert
IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout .cert/key.pem -out .cert/cert.pem \
  -subj "/CN=matchy-campus-dev" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${IP}" >/dev/null 2>&1
echo "Certificate written to frontend/.cert (valid for localhost and ${IP})."
echo "Start the LAN server with: npm run dev:lan  →  https://${IP}:5173"
echo "Your phone will show a certificate warning once; accept it to continue."
