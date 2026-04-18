# Installing Playwright MCP

This guide walks you through adding Playwright MCP to this Blueprint instance. Playwright provides headless browser automation — navigating pages, clicking elements, filling forms, taking screenshots, and reading page content.

## Prerequisites

You need sudo access in this container. Run `sudo echo ok` to verify.

## Step 1: Install System Dependencies

Chromium requires shared libraries that may not be present in minimal base images. Install them:

```bash
sudo apt-get update && sudo apt-get install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
  libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
  && sudo rm -rf /var/lib/apt/lists/*
```

If these are already installed, apt will skip them.

## Step 2: Install Playwright MCP

```bash
sudo npm install -g @playwright/mcp
```

## Step 3: Install Chrome

```bash
npx playwright install chrome
```

This downloads a Chromium binary managed by Playwright. It does not require root.

## Step 4: Register the MCP Server

```bash
claude mcp add-json --scope user playwright '{"command":"npx","args":["@playwright/mcp@latest","--headless"]}'
```

This registers Playwright as a user-scoped MCP server so it's available in all sessions and projects.

## Step 5: Verify

Start a new Claude session (or restart the current one) and ask it to navigate to a URL:

```
Navigate to https://example.com and take a screenshot
```

You should see Playwright browser tools available (browser_navigate, browser_click, browser_snapshot, browser_take_screenshot, etc.).

## Browser Lock

Playwright MCP uses a single browser instance. Only one Claude session can use the browser at a time. If another session is using it, you'll get a connection error.

Workarounds:
- Coordinate browser use across sessions — finish browser work in one session before starting it in another
- Kill the stuck browser process if a session crashed without releasing it: `pkill -f chromium`

## Persistence

The MCP registration (Step 4) is stored in Claude's user config and persists across sessions. However, if the container is rebuilt from a clean image without Playwright in the Dockerfile, you'll need to repeat Steps 1-4.

To make Playwright permanent, add the install commands to your Dockerfile:

```dockerfile
RUN npm install -g @playwright/mcp
RUN npx playwright install chrome
```

And add the system dependencies to the apt-get install line.
