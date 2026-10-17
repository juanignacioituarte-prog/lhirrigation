#!/bin/sh
# Sends Code.js to the "LH irrigation" sheet's Apps Script and updates the SAME
# web app deployment the page calls (its URL never changes).
# Run from Git Bash:  sh /c/dev/lhirrigation/deploy.sh
set -e
cd /c/dev/lhirrigation
DEPLOYMENT=AKfycbz0L0ZqAnyve6r4_iMPUJRbnKpD-FqtwO4lE3xJ3dmtUsyCgxy8uNPxPce0gDdAtgNR
VERSION=$(grep -o 'SCRIPT_VERSION = "[^"]*"' Code.js | cut -d'"' -f2)
clasp.cmd push --force
clasp.cmd deploy --deploymentId "$DEPLOYMENT" --description "script $VERSION"
# Google takes a few seconds to serve the new version.
for i in 1 2 3 4 5 6; do
  LIVE=$(curl -sL "https://script.google.com/macros/s/$DEPLOYMENT/exec?t=$i$$" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  [ "$LIVE" = "$VERSION" ] && { echo "OK: live script is $LIVE"; exit 0; }
  sleep 10
done
echo "WARNING: live script says $LIVE, expected $VERSION"; exit 1
