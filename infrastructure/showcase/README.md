# On-demand showcase hosting

The application is the portable `examples/showcase` Node server. It uses
bubblewrap locally within its Linux host; it imports no Modal SDK. The same
application and Dockerfile can run on another Linux host that supports
bubblewrap's namespaces and resource limits.

This folder is one deployment recipe. Modal's default container environment
failed bubblewrap's network namespace probe, so the recipe hosts the entire
application in a Modal **Linux VM**, with the existing bubblewrap provider.
A small Modal HTTP gateway starts that VM on demand and forwards HTTP streams,
cookies, and uploads. Both are stopped after inactivity. The image is built
during deployment, never on a visitor's first request.

## Deploy

From the repository root, with Python 3.12:

```sh
python3 -m venv /tmp/agent-runtime-modal
/tmp/agent-runtime-modal/bin/python -m pip install -r infrastructure/showcase/requirements.txt
/tmp/agent-runtime-modal/bin/python -m modal token new
/tmp/agent-runtime-modal/bin/python infrastructure/showcase/deploy.py
```

The helper builds the portable Dockerfile, runs the showcase doctor inside the
same VM image, and deploys only after those real demo checks pass. It prints
the public endpoint. `--check-only` builds and verifies without replacing the
deployment. Keep credentials in Modal's local profile or CI environment.

The default deployment is Scripted-only. To enable Live models, create a Modal
Secret containing the desired provider key, then set `SHOWCASE_MODEL_SECRET`
to that Secret's name when running `deploy.py`. Only the trusted Node host
receives it. The per-run bubblewrap environment excludes host credentials.

## Open the launcher locally

Only the launcher runs on your computer. In `examples/showcase`:

```sh
SHOWCASE_URL=https://your-showcase-host.example npm run launch
```

Open `http://127.0.0.1:4179`. The page calls `/healthz`, waits through startup
errors, and embeds the ready application. It displays a boot ID and start
time so a new process is visible. Readiness polling stops after connection;
there is no background heartbeat keeping the deployment warm.

For repeat use, put the public `SHOWCASE_URL` in the ignored
`examples/showcase/.env.local`; `npm run launch` reads it. The local launcher
also accepts `?endpoint=https://your-showcase-host.example`.

To see the same embed in the local docs site, from the repository root:

```sh
VITE_SHOWCASE_URL=https://your-showcase-host.example npm run docs:dev
```

Open `http://127.0.0.1:5173/showcase`. The URL is build-time public configuration;
it carries no token. The docs site remains static.

## Hosting contract

| Setting                          | Purpose                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SHOWCASE_HOST`, `SHOWCASE_PORT` | Listening interface and port.                                                                                             |
| `SHOWCASE_SANDBOX=bubblewrap`    | Use the portable local sandbox provider.                                                                                  |
| `SHOWCASE_REQUIRE_ISOLATION=1`   | Refuse to start if the sandbox probe fails.                                                                               |
| `SHOWCASE_PUBLIC_ORIGIN`         | External HTTPS origin used for browser mutation checks and secure cookies; internal worker callbacks keep using loopback. |
| `SHOWCASE_FRAME_ANCESTORS`       | Comma-separated exact parent origins permitted to embed and read `/healthz`.                                              |
| `SHOWCASE_SESSIONS=1`            | Signed anonymous browser sessions with separate workspaces, checkpoints, files, and resets.                               |
| `SHOWCASE_MAX_ACTIVE_RUNS=1`     | Bound simultaneous runs across visitors. A busy host returns 429.                                                         |
| `SHOWCASE_DATA`                  | Persistent writable directory.                                                                                            |

The Modal recipe permits the production docs origin and local launcher/docs
origins on ports 4179 and 5173. Set `SHOWCASE_FRAME_ANCESTORS` when deploying to
change that list. CORS applies only to readiness; demo APIs remain same-origin
within the iframe. Browser-supplied options cannot broaden the host's sandbox
or workspace policy.

Secure cookies use `SameSite=None; Secure; Partitioned` for cross-site iframe
sessions. Browsers that block embedded cookies may require **Open in a new
tab**, or hosting the docs and showcase under the same site. New-tab and
embedded sessions may be separate because cookies are partitioned.

The Modal gateway has zero warm containers and a 120-second idle scale-down
window. Its shutdown syncs persistent data and terminates the VM. The VM has
an additional idle timeout as orphan protection. Its mounted v2 Volume is
synced after mutations. This recipe runs one serving host; increasing its
replica count requires storage coordination and distributed run admission.
Data is retained until deleted; this example does not implement retention or
user-account authentication. Use fixture documents when trying public demos.

## GitHub deployment

`.github/workflows/deploy-showcase.yml` deploys relevant changes on `main`, and
can also be run manually. It installs locked showcase dependencies, runs the
test suite, checks the real demos in the Modal VM, then deploys. Deployment
jobs are serialized so a second push cannot interrupt a running rollout.

Configure the GitHub **showcase** environment with:

- `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` as Actions secrets.
- Optionally `SHOWCASE_MODEL_SECRET` as an environment variable naming the
  Modal Secret used for Live mode.

Set the repository Actions variable `SHOWCASE_URL` to the printed public
endpoint. The existing documentation workflow passes it to `VITE_SHOWCASE_URL`
when building the docs. Deploying the showcase preserves its endpoint, so
future example changes do not require updating the docs URL.

The credentials belong only to the GitHub deployment job. Neither the static
docs output, launcher, showcase browser code, nor VM receives Modal deployment
credentials.
