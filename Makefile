# Meridian Makefile
# One-command setup (per constitution §10: "Clear README with one-command setup").

SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help install dev build test lint format anchor-build anchor-test deploy-devnet clean keys

help: ## Print this help.
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies (pnpm + cargo fetch).
	pnpm install
	cargo fetch

dev: ## Run local validator + frontend + automation concurrently.
	pnpm dev

build: anchor-build ## Build everything.
	pnpm -r build

test: ## Run all tests (Rust + TS).
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	anchor test
	pnpm -r test

lint: ## Lint everything.
	cargo clippy --all-targets -- -D warnings
	pnpm -r lint

format: ## Format everything.
	cargo fmt
	pnpm -r format

anchor-build: ## Build the Anchor program.
	anchor build

anchor-test: ## Run Anchor tests against the local validator.
	anchor test

keys: ## Print the program-id from the generated keypair.
	anchor keys list

deploy-devnet: ## Deploy the program to Solana devnet (requires funded keypair).
	@./scripts/check-devnet-balance.sh
	anchor build
	anchor deploy --provider.cluster devnet
	@echo ""
	@echo "Program deployed. Update MERIDIAN_PROGRAM_ID in your .env."

clean: ## Wipe all build artifacts.
	cargo clean
	rm -rf node_modules target .anchor app/.next dist
	pnpm -r clean 2>/dev/null || true
