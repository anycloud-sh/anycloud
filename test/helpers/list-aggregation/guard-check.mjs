import { spawn } from 'node:child_process';
import { installGuard } from './guard.mjs';

class Provider {
  operation() {
    throw new Error('Provider operation must never execute');
  }
}
const guard = installGuard();
guard.rejectProviderOperations([Provider]);
const caught = [];
for (const action of [
  () => new Provider().operation(),
  () => fetch('https://list-aggregation.invalid'),
  () => spawn('list-aggregation-must-not-execute'),
]) {
  try {
    await action();
  } catch (error) {
    caught.push(error.message);
  }
}
let fatal;
try {
  guard.assertClean();
} catch (error) {
  fatal = error.message;
}
console.log(JSON.stringify({ caught, violations: guard.violations, fatal }));
