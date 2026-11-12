"""HTTP forwarding for a hosted process, independent of the hosting provider."""
from contextlib import closing
from http.server import BaseHTTPRequestHandler

import httpx


def proxy_handler(upstream, client, after_mutation):
    hop_headers = {
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade", "host",
    }

    class Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def forward(self):
            headers_sent = False
            try:
                length = int(self.headers.get("content-length", "0"))
                if length < 0 or length > 8 * 1024 * 1024:
                    self.send_error(413)
                    return
                body = self.rfile.read(length) if length else None
                headers = {
                    name: value for name, value in self.headers.items()
                    if name.lower() not in hop_headers
                }
                # Client.stream() merges its cookie jar. Construct each request
                # directly so only this visitor's Cookie header is forwarded.
                request = httpx.Request(
                    self.command, upstream + self.path, headers=headers, content=body,
                )
                with closing(client.send(request, stream=True)) as response:
                    self.send_response(response.status_code)
                    for name, value in response.headers.multi_items():
                        if name.lower() not in hop_headers:
                            self.send_header(name, value)
                    self.send_header("Connection", "close")
                    self.end_headers()
                    headers_sent = True
                    if self.command != "HEAD":
                        for chunk in response.iter_raw():
                            self.wfile.write(chunk)
                            self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                print(f"Showcase gateway: {type(error).__name__}", flush=True)
                if not headers_sent:
                    self.send_error(502, "The showcase is restarting. Please reconnect.")
            finally:
                self.close_connection = True
                if self.command == "POST":
                    try:
                        after_mutation()
                    except Exception as error:
                        print(f"Showcase persistence failed: {type(error).__name__}", flush=True)

        do_GET = do_POST = do_HEAD = do_OPTIONS = forward

        def log_message(self, *_args):
            pass

    return Proxy
