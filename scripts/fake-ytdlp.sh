#!/bin/sh
set -eu
exec node /usr/src/app/scripts/fake-ytdlp.js "$@"
