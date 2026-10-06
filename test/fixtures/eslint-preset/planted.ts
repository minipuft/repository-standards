// Every finding the fleet preset should report on this file is marked by a `planted:` comment
// on the line above it, naming the rule. The smoke test reads these markers as its expectation,
// so a finding without a marker, or a marker without a finding, fails it.

interface Logger {
  error(message: unknown): void;
}

// planted: fleet/no-vague-suffix
export class SessionManager {}

// planted: @typescript-eslint/naming-convention
export interface IUser {
  name: string;
}

// planted: @typescript-eslint/naming-convention
export enum EStatus {
  Active,
}

// planted: @typescript-eslint/naming-convention
export function describeUser(strName: string): string {
  return strName;
}

// planted: sonarjs/cognitive-complexity
export function tangled(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > 0) {
      for (let index = 0; index < value; index++) {
        if (index % 2 === 0) {
          total += index;
        } else if (index % 3 === 0) {
          total -= index;
        } else {
          total += 1;
        }
      }
    } else if (value < -10) {
      total -= value;
    } else {
      total *= 2;
    }
  }
  if (total > 100 && total < 1000) {
    return total;
  }
  return 0;
}

export function deep(level: number): number {
  if (level > 0) {
    if (level > 1) {
      if (level > 2) {
        if (level > 3) {
          // planted: max-depth
          if (level > 4) {
            return level;
          }
        }
      }
    }
  }
  return 0;
}

// planted: max-params
export function wide(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
): number {
  return a + b + c + d + e + f + g;
}

export function swallowEmpty(work: () => void): void {
  try {
    work();
    // planted: no-empty
  } catch {}
}

export function swallowLogged(work: () => void, logger: Logger): void {
  try {
    work();
    // planted: fleet/no-log-and-swallow
  } catch (error) {
    logger.error(error);
  }
}

export function scattered(): void {
  // planted: fleet/no-scattered-logging
  console.log("step reached");
}

async function save(): Promise<void> {}

export function fireAndForget(): void {
  // planted: @typescript-eslint/no-floating-promises
  save();
}
