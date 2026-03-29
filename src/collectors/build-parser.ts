interface BuildError {
  file: string;
  line: number;
  col: number;
  severity: string;
  code: string;
  message: string;
}

interface ParsedBuildError extends BuildError {
  parser: string;
  raw: string;
}

interface PatternDef {
  re: RegExp;
  extract: (m: RegExpMatchArray) => BuildError;
}

interface ParserDef {
  name: string;
  patterns: PatternDef[];
}

const PARSERS: ParserDef[] = [
  {
    name: 'typescript',
    patterns: [
      {
        re: /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/,
        extract: (m) => ({
          file: m[1], line: +m[2], col: +m[3],
          severity: m[4], code: m[5], message: m[6],
        }),
      },
      {
        re: /^(.+?):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):\s*(.+)$/,
        extract: (m) => ({
          file: m[1], line: +m[2], col: +m[3],
          severity: m[4], code: m[5], message: m[6],
        }),
      },
    ],
  },
  {
    name: 'eslint',
    patterns: [
      {
        re: /^\s*(.+?):(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/,
        extract: (m) => ({
          file: m[1], line: +m[2], col: +m[3],
          severity: m[4], message: m[5].trim(), code: m[6],
        }),
      },
    ],
  },
  {
    name: 'webpack',
    patterns: [
      {
        re: /^ERROR\s+in\s+(.+?)\s+(\d+):(\d+)$/,
        extract: (m) => ({
          file: m[1], line: +m[2], col: +m[3],
          severity: 'error', code: 'webpack', message: 'Build error',
        }),
      },
      {
        re: /^Module not found:\s*Error:\s*(.+)$/,
        extract: (m) => ({
          file: '', line: 0, col: 0,
          severity: 'error', code: 'module-not-found', message: m[1],
        }),
      },
    ],
  },
  {
    name: 'vite',
    patterns: [
      {
        re: /^\[vite\]\s*(.+?):\s*(.+?)(?:\s+file:\s*(.+?))?$/,
        extract: (m) => {
          const fileParts = (m[3] || '').match(/(.+?):(\d+):(\d+)/);
          return {
            file: fileParts ? fileParts[1] : '',
            line: fileParts ? +fileParts[2] : 0,
            col: fileParts ? +fileParts[3] : 0,
            severity: 'error', code: 'vite', message: m[2],
          };
        },
      },
    ],
  },
  {
    name: 'rust',
    patterns: [
      {
        re: /^(error|warning)\[(\w+)\]:\s*(.+)$/,
        extract: (m) => ({
          file: '', line: 0, col: 0,
          severity: m[1], code: m[2], message: m[3],
        }),
      },
      {
        re: /^\s*-->\s*(.+?):(\d+):(\d+)$/,
        extract: (m) => ({
          file: m[1], line: +m[2], col: +m[3],
          severity: 'error', code: 'rust', message: '',
        }),
      },
    ],
  },
  {
    name: 'go',
    patterns: [
      {
        re: /^(.+?\.go):(\d+):(\d+):\s*(.+)$/,
        extract: (m) => ({
          file: m[1], line: +m[2], col: +m[3],
          severity: 'error', code: 'go', message: m[4],
        }),
      },
    ],
  },
  {
    name: 'python',
    patterns: [
      {
        re: /^\s*File\s+"(.+?)",\s*line\s+(\d+)/,
        extract: (m) => ({
          file: m[1], line: +m[2], col: 0,
          severity: 'error', code: 'python', message: '',
        }),
      },
    ],
  },
  {
    name: 'generic',
    patterns: [
      {
        re: /^(.+?\.\w+):(\d+):(\d+):\s*(error|Error|ERROR)[:.]?\s*(.+)$/,
        extract: (m) => ({
          file: m[1], line: +m[2], col: +m[3],
          severity: 'error', code: 'generic', message: m[5],
        }),
      },
    ],
  },
];

/**
 * Parse build errors from raw text output.
 */
export function parseBuildErrors(text: string): ParsedBuildError[] {
  const errors: ParsedBuildError[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    for (const parser of PARSERS) {
      let matched = false;
      for (const { re, extract } of parser.patterns) {
        const m = line.match(re);
        if (m) {
          const err = extract(m);
          if (!err.message && i + 1 < lines.length) {
            err.message = lines[i + 1].trim();
          }
          errors.push({
            ...err,
            parser: parser.name,
            raw: line,
          });
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  const seen = new Set<string>();
  return errors.filter(e => {
    const key = `${e.file}:${e.line}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Merge Rust errors where the location is on a separate line from the message.
 */
function mergeBuildErrors(errors: ParsedBuildError[]): ParsedBuildError[] {
  const merged: ParsedBuildError[] = [];
  for (let i = 0; i < errors.length; i++) {
    const curr = errors[i];
    if (curr.parser === 'rust' && !curr.file && i + 1 < errors.length) {
      const next = errors[i + 1];
      if (next.parser === 'rust' && next.file && !next.message) {
        merged.push({ ...next, message: curr.message, code: curr.code, severity: curr.severity });
        i++;
        continue;
      }
    }
    merged.push(curr);
  }
  return merged;
}

export function parse(text: string): ParsedBuildError[] {
  return mergeBuildErrors(parseBuildErrors(text));
}
