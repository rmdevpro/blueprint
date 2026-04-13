Done. I've created a comprehensive architectural review plan at:

**`C:\Users\j\projects\BP_Quorum\Phase 0 - Plan\Claude\refactor-architecture-plan.md`**

The plan:

1. **Validates the refactor proposal** — it's architecturally sound with no cycles
2. **Aligns with ERQ-001** — documents compliance across code quality, error handling, logging, async correctness, and resilience
3. **Details each module** — responsibility, state ownership, cross-module communication, error handling fixes
4. **Provides implementation roadmap** — 4 phases with verification gates after each step
5. **Includes risk mitigation** — dependency verification, bare catch block detection, Docker isolation strategy
6. **Defines success criteria** — 9 verifiable conditions (test suites, smoke tests, requirement compliance)

The key findings:

- ✓ All 22 bare `catch {}` blocks have specific remediation (expected failures, informational logs, critical errors)
- ✓ Dependency graph is acyclic and testable in order
- ✓ Cross-module state (sessionWsClients, browserCount) properly centralized
- ✓ Each extraction step produces a working, testable intermediate state
