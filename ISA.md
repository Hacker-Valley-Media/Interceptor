---
project: interceptor
status: seed-draft
phase: observe
created: 2026-06-22
updated: 2026-06-22
owner: Ryan Baum
project_path: /Users/ryan/Projects/interceptor
source_model: conservative local source inventory
---

# Interceptor Project ISA - Seed Draft

## Seed Notice

This is a conservative root Ideal State Artifact (ISA) seed draft. It is based only on local repository docs inspected during the PROJECTS.md wiring doctrine migration and must not be treated as a complete product roadmap.

## Problem

`/Users/ryan/Projects/interceptor` is a code repository with product, architecture, extension, daemon, command line, and bridge surfaces but no root `ISA.md`.

Sources:
- `/Users/ryan/Documents/Codex/2026-06-21/files-mentioned-by-the-user-projects/outputs/projects-md-wiring-audit.md:89`.
- `find /Users/ryan/Projects -maxdepth 2 -name ISA.md -type f` did not list `/Users/ryan/Projects/interceptor/ISA.md`.
- `/Users/ryan/Projects/interceptor/README.md:38-45`.
- `/Users/ryan/Projects/interceptor/ARCHITECTURE.md:9-29`.

## Vision

Interceptor has a durable project ISA that orients future work across its Command Line Interface (CLI), daemon, browser extension, and macOS bridge without replacing the README or architecture docs.

Sources:
- `/Users/ryan/Projects/interceptor/README.md:38-45`.
- `/Users/ryan/Projects/interceptor/ARCHITECTURE.md:33-48`.

## Out Of Scope

- No product or API behavior changes from this seed.
- No package build, release, signing, or installer changes from this seed.
- No rewrite of README or architecture docs.
- No claim that all tests or release workflows were audited.

## Constraints

- Interceptor gives agents real autonomy over browser and app surfaces, so future work must preserve safety and trust boundaries.
  Source: `/Users/ryan/Projects/interceptor/README.md:57-59`.
- The monitor focus-follow privacy boundary attaches only to tabs in the interceptor tab group.
  Source: `/Users/ryan/Projects/interceptor/ARCHITECTURE.md:99-103`.
- Current package version is `0.16.9`.
  Source: `/Users/ryan/Projects/interceptor/package.json:1-4`.

## Goal

Create a root project ISA that gives registry and Algorithm work a durable pointer for Interceptor state, open questions, and verification boundaries.

## Criteria

- [ ] I-1: Root project ISA exists at `/Users/ryan/Projects/interceptor/ISA.md`.
- [ ] I-2: Seed records the four high-level components: CLI, daemon, extension, and macOS bridge.
- [ ] I-3: Seed records that safety/privacy boundaries must be preserved before future behavior changes.
- [ ] I-4: Seed does not rewrite README, architecture docs, code, package metadata, or release artifacts.
- [ ] I-5: Seed records open questions for current milestone, release state, and required verification commands.

## Current State

- Interceptor lets agents use real browser and macOS app surfaces.
  Source: `/Users/ryan/Projects/interceptor/README.md:38-45`.
- Architecture describes CLI, daemon, extension, and bridge components.
  Source: `/Users/ryan/Projects/interceptor/ARCHITECTURE.md:33-48`.
- The monitor subsystem includes session/attachment concepts and durable event logs.
  Source: `/Users/ryan/Projects/interceptor/ARCHITECTURE.md:53-96`.
- The privacy boundary is tied to the interceptor tab group.
  Source: `/Users/ryan/Projects/interceptor/ARCHITECTURE.md:99-103`.

## Open Questions

1. What is the current milestone or release objective?
2. Which verification commands are mandatory for documentation-only ISA seeding?
3. Which verification commands are mandatory before future behavior changes?
4. Which distribution path is current: Browser package, Full package, source build, or all of them?

## Verification

Seed verification commands:

```bash
test -f /Users/ryan/Projects/interceptor/ISA.md
rg -n "CLI|daemon|extension|bridge|privacy|tab group|0.16.9" /Users/ryan/Projects/interceptor/ISA.md
```
