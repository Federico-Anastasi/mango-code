---
name: test-first
description: "Use before writing code for a new feature or a bug fix: write the failing test first, watch it fail, then make it pass."
---

# Test first

If you never saw the test fail, you don't know it tests the right thing.

Applies to code that does something: features, fixes, refactors. Not to documents, slides, how a page looks, throwaway scripts or configuration: there, check by running it or looking at it (skill `verify-before-done`).

## Red, green, refactor
1. **Red.** Write one small test for one behavior, with a name that says it, using real code (a mock only when there is no other way). Run it: it must FAIL, and for the reason you expect (the feature is missing, not a typo). If it passes at once it tests something that already exists: fix the test. If it errors, fix the error and run again until it fails properly.
2. **Green.** Write the simplest code that makes it pass. No extra options, no improvements you weren't asked for. Run all the tests: everything passes, output clean.
3. **Refactor.** With everything green, remove duplication and improve names. Add no behavior.

Then the next behavior, with the next test.

If you already wrote the code, write the test now and check that it fails when the code is removed or broken: a test that never failed proves nothing.

## Good tests
- One behavior per test. If its name needs "and", split it.
- Cover the edges the code will meet: empty input, wrong input, the error path.
- Test what the code does, not what the mock does. Don't add methods to production code only for tests. Before mocking something, understand what the real one does.

## A bug
Reproduce it with a failing test, fix it, and the test stays: it proves the fix and guards against it coming back.

## Before moving on
Every new function has a test; you saw each one fail first; you wrote the minimum to pass; all tests pass.
