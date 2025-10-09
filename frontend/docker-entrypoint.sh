#!/bin/sh
set -euo pipefail

API_BASE_URL_TRIMMED="${API_BASE_URL:-}"
API_BASE_URL_TRIMMED="${API_BASE_URL_TRIMMED%%/}"

cat <<CONFIG > /usr/share/nginx/html/config.js
window.__PAPERCRATE_API_BASE_URL = "${API_BASE_URL_TRIMMED}";
CONFIG

exec "$@"
