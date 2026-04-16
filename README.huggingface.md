---
title: Blueprint
emoji: 🔧
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
fullWidth: true
---

# Blueprint

Web-based CLI workbench for AI coding agents. Manage Claude Code sessions, projects, and tasks from your browser.

## Setup

1. Create a new HF Space with **Docker** SDK
2. Copy this repo into the Space
3. Rename `Dockerfile.huggingface` to `Dockerfile` and `README.huggingface.md` to `README.md`
4. Add your `ANTHROPIC_API_KEY` as a Space secret
5. Deploy

## Notes

- Data persists in `/data` (available on paid Spaces with persistent storage)
- Free Spaces sleep after ~15 min of inactivity — tmux sessions will be lost on wake
- No Docker-in-Docker support (container build features are disabled)
- Set `WORKSPACE=/data/workspace` in Space variables
