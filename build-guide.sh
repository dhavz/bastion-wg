#!/usr/bin/env bash
# (Re)build docs/VPN-User-Guide.pdf with the current server IP.
# Run again if the server IP or the LOG_WEBSITES setting changes.
# Builds inside a Docker container, so it does not depend on this machine's Python.

source "$(dirname "$0")/lib/common.sh"
load_state
need docker "Install Docker Desktop and start it."

docker run --rm -v "$ROOT/docs:/docs" python:3.12-slim sh -c \
  "pip install -q --disable-pip-version-check --root-user-action=ignore reportlab && \
   python /docs/build_guide.py '$SERVER_IP' /docs/VPN-User-Guide.pdf '${LOG_WEBSITES:-no}'" \
  | sed "s|/docs/|$ROOT/docs/|"
