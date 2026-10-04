#!/usr/bin/env python3
"""Copy only existing Bot loopback-auth settings into a private Compose env file."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile


def configure(bot_config):
    # Never execute/source configuration, and never modify the Bot's file.
    try:
        with Path(bot_config).open(encoding="utf-8-sig") as source:
            config = json.load(source)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("Cannot read a valid UTF-8 Bot config.json.") from None
    api = config.get("api") if isinstance(config, dict) else None
    if not isinstance(api, dict) or api.get("status") is not True or api.get("enabled") is False:
        raise ValueError("Enable the Bot API first: api.status must be true.")
    token = api.get("line_report_token")
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_./+=:-]{32,4096}", token):
        raise ValueError("Bot api.line_report_token must be an existing 32-4096 character token without quotes, whitespace, backslashes or dollar signs.")
    port = api.get("http_port")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Bot api.http_port must be an integer from 1 to 65535.")
    if api.get("http_url", "127.0.0.1") not in ("127.0.0.1", "0.0.0.0", "localhost"):
        raise ValueError("Bot api.http_url must accept connections on 127.0.0.1; this deployment supports 127.0.0.1, localhost or 0.0.0.0.")

    directory = Path(__file__).resolve().parent.parent / "config"
    if directory.is_symlink():
        raise ValueError("Refusing a symlink config directory.")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    destination = directory / "cdn-auth.env"
    if destination.is_symlink() or (destination.exists() and not destination.is_file()):
        raise ValueError("config/cdn-auth.env must be a regular file.")

    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=directory, prefix=".cdn-auth-", delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, 0o600)
            output.write(f"DUSHENG_CDN_AUTH_TOKEN={token}\nDUSHENG_BOT_API_PORT={port}\n")
        os.replace(temporary, destination)
        temporary = None
        destination.chmod(0o600)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bot-config", required=True, help="Host path to the existing Bot config.json")
    args = parser.parse_args()
    try:
        configure(args.bot_config)
    except ValueError as error:
        print(f"CDN origin configuration failed: {error}", file=sys.stderr)
        return 1
    except OSError:
        print("CDN origin configuration failed: check config directory access and permissions.", file=sys.stderr)
        return 1
    print("Wrote private config/cdn-auth.env from existing Bot settings; the Bot config was not changed.")
    print("CDN IP authorization is checked live against the Bot; no IP list was copied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
