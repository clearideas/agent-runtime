# Python runtime tasks. The TypeScript workspace keeps using npm scripts.
#
#   make test        set up everything that is missing, then lint, type-check, and
#                    run the Python unit and cross-language compatibility suites
#                    (and the unit tests of the Python showcase's host library)
#   make test-showcase
#                    the showcase's HTTP tests against the Python showcase server,
#                    and the parity tests that run every demo on both runtimes
#                    (installs examples/showcase's npm dependencies when missing)
#   make check       `make test`, the TypeScript suite (`npm test`), and
#                    `make test-showcase`
#   make interop     only the cross-language tests
#   make install     only the setup steps below
#   make clean       remove the Python environment and the build stamp
#
# Setup (each step runs only when needed):
#   1. uv: the one on PATH, or a private copy in python/.bootstrap (pip in a venv,
#      falling back to the official installer);
#   2. Node.js dependencies: `npm ci` when node_modules is missing (an existing
#      node_modules is never replaced; a warning says when it looks stale);
#   3. TypeScript packages: `npm run build` when a source file changed since the
#      last build (the interop tests run the built packages);
#   4. python/.venv: `uv sync --all-extras` (uv downloads a suitable Python if none
#      is installed).
# Node.js 22+ and npm must be installed; everything else is installed here.
#
# Options: STRICT=0 allows skipped tests (by default a skipped test fails, so a
# green run means every test ran); PYTEST_ARGS="-k name" narrows the run.

PYTHON_DIR := python
STRICT ?= 1
PYTEST_ARGS ?=

BOOTSTRAP_DIR := $(PYTHON_DIR)/.bootstrap
SYSTEM_UV := $(shell command -v uv 2>/dev/null)
UV := $(if $(SYSTEM_UV),$(SYSTEM_UV),$(CURDIR)/$(BOOTSTRAP_DIR)/bin/uv)
BUILD_STAMP := node_modules/.cache/clearideas-agent-runtime-python/ts-build.stamp
RUN := cd $(PYTHON_DIR) && AGENT_RUNTIME_STRICT=$(STRICT) $(UV) run --all-extras

SHOWCASE_DIR := examples/showcase

.PHONY: test check interop install lint typecheck pytest uv node-deps build-ts python-env clean \
	test-showcase showcase-deps

test: install lint typecheck pytest

check: test
	npm test
	$(MAKE) test-showcase

interop: install
	$(RUN) pytest tests/interop $(PYTEST_ARGS)

install: uv node-deps build-ts python-env

uv:
	@if [ -z "$(SYSTEM_UV)" ] && [ ! -x "$(UV)" ]; then \
		echo "uv is not installed; installing a private copy into $(BOOTSTRAP_DIR)"; \
		if command -v python3 >/dev/null 2>&1 && python3 -m venv "$(BOOTSTRAP_DIR)" >/dev/null 2>&1 \
			&& "$(BOOTSTRAP_DIR)/bin/python" -m pip install --quiet --disable-pip-version-check uv; then \
			:; \
		else \
			rm -rf "$(BOOTSTRAP_DIR)"; mkdir -p "$(BOOTSTRAP_DIR)/bin"; \
			curl -LsSf https://astral.sh/uv/install.sh \
				| env UV_INSTALL_DIR="$(CURDIR)/$(BOOTSTRAP_DIR)/bin" UV_NO_MODIFY_PATH=1 INSTALLER_NO_MODIFY_PATH=1 sh; \
		fi; \
	fi
	@"$(UV)" --version

node-deps:
	@command -v node >/dev/null 2>&1 || { echo "Node.js 22 or newer is required (https://nodejs.org)." >&2; exit 1; }
	@command -v npm >/dev/null 2>&1 || { echo "npm is required (it ships with Node.js)." >&2; exit 1; }
	@node -e 'const [major] = process.versions.node.split(".").map(Number); if (major < 22) { console.error(`Node.js 22 or newer is required (found ${process.version}).`); process.exit(1); }'
	@if [ ! -d node_modules/typescript ] || [ ! -d node_modules/ai ]; then \
		echo "Installing Node.js dependencies (npm ci)"; \
		npm ci; \
	elif [ package-lock.json -nt node_modules/.package-lock.json ]; then \
		echo "warning: package-lock.json is newer than node_modules; run 'npm ci' if the build fails." >&2; \
	fi

build-ts: node-deps
	@if [ ! -f "$(BUILD_STAMP)" ] || [ ! -f packages/core/dist/index.js ] || [ ! -f packages/cli/dist/bin.js ] \
		|| [ -n "$$(find packages scripts tsconfig.json package-lock.json \
			\( -name node_modules -o -name dist \) -prune -o -type f -newer "$(BUILD_STAMP)" -print -quit)" ]; then \
		echo "Building the TypeScript packages (npm run build)"; \
		npm run build && mkdir -p "$$(dirname "$(BUILD_STAMP)")" && touch "$(BUILD_STAMP)"; \
	fi

python-env: uv
	cd $(PYTHON_DIR) && "$(UV)" sync --all-extras

# The Python showcase (examples/showcase/*.py) is checked with its own ruff.toml
# and pyrightconfig.json, in the python/ environment.
SHOWCASE_UV := "$(UV)" run --project $(CURDIR)/$(PYTHON_DIR) --all-extras

lint: python-env
	cd $(PYTHON_DIR) && "$(UV)" run ruff check src tests && "$(UV)" run ruff format --check src tests
	cd $(SHOWCASE_DIR) && $(SHOWCASE_UV) ruff check . && $(SHOWCASE_UV) ruff format --check .

typecheck: python-env
	cd $(PYTHON_DIR) && "$(UV)" run pyright
	cd $(SHOWCASE_DIR) && $(SHOWCASE_UV) pyright

pytest: install
	$(RUN) pytest -rs tests $(PYTEST_ARGS)
	$(RUN) pytest -rs ../$(SHOWCASE_DIR)/test_py

# The showcase's browser libraries and test tools (its own npm project). The
# tests compare the Python runtime with this repository's TypeScript packages,
# so the showcase uses them instead of the published ones (use-local-runtime).
showcase-deps: node-deps build-ts
	@if [ ! -d $(SHOWCASE_DIR)/node_modules/marked ]; then \
		echo "Installing the showcase's Node.js dependencies (npm ci in $(SHOWCASE_DIR))"; \
		cd $(SHOWCASE_DIR) && npm ci; \
	fi
	@if [ -d $(SHOWCASE_DIR)/node_modules/@clearideas/agent-runtime ]; then \
		cd $(SHOWCASE_DIR) && npm run use-local-runtime; \
	fi

test-showcase: install showcase-deps
	cd $(SHOWCASE_DIR) && npm run test:python

clean:
	rm -rf $(PYTHON_DIR)/.venv $(BOOTSTRAP_DIR) $(BUILD_STAMP)
