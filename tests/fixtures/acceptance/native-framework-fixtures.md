The Jest `native-report.json` and Vitest `native-report.json` fixtures were
captured on 2026-10-05 with Jest 29.7.0 and Vitest 2.1.9 from the adjacent
`native-boundaries.test.*` sources. Jest used its JSON reporter; Vitest used
`onFinished(files, errors)` to serialize raw tasks without cyclic file/suite
references. Both processes exited 1 because the fixtures intentionally fail.

The capture replaced the temporary checkout path with `<probe>` and removed
stacks, display messages, timing fields and generated IDs. Status, structured
errors, hook states, native invocation/retry/repeat counts and task hierarchy
are preserved. The original outputs remain in the private probe directory.

Vitest fixture cleanup and onTestFinished failures retain both beforeEach and
afterEach as `pass`, and their errors have the same AssertionError fields as
the failing test body. These native fields cannot establish assertion red.
