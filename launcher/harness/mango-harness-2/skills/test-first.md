desc: New code or a bug fix: the failing test before the code

# Test first
If you never saw the test fail, you don't know that it tests the right thing.

For code that does something: a feature, a fix, a refactor. Not for documents, slides, how a page looks, or settings: check those by running or viewing them (skill `done`).

1. Red. `write` one small test for one behaviour, with a name that says it. Run it in `terminal`: it must FAIL, and for the reason you expect (the feature is missing, not a typo). If it passes at once, it tests something that is already there: fix the test.
2. Green. Write the simplest code that makes it pass. No options nobody asked for. Run all the tests: everything passes.
3. Tidy. With everything passing, remove what is repeated and improve the names. Add no behaviour.

Then the next behaviour, with its test.

A bug: reproduce it with a failing test, fix it, and keep the test.

Good tests: one behaviour each; the edges the code will meet (empty input, wrong input, the error); real code, a stand-in only when there is no other way.
