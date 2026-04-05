export interface InjectionPattern {
  name: string;
  description: string;
  test(content: string): boolean;
}

export function getInjectionPatterns(): InjectionPattern[] {
  throw new Error("Not implemented");
}
