/**
 * Utility to convert an Analysis with findings into a valid SARIF v2.1.0 document.
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

export interface SarifExportOptions {
  analysisId: string;
  findings: Array<{
    id: string;
    title: string;
    cweId: string;
    cweName: string;
    severity: string;
    file: string;
    lineStart: number;
    lineEnd: number;
    explanation: string;
    recommendation: string;
  }>;
}

function mapSeverityToSarifLevel(severity: string): 'error' | 'warning' | 'note' {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
    case 'HIGH':
      return 'error';
    case 'MEDIUM':
      return 'warning';
    case 'LOW':
    case 'INFO':
    default:
      return 'note';
  }
}

export function generateSarifLog(options: SarifExportOptions) {
  const rulesMap = new Map<string, any>();

  const results = options.findings.map((f) => {
    const ruleId = f.cweId || 'SECURITY-VULN';

    if (!rulesMap.has(ruleId)) {
      rulesMap.set(ruleId, {
        id: ruleId,
        name: f.cweName || f.title,
        shortDescription: {
          text: f.title
        },
        fullDescription: {
          text: f.explanation
        },
        help: {
          text: f.recommendation
        }
      });
    }

    return {
      ruleId,
      level: mapSeverityToSarifLevel(f.severity),
      message: {
        text: `${f.title}: ${f.explanation}`
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: f.file.replace(/\\/g, '/')
            },
            region: {
              startLine: Math.max(1, f.lineStart),
              endLine: Math.max(1, f.lineEnd)
            }
          }
        }
      ]
    };
  });

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'CodeShield-AI',
            version: '1.0.0',
            rules: Array.from(rulesMap.values())
          }
        },
        results
      }
    ]
  };
}
