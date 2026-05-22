# QA_ADVERSARY guidance for <PROJECT NAME>

Drop this file at the root of any repository you want the global qa-adversary sub-agent to attack with project-specific knowledge. The sub-agent reads this file on every invocation; treat it as the override on the generic prompt.

Keep it short. Bullet lists, not prose. The agent will use it as a checklist.

---

## Project shape

- **Language:** <Swift | PHP | JavaScript | TypeScript | Python | Rust | Go | other>
- **Test framework:** <Swift Testing | XCTest | PHPUnit | Jest | pytest | cargo test | go test>
- **Test command (full):** `<exact command, e.g., swift test>`
- **Test command (fast / isolated):** `<exact command, e.g., swift test --filter Property>`
- **Mutation testing command:** `<exact command, or "not installed">`
- **Property testing path:** `<where property tests live, e.g., Tests/Property/>`
- **Base branch for diff:** `<origin/main | origin/master | origin/develop>`

## Bug categories that matter most here

List the failure modes specific to this codebase. The generic prompt covers universal edges (null, off-by-one, encoding round-trips). Here, name the domain-specific ones:

- <e.g., "Cross-tenant data access in any query that takes a patient_id">
- <e.g., "Time zones — clinic local time vs server UTC mismatch breaks appointment scheduling">
- <e.g., "App Store rejection categories: tracking without consent, private API use, IDFA without permission">
- <e.g., "Map projection math — assume WGS84 unless otherwise stated; check for off-by-one in tile coordinate transforms">

## Hot files / hot paths

The 3-5 files or modules that have caused most production bugs historically. The agent should attack changes near these areas with extra suspicion.

- `<path/to/file>` — <one-line description of why this is dangerous>
- `<path/to/file>` — <one-line description>

## Conventions the agent must respect when writing failing tests

- <e.g., "Use Swift Testing's @Test attribute, not XCTestCase. We are migrating away from XCTest.">
- <e.g., "All test files live under Tests/<Module>Tests/. Match the source module name.">
- <e.g., "Place property tests in tests/Tests/Isolated/Property/. Filename pattern: <ClassUnderTest>PropertyTest.php.">
- <e.g., "Use async/await in new test code. No completion handlers.">

## Things to ignore

- <e.g., "Legacy code in library/ predates current standards. Do not attack it as a bug; the maintainer knows.">
- <e.g., "Generated code under /generated/ should not be tested directly.">

## How to run the QA pipeline end-to-end here

```
<full command sequence specific to this project>
```

---

## Where to put the actual QA report

The sub-agent prints its report to chat. If the user asks for a written copy, save it at `<path/where/qa-reports/live/>`.
