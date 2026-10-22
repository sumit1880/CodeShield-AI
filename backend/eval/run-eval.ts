import { EVAL_DATASET, TestCase } from './dataset';
import { AnalysisOrchestrator } from '../src/orchestrator/analysis.orchestrator';
import { buildContainer } from '../src/config/container';
import { logger } from '../src/utils/logger';

interface CweMetrics {
  tp: number;
  fp: number;
  fn: number;
}

export async function runEvaluation(orchestrator?: AnalysisOrchestrator) {
  const container = buildContainer();
  const runner = orchestrator || container.orchestrator;

  console.log(`\n========================================`);
  console.log(` Starting Security Eval (${EVAL_DATASET.length} cases)`);
  console.log(`========================================\n`);

  const metricsByCwe: Record<string, CweMetrics> = {};
  let totalCases = 0;
  let correctCases = 0;

  for (const testCase of EVAL_DATASET) {
    totalCases++;
    console.log(`[Eval] Running: ${testCase.id} - ${testCase.name}`);

    let detectedCwes: string[] = [];
    try {
      const result = await runner.analyzePastedCode({
        language: testCase.language,
        code: testCase.code
      });

      detectedCwes = result.vulnerabilities.map((v) => v.cwe.id);
    } catch (err) {
      console.error(`  Error running ${testCase.id}:`, err);
    }

    const expectedSet = new Set(testCase.expectedCwes);
    const detectedSet = new Set(detectedCwes);

    // Track metrics per expected CWE
    for (const exp of testCase.expectedCwes) {
      if (!metricsByCwe[exp]) metricsByCwe[exp] = { tp: 0, fp: 0, fn: 0 };
      if (detectedSet.has(exp)) {
        metricsByCwe[exp].tp++;
      } else {
        metricsByCwe[exp].fn++;
      }
    }

    // Track false positives (detected CWEs that were not expected)
    for (const det of detectedCwes) {
      if (!expectedSet.has(det)) {
        if (!metricsByCwe[det]) metricsByCwe[det] = { tp: 0, fp: 0, fn: 0 };
        metricsByCwe[det].fp++;
      }
    }

    const isMatch =
      testCase.expectedCwes.length === detectedCwes.length &&
      testCase.expectedCwes.every((c) => detectedSet.has(c));

    if (isMatch) correctCases++;

    console.log(`  Expected: [${testCase.expectedCwes.join(', ')}] | Detected: [${detectedCwes.join(', ')}]`);
  }

  console.log(`\n========================================`);
  console.log(`            EVALUATION REPORT           `);
  console.log(`========================================\n`);
  console.log(`Accuracy: ${correctCases}/${totalCases} (${((correctCases / totalCases) * 100).toFixed(1)}%)\n`);

  console.log(`| CWE      | TP | FP | FN | Precision | Recall | FPR   |`);
  console.log(`|----------|----|----|----|-----------|--------|-------|`);

  for (const [cwe, m] of Object.entries(metricsByCwe)) {
    const precision = m.tp + m.fp > 0 ? (m.tp / (m.tp + m.fp)).toFixed(2) : '1.00';
    const recall = m.tp + m.fn > 0 ? (m.tp / (m.tp + m.fn)).toFixed(2) : '1.00';
    const fpr = m.fp + m.tp > 0 ? (m.fp / (m.fp + m.tp)).toFixed(2) : '0.00';

    console.log(
      `| ${cwe.padEnd(8)} | ${String(m.tp).padStart(2)} | ${String(m.fp).padStart(2)} | ${String(m.fn).padStart(2)} | ${precision.padStart(9)} | ${recall.padStart(6)} | ${fpr.padStart(5)} |`
    );
  }
  console.log(`========================================\n`);
}

if (require.main === module) {
  runEvaluation()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
