"""On-demand hosting only. The showcase remains a plain Node + bubblewrap app.

The default Modal Function environment cannot run bubblewrap's network
namespace setup. A VM hosts the entire unmodified showcase, behind a small
HTTP gateway that scales to zero. No Modal SDK is used by the Node app.
"""
import os
import threading
from http.server import ThreadingHTTPServer

import httpx
import modal

from gateway import proxy_handler

APP_NAME = "agent-runtime-showcase"
PORT = 4178
app = modal.App(APP_NAME)
data = modal.Volume.from_name("agent-runtime-showcase-data", create_if_missing=True, version=2)
# deploy.py builds this immutable image before registering the HTTP host. A
# cold start never installs dependencies or rebuilds application source.
image = modal.Image.from_id(os.environ["SHOWCASE_IMAGE_ID"])
secrets = ([modal.Secret.from_name(os.environ["SHOWCASE_MODEL_SECRET"])]
           if os.environ.get("SHOWCASE_MODEL_SECRET") else [])
parents = os.environ.get(
    "SHOWCASE_FRAME_ANCESTORS",
    "https://agent-runtime.clearideas.com,http://127.0.0.1:4179,http://localhost:4179,http://127.0.0.1:5173,http://localhost:5173",
)


def sync_files(sandbox):
    process = sandbox.exec("sync", "/data")
    process.wait()
    if process.returncode:
        raise RuntimeError("Could not persist showcase data")


@app.server(
    image=image,
    env={key: os.environ.get(key, "") for key in (
        "SHOWCASE_IMAGE_ID", "SHOWCASE_MODEL_SECRET", "SHOWCASE_PUBLIC_ORIGIN",
    )} | {"SHOWCASE_FRAME_ANCESTORS": parents},
    port=8000,
    unauthenticated=True,
    min_containers=0,
    max_containers=1,
    max_concurrency=32,
    scaledown_window=120,
    startup_timeout=120,
    exit_grace_period=120,
    cpu=0.25,
    memory=512,
)
class Web:
    @modal.enter()
    def start(self):
        # The public address is deployment metadata, never a credential.
        public_origin = os.environ.get("SHOWCASE_PUBLIC_ORIGIN") or modal.Server.from_name(APP_NAME, "Web").get_url()
        self.sandbox = modal.Sandbox.create(
            "node", "server.ts",
            app=app, image=image, runtime="vm", workdir="/opt/showcase",
            cpu=1, memory=2048,
            timeout=24 * 60 * 60,
            idle_timeout=180,
            volumes={"/data": data}, secrets=secrets,
            encrypted_ports=[PORT],
            readiness_probe=modal.Probe.with_exec(
                "curl", "--fail", "--silent", f"http://127.0.0.1:{PORT}/healthz", interval_ms=500,
            ),
            env={
                "SHOWCASE_HOST": "0.0.0.0",
                "SHOWCASE_PORT": str(PORT),
                "SHOWCASE_SANDBOX": "bubblewrap",
                "SHOWCASE_REQUIRE_ISOLATION": "1",
                "SHOWCASE_SESSIONS": "1",
                "SHOWCASE_MAX_ACTIVE_RUNS": "1",
                "SHOWCASE_DATA": "/data/showcase",
                "SHOWCASE_PUBLIC_ORIGIN": public_origin,
                "SHOWCASE_FRAME_ANCESTORS": parents,
            },
        )
        self.sandbox.wait_until_ready()
        upstream = self.sandbox.tunnels()[PORT].url
        sandbox = self.sandbox
        self.client = httpx.Client(timeout=httpx.Timeout(900, connect=30), follow_redirects=False)
        client = self.client
        self.server = ThreadingHTTPServer(
            ("0.0.0.0", 8000), proxy_handler(upstream, client, lambda: sync_files(sandbox)),
        )
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        print(f"Showcase ready: {public_origin} (bubblewrap in Linux VM)", flush=True)

    @modal.exit()
    def stop(self):
        if hasattr(self, "server"):
            self.server.shutdown()
            self.server.server_close()
        if hasattr(self, "client"):
            self.client.close()
        if hasattr(self, "sandbox"):
            try:
                sync_files(self.sandbox)
            finally:
                self.sandbox.terminate()


@app.local_entrypoint()
def check():
    """Run the existing showcase doctor in the same VM image before deploying."""
    sandbox = modal.Sandbox.create(
        "node", "doctor.ts", app=app, image=image, runtime="vm",
        workdir="/opt/showcase", timeout=300, cpu=1, memory=2048,
        env={"SHOWCASE_SANDBOX": "bubblewrap", "SHOWCASE_SESSIONS": "0"},
    )
    try:
        for line in sandbox.stdout:
            print(line, end="")
        sandbox.wait()
        if sandbox.returncode:
            print(sandbox.stderr.read())
            raise RuntimeError("The showcase doctor failed in the hosting VM")
    finally:
        sandbox.terminate()
