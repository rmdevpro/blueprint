# This Repository

This repository is the source code for the Agentic Workbench application — the system you are running inside. You are using the workbench to develop the workbench. The application is a Node.js server (`server.js`) decomposed into focused modules using factory-based dependency injection. The full architecture, module responsibilities, and configuration reference are in `README.md`.

# Anchor Documents

These documents define the standards and context this project must be reviewed and developed against. When a document is relevant to your current task, read it fully. Do not grep or search within documents — content cannot be understood out of context. A document that is partially read is a document misread.

## Engineering Standards

- `/data/workspace/repos/Admin/docs/requirements/REQ-001-base-engineering.md` — engineering requirements all code in this project must satisfy. Read before writing or reviewing any application code.
- `/data/workspace/repos/Admin/docs/standards/STD-003-test-plan-standard.md` — defines what a test plan must contain and how it must be maintained. Read before reviewing or updating the test plans.
- `/data/workspace/repos/Admin/docs/standards/STD-004-code-standard.md` — defines what a code deliverable must look like as an artifact. Read before writing or reviewing application code.
- `/data/workspace/repos/Admin/docs/standards/STD-005-test-code-standard.md` — defines what test code must look like. Read before writing or reviewing test code.
- `/data/workspace/repos/Admin/docs/standards/STD-007-readme-standard.md` — defines what the README must contain and how it must be maintained. Read before updating `README.md`.

## Process

- `/data/workspace/repos/Admin/docs/process/PROC-001-debugging-guide.md` — required debugging and investigation workflow. Read at the start of any bug investigation.
- `/data/workspace/repos/Admin/docs/process/PROC-002-small-feature-guide.md` — required feature development workflow. Read at the start of any new feature work.
- `/data/workspace/repos/Admin/docs/process/PROC-003-runbook-execution-guide.md` — procedure for orchestrating the UI test runbook. Read when running or interpreting UI test results.
- `/data/workspace/repos/Admin/docs/process/PROC-004-test-execution-policy.md` — canonical policy for which tests run and when. Read when deciding test scope.

## Deployment

- `/data/workspace/repos/Admin/docs/guides/workbench-deployment.md` — deployment architecture, the `/data` volume convention, dev/prod distinction, and add-on installation. Read before any deployment or infrastructure work.

## This Repository

- `README.md` — architecture, module structure, dependency graph, configuration reference, and compliance notes. Read before working on any part of the codebase.
- `tests/workbench-test-plan-backend.md` — backend test plan. Read before writing backend tests or reviewing backend changes.
- `tests/workbench-test-plan-ui.md` — UI test plan. Read before writing UI tests or reviewing UI changes.
- `tests/workbench-test-runbook.md` — master UI test runbook. Read before running UI tests.
- `tests/traceability-matrix.md` — test coverage traceability matrix. Read to understand current coverage status before adding or modifying tests.
