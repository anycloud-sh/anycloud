#!/bin/bash

# Unit tests for fail() and assert() helpers in common.sh
# Catches regressions like infinite loops in fail()'s stack trace logic.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASSED=0
FAILED=0

pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail_test() { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }

# caller builtin only works in script files, not bash -c strings.
# Helper: write a temp script, run it with timeout, capture stdout/stderr/rc.
run_script() {
    local body="$1"
    local tmp
    tmp=$(mktemp /tmp/test-fail-XXXXXX.sh)
    cat > "$tmp" << INNEREOF
#!/bin/bash
source "$SCRIPT_DIR/common.sh"
$body
INNEREOF
    chmod +x "$tmp"

    local stdout_file stderr_file
    stdout_file=$(mktemp)
    stderr_file=$(mktemp)

    set +e
    timeout 5 bash "$tmp" > "$stdout_file" 2> "$stderr_file"
    TEST_RC=$?
    set -e

    TEST_STDOUT=$(cat "$stdout_file")
    TEST_STDERR=$(cat "$stderr_file")
    rm -f "$tmp" "$stdout_file" "$stderr_file"
}

echo "======================================="
echo "Testing fail() and assert()"
echo "======================================="

# -----------------------------------------------------------------------
# Test 1: fail() terminates (no infinite loop) and returns non-zero
# -----------------------------------------------------------------------
echo ""
echo "1. fail() terminates and returns non-zero"

run_script '
wrapper() { fail "test error message"; }
wrapper
'

if [ $TEST_RC -eq 1 ]; then
    pass "fail() returned exit code 1"
else
    fail_test "fail() returned exit code $TEST_RC (expected 1; 124 = timeout/infinite loop)"
fi

# -----------------------------------------------------------------------
# Test 2: fail() prints error message to stdout
# -----------------------------------------------------------------------
echo ""
echo "2. fail() prints error message"

run_script 'fail "specific error text"'

if echo "$TEST_STDOUT" | grep -q "specific error text"; then
    pass "error message appears in output"
else
    fail_test "error message not found in output: $TEST_STDOUT"
fi

# -----------------------------------------------------------------------
# Test 3: fail() prints stack trace to stderr
# -----------------------------------------------------------------------
echo ""
echo "3. fail() prints stack trace to stderr"

run_script '
inner() { fail "trace test"; }
outer() { inner; }
outer
'

if echo "$TEST_STDERR" | grep -q "inner\|outer"; then
    pass "stack trace contains function names"
else
    fail_test "stack trace missing function names. stderr: $TEST_STDERR"
fi

# -----------------------------------------------------------------------
# Test 4: assert with passing command continues execution
# -----------------------------------------------------------------------
echo ""
echo "4. assert() with passing command continues"

run_script '
assert "should not fail" true
echo "CONTINUED"
'

if echo "$TEST_STDOUT" | grep -q "CONTINUED"; then
    pass "execution continued after passing assert"
else
    fail_test "execution did not continue after passing assert"
fi

# -----------------------------------------------------------------------
# Test 5: assert with failing command exits (with set -e)
# -----------------------------------------------------------------------
echo ""
echo "5. assert() with failing command exits"

run_script '
set -e
assert "expected failure" false
echo "SHOULD_NOT_REACH"
'

if [ $TEST_RC -ne 0 ]; then
    pass "script exited with non-zero ($TEST_RC)"
else
    fail_test "script exited with 0 (should have failed)"
fi

if echo "$TEST_STDOUT" | grep -q "SHOULD_NOT_REACH"; then
    fail_test "execution continued past failed assert"
else
    pass "execution stopped at failed assert"
fi

# -----------------------------------------------------------------------
# Test 6: assert preserves set -e for subsequent commands
# -----------------------------------------------------------------------
echo ""
echo "6. assert() preserves set -e after passing"

run_script '
set -e
assert "should pass" true
false
echo "SHOULD_NOT_REACH"
'

if echo "$TEST_STDOUT" | grep -q "SHOULD_NOT_REACH"; then
    fail_test "set -e was disabled after assert (bare false did not exit)"
else
    pass "set -e still active after assert (bare false exited script)"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "======================================="
echo "Results: $PASSED passed, $FAILED failed"
echo "======================================="

if [ $FAILED -gt 0 ]; then
    exit 1
fi
