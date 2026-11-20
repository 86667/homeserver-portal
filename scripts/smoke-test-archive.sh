#!/usr/bin/env bash
# Unpacks a release archive and sets it up the way the README says to: the
# example config copied into the directory to serve, and that directory served
# by a plain static server (Python's, which sends no headers of its own). The
# page, its script and the config must all answer. Needs port 8080 free.
#
#   scripts/smoke-test-archive.sh <archive.tar.gz>
set -euo pipefail

archive="$(realpath "${1:?usage: smoke-test-archive.sh <archive.tar.gz>}")"
work="$(mktemp -d)"
server=""
trap '[[ -n "$server" ]] && kill "$server" 2>/dev/null; rm -rf "$work"' EXIT

tar --extract --gzip --file "$archive" --directory "$work"
dir="$work/$(basename "$archive" .tar.gz)"

# What the README points an operator to, besides the page.
for file in LICENSE examples/Caddyfile; do
  [[ -f "$dir/$file" ]] || { echo "the archive has no $file" >&2; exit 1; }
done
cp "$dir/config.example.json" "$dir/site/config.json"

# Another listener on the port would answer in the server's place.
port=8080
[[ -z "$(ss --listening --tcp --numeric --no-header "sport = :$port")" ]] || { echo "port $port is already in use; stop what listens there first" >&2; exit 1; }
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$dir/site" >/dev/null 2>&1 &
server=$!
url="http://127.0.0.1:$port"

curl --silent --fail --retry 30 --retry-delay 1 --retry-connrefused --output "$work/page.html" "$url/" || { echo "the server did not answer on $url" >&2; exit 1; }
# This server sends no security headers, so the page must carry its own policy.
grep --quiet '<meta http-equiv="Content-Security-Policy"' "$work/page.html" || { echo "the page carries no security policy" >&2; exit 1; }
script="$(grep --only-matching '/assets/[^"]*\.js' "$work/page.html" | sed --quiet 1p)"
[[ -n "$script" ]] || { echo "the page names no script" >&2; exit 1; }
curl --silent --fail --output /dev/null "$url$script"
curl --silent --fail --output "$work/config.json" "$url/config.json"
cmp "$work/config.json" "$dir/config.example.json"
echo "ok: $(basename "$archive") serves $url"
