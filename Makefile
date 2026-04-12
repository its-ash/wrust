SHELL := /bin/bash

.PHONY: help setup check wasm-build frontend-install frontend-dev frontend-build worker-dev deploy-worker deploy-frontend dev deploy

PAGES_PROJECT ?= ashare
WASM_OUT_DIR := ../frontend/src/wasm_pkg
WASM_OUT_NAME := ashare_wasm

help:
	@echo "Available targets:"
	@echo "  make setup            Install frontend deps (npm ci)"
	@echo "  make check            Run fmt, clippy, and cargo check"
	@echo "  make wasm-build       Build Rust WASM package for frontend"
	@echo "  make frontend-dev     Run Vite dev server"
	@echo "  make worker-dev       Run Cloudflare Worker locally"
	@echo "  make dev              Run worker + frontend dev together"
	@echo "  make deploy-worker    Deploy Cloudflare Worker"
	@echo "  make deploy-frontend  Build/deploy frontend to Pages"
	@echo "  make deploy           Deploy worker and frontend"
	@echo ""
	@echo "Configurable vars:"
	@echo "  PAGES_PROJECT=$(PAGES_PROJECT)"

setup:
	cd frontend && npm ci

check:
	cargo fmt --all
	cargo clippy --all-targets --all-features -- -D warnings
	cargo check

wasm-build:
	wasm-pack build wasm --target web --out-dir $(WASM_OUT_DIR) --out-name $(WASM_OUT_NAME)

frontend-install:
	cd frontend && npm ci

frontend-dev:
	cd frontend && npm run dev

frontend-build:
	cd frontend && npm ci
	cd frontend && npm run build

worker-dev:
	cd worker && wrangler dev

deploy-worker:
	cd worker && wrangler deploy

deploy-frontend: wasm-build frontend-build
	cd frontend && npx wrangler pages deploy dist --project-name $(PAGES_PROJECT)

dev: wasm-build frontend-install
	@trap 'kill 0' INT TERM EXIT; \
	(cd worker && wrangler dev) & \
	(cd frontend && npm run dev) & \
	wait

deploy: deploy-worker deploy-frontend
