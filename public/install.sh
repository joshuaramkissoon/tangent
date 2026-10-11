#!/bin/sh
# Installs the `tangent` command:  curl -fsSL https://tangentially.vercel.app/install.sh | sh
# It's one Python file with no dependencies. To remove it, delete the file this script prints.
set -e

SOURCE="https://raw.githubusercontent.com/joshuaramkissoon/tangent/main/cli/tangent_cli.py"

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
  echo "tangent needs Python 3.9 or newer."
  if [ "$(uname)" = "Darwin" ]; then
    echo "On a Mac, run:  xcode-select --install   (or: brew install python), then run this again."
  else
    echo "Install python3 with your package manager, then run this again."
  fi
  exit 1
fi

# Prefer a folder that's already on PATH and writable, so the command works straight away.
DIR=""
for d in "$HOME/.local/bin" "$HOME/bin" /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$d:"*) [ -d "$d" ] && [ -w "$d" ] && { DIR="$d"; break; } ;; esac
done
ON_PATH=1
if [ -z "$DIR" ]; then
  DIR="$HOME/.local/bin"
  ON_PATH=0
  mkdir -p "$DIR"
fi

TMP="$(mktemp)"
curl -fsSL "$SOURCE" -o "$TMP"
head -1 "$TMP" | grep -q '^#!/usr/bin/env python3' || { echo "The download didn't look right; nothing was installed."; rm -f "$TMP"; exit 1; }
chmod 755 "$TMP"
mv "$TMP" "$DIR/tangent"

if [ "$ON_PATH" = 0 ]; then
  case "$(basename "${SHELL:-sh}")" in
    zsh) RC="$HOME/.zshrc" ;;
    bash) RC="$HOME/.bashrc"; [ "$(uname)" = "Darwin" ] && RC="$HOME/.bash_profile" ;;
    *) RC="$HOME/.profile" ;;
  esac
  printf '\n# Added by the tangent installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"
  echo "Installed $DIR/tangent and added it to your PATH in $RC."
  echo "Open a new terminal window, then try:  tangent README.md"
else
  echo "Installed $DIR/tangent"
  echo "Try:  tangent README.md"
fi
