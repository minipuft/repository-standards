// The negative half of the smoke fixture: names and shapes the preset must NOT report.

interface Logger {
  error(message: unknown): void;
}

export interface User {
  name: string;
}

export interface IPAddress {
  octets: number[];
}

export enum Status {
  Active,
}

export class UserService {}

export class AuthRequestHandler {}

export class SessionStore {}

export function describeUser(name: string, strength: number): string {
  return `${name}:${strength}`;
}

export function narrow(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
): number {
  return a + b + c + d + e + f;
}

export function rethrow(work: () => void, logger: Logger): void {
  try {
    work();
  } catch (error) {
    logger.error(error);
    throw error;
  }
}

async function save(): Promise<void> {}

export async function persisted(): Promise<void> {
  await save();
}
