"""Build once, verify in a Linux VM, then deploy the scale-to-zero HTTP host."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import time

import httpx
import modal

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "examples" / "showcase"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check-only", action="store_true", help="Build and run doctor without replacing the deployment")
args = parser.parse_args()


def verify_host(url):
    """Check the public gateway, not only the Node app inside its VM."""
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            response = httpx.get(url + "/healthz", timeout=15)
            if response.status_code == 200 and response.json().get("status") == "ready":
                health = response.json()
                if not health.get("isolated") or health.get("sandbox") != "bubblewrap":
                    raise RuntimeError("The public host is not running the required bubblewrap sandbox")
                break
        except httpx.HTTPError:
            pass
        time.sleep(1)
    else:
        raise RuntimeError("The public showcase did not become ready within three minutes")
    # Independent clients must each receive a new cookie. Reusing an HTTP
    # client's upstream jar in the gateway would fail this check.
    first = httpx.get(url, timeout=20)
    second = httpx.get(url, timeout=20)
    first.raise_for_status()
    second.raise_for_status()
    first_cookie = first.cookies.get("showcase_session")
    second_cookie = second.cookies.get("showcase_session")
    if not first_cookie or not second_cookie or first_cookie == second_cookie:
        raise RuntimeError("The public gateway did not issue independent visitor sessions")
    print("Public showcase verified: ready, bubblewrap isolated, independent visitor sessions")


with modal.enable_output():
    app = modal.App.lookup("agent-runtime-showcase", create_if_missing=True)
    image = (
        modal.Image.from_dockerfile(SOURCE / "Dockerfile", context_dir=SOURCE, add_python="3.12")
        .pip_install("httpx==0.28.1")
        .add_local_file(HERE / "gateway.py", "/root/gateway.py", copy=True)
        .build(app)
    )
    environment = {**os.environ, "SHOWCASE_IMAGE_ID": image.object_id}
    subprocess.run(
        [sys.executable, "-m", "modal", "run", str(HERE / "modal_app.py") + "::check"],
        env=environment, check=True,
    )
    if not args.check_only:
        subprocess.run(
            [sys.executable, "-m", "modal", "deploy", str(HERE / "modal_app.py")],
            env=environment, check=True,
        )
        url = modal.Server.from_name("agent-runtime-showcase", "Web").get_url()
        verify_host(url)
        print("Showcase URL:", url)
