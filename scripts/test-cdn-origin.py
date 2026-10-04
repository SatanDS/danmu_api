#!/usr/bin/env python3
"""Exercise the real TLS Nginx origin template with isolated loopback fixtures.

Requires an Nginx build with http_auth_request/http_realip and OpenSSL CLI.
No production configuration, credentials, Docker, Telegram or external API is used.
"""

import argparse
import contextlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
from threading import Thread
import time


ROOT = Path(__file__).resolve().parents[1]


def run(nginx, openssl):
    directory = Path(tempfile.mkdtemp(prefix="danmu-origin-test-")).resolve()
    origin_token, service_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    state = {"allowed": set(), "auth": [], "upstream": []}
    nginx_process = None
    servers = []
    threads = []
    checks = 0
    hidden = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

    class Auth(BaseHTTPRequestHandler):
        def do_GET(self):
            state["auth"].append({"path": self.path, "headers": dict(self.headers)})
            allowed = (self.path == "/emby/cdn_origin"
                       and self.headers.get("X-DuSheng-Line-Token") == origin_token
                       and self.headers.get("X-Proxy-Peer-IP") in state["allowed"])
            self.send_response(204 if allowed else 403)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_):
            pass

    class Danmu(BaseHTTPRequestHandler):
        def reply(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            state["upstream"].append({"path": self.path, "method": self.command, "body": body})
            if self.path == "/healthz" and self.command in {"GET", "HEAD"}:
                status, data = 200, {"ok": True}
            elif self.path == "/api/v1/dushengtv/danmaku" and self.command == "POST":
                authorized = self.headers.get("Authorization") == "Bearer " + service_token
                status, data = (200, {"available": True, "comments": []}) if authorized else (401, {"message": "Unauthenticated fixture"})
            else:
                status, data = 404, {}
            content = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(content)

        do_GET = do_HEAD = do_POST = reply

        def log_message(self, *_):
            pass

    def start_server(handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append(server)
        threads.append(thread)
        return server

    try:
        (directory / "logs").mkdir()
        (directory / "temp").mkdir()
        cert, key = directory / "fullchain.pem", directory / "privkey.pem"
        subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
                        "-keyout", str(key), "-out", str(cert)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **hidden)
        auth, danmu = start_server(Auth), start_server(Danmu)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            tls_port = probe.getsockname()[1]
        template = (ROOT / "deploy/nginx-cdn-origin.conf").read_text(encoding="utf-8")
        substitutions = {
            "listen 9443 ssl;": f"listen 127.0.0.1:{tls_port} ssl;",
            "listen [::]:9443 ssl;": "# IPv6 listener omitted in isolated fixture.",
            "/etc/nginx/certs/fullchain.pem": cert.as_posix(),
            "/etc/nginx/certs/privkey.pem": key.as_posix(),
            "${DUSHENG_BOT_API_PORT}": str(auth.server_port),
            "${DUSHENG_CDN_AUTH_TOKEN}": origin_token,
            "http://127.0.0.1:9321": f"http://127.0.0.1:{danmu.server_port}",
        }
        for original, replacement in substitutions.items():
            if original not in template:
                raise AssertionError("Origin template contract changed: " + original)
            template = template.replace(original, replacement)
        # Simulate a global real-IP setup. Even when XFF changes $remote_addr,
        # authorization must still see the socket peer via $realip_remote_addr.
        config = "worker_processes 1;\nerror_log logs/error.log crit;\npid logs/nginx.pid;\nevents { worker_connections 64; }\nhttp {\naccess_log off;\nset_real_ip_from 127.0.0.1;\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n" + template + "\n}\n"
        config_path = directory / "nginx.conf"
        config_path.write_text(config, encoding="utf-8")
        command = [nginx, "-p", directory.as_posix() + "/", "-c", config_path.as_posix()]
        validation = subprocess.run(command + ["-t"], capture_output=True, text=True, **hidden)
        if validation.returncode:
            raise AssertionError("Nginx configuration validation failed: " + validation.stderr.replace(origin_token, "[redacted]"))
        nginx_process = subprocess.Popen(command, cwd=directory, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **hidden)
        deadline = time.monotonic() + 10
        while True:
            try:
                with socket.create_connection(("127.0.0.1", tls_port), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise AssertionError("Isolated Nginx listener did not start")
                time.sleep(0.05)
        context = ssl.create_default_context(cafile=str(cert))

        def request(path, expected, method="GET", headers=None, body=None):
            nonlocal checks
            connection = http.client.HTTPSConnection("127.0.0.1", tls_port, context=context, timeout=8)
            try:
                connection.request(method, path, body=body, headers={"Host": "danmu.dusheng.lol", **(headers or {})})
                response = connection.getresponse()
                content = response.read()
                if response.status != expected:
                    raise AssertionError(f"{method} {path}: expected {expected}, received {response.status}")
                checks += 1
                return content
            finally:
                connection.close()

        request("/healthz", 403)
        assert not state["upstream"], "Unlisted peer reached the service"
        state["allowed"].add("203.0.113.8")
        request("/healthz", 403, headers={"X-Proxy-Peer-IP": "203.0.113.8", "X-Forwarded-For": "203.0.113.8", "X-Real-IP": "203.0.113.8"})
        assert state["auth"][-1]["headers"]["X-Proxy-Peer-IP"] == "127.0.0.1"
        state["allowed"] = {"127.0.0.1"}
        request("/healthz", 200)
        assert request("/healthz", 200, "HEAD") == b""
        request("/healthz", 405, "POST", body=b"{}")
        request("/api/v1/dushengtv/danmaku", 405)
        request("/", 404)
        request("/api/config", 404)
        request("/_dusheng_cdn_auth", 404)
        request("/api/v1/dushengtv/danmaku", 401, "POST", headers={"Content-Type": "application/json"}, body=b"{}")
        request("/api/v1/dushengtv/danmaku", 200, "POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + service_token, "Cookie": "fixture-only"}, body=b"{}")
        auth_headers = state["auth"][-1]["headers"]
        assert "Authorization" not in auth_headers and "Cookie" not in auth_headers
        assert "X-Forwarded-For" not in auth_headers and "X-Real-IP" not in auth_headers
        assert state["upstream"][-1]["body"] == b"{}"
        request("/api/v1/dushengtv/danmaku", 413, "POST", headers={"Content-Type": "application/json"}, body=b"x" * 17000)
        state["allowed"].clear()
        request("/healthz", 403)
        state["allowed"].add("127.0.0.1")
        request("/healthz", 200)
        upstream_count = len(state["upstream"])
        auth.shutdown()
        auth.server_close()
        servers.remove(auth)
        request("/healthz", 500)
        assert len(state["upstream"]) == upstream_count, "Unavailable Bot failed open"
        print(f"PASS: {checks} real TLS Nginx checks; dynamic peer allowlist, forged headers, methods, private routes, bearer auth, body limit and Bot outage.")
    finally:
        if nginx_process is not None:
            with contextlib.suppress(Exception):
                subprocess.run(command + ["-s", "quit"], timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **hidden)
            try:
                nginx_process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(nginx_process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **hidden)
                else:
                    nginx_process.terminate()
                nginx_process.wait(timeout=5)
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=2)
        # Validate the computed recursive-deletion target before cleanup.
        temp_root = Path(tempfile.gettempdir()).resolve()
        if directory.parent != temp_root or not directory.name.startswith("danmu-origin-test-"):
            raise RuntimeError("Unexpected fixture directory; cleanup refused")
        shutil.rmtree(directory)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nginx", default=os.environ.get("NGINX_BIN", "nginx"))
    parser.add_argument("--openssl", default=os.environ.get("OPENSSL_BIN", "openssl"))
    options = parser.parse_args()
    run(options.nginx, options.openssl)
