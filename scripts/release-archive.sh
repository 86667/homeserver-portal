#!/usr/bin/env bash
# Packs the built page into a release archive: the files a web server serves,
# with what an operator needs to set them up.
#
#   scripts/release-archive.sh
#
# Run `npm run build` first. Writes release/homeserver-portal-v<version>.tar.gz,
# named after the version in package.json, and prints its path. It unpacks to
# one directory:
#
#   site/                 the directory to serve; config.json goes in it
#   config.example.json   the config to copy there and fill in
#   examples/Caddyfile    a Caddy site to adapt
#   LICENSE
#
# One archive for every platform: the page is plain files.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/release"
site="$root/dist"

[[ -f "$site/index.html" ]] || { echo "no built page at $site: run 'npm run build' first" >&2; exit 1; }
# A config left in dist/ by a local check would ship, and overwrite an operator's own on update.
[[ ! -e "$site/config.json" ]] || { echo "$site has a config.json, which a release must not ship: remove it" >&2; exit 1; }

version="$(cd "$root" && node --print "require('./package.json').version")"
name="homeserver-portal-v$version"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$out" "$work/$name/examples"
cp -r "$site" "$work/$name/site"
cp "$root/config.example.json" "$root/LICENSE" "$work/$name/"
cp "$root/examples/Caddyfile" "$work/$name/examples/"

# Owned by root, readable by all and writable by the owner only, whatever the
# umask here was: the files end up in a web server's directory.
tar --create --gzip --owner=0 --group=0 --mode='u+rwX,go+rX,go-w' --file "$out/$name.tar.gz" --directory "$work" "$name"
echo "$out/$name.tar.gz"
