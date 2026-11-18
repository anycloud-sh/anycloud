import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  combineCaseReports,
  markdownMatrixReport,
} from '../test/helpers/api-responsiveness/report.mjs';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    profile: { type: 'string', default: 'all' },
    response: { type: 'string', default: 'all' },
    boundary: { type: 'string', default: 'all' },
    repetitions: { type: 'string', default: '6' },
  },
});
const entries = existsSync(values.input)
  ? readdirSync(values.input, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const name = entry.name.replace(/^api-responsiveness-/, '');
        try {
          return {
            name,
            report: JSON.parse(
              readFileSync(
                path.join(values.input, entry.name, 'results.json'),
                'utf8',
              ),
            ),
          };
        } catch (error) {
          return { name, failure: error.message };
        }
      })
  : [];
const matrix = combineCaseReports(entries, {
  profiles:
    values.profile === 'all'
      ? ['standard', 'backlog3', 'oversized']
      : [values.profile],
  responses: values.response === 'all' ? ['empty', 'mixed'] : [values.response],
  boundaries:
    values.boundary === 'all' ? ['immediate', 'yield'] : [values.boundary],
  repetitions: Number(values.repetitions),
});
const summary = markdownMatrixReport(matrix);
mkdirSync(values.output, { recursive: true });
writeFileSync(
  path.join(values.output, 'results.json'),
  JSON.stringify(matrix, null, 2) + '\n',
);
writeFileSync(path.join(values.output, 'summary.md'), summary);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
if (matrix.status !== 'complete') process.exitCode = 1;
